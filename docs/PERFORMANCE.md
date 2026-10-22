# Performance

How blinq's capacity and speed are measured, the measured results, and what to provision. Stage 10 (`e2e`) ran the
measurements in §5; README and [`DEPLOYMENT.md`](DEPLOYMENT.md) take their sizing from §6.

**Status (2026-10-03): measured on one machine.** Every number in §5 comes from a single Mac Studio (Apple M5 Max) that
ran the SFU, the app, the load generators and the browsers at the same time, with Docker Desktop in between (§4). The
numbers bound the cost of a room well; they are not a server benchmark. The same runs on a dedicated Linux VM with
separate load hosts (§2) are a `[user]` item before the numbers are called final. `(decision)` marks a choice this
document makes where the plan left it open; "planning value" marks a value that is derived (from a measurement or a
configured bitrate), not measured itself.

## 1. Metrics

| Metric | Measured on | How | Why it matters |
|---|---|---|---|
| SFU CPU (avg and p95 of 5 s samples) | SFU host | Linux: `pidstat -u -p <livekit-server pid> 5` (package `sysstat`); Docker Desktop: `docker stats` of the LiveKit container | forwarding cost limits concurrent meetings |
| SFU RAM (RSS) | SFU host | `pidstat -r -p <pid> 5`; `docker stats` | sizing |
| SFU egress / ingress (Mbit/s) | SFU host NIC | Linux: `sar -n DEV 5` (LiveKit uses host networking, so the NIC shows its traffic); Docker Desktop: the container's `/sys/class/net/eth0/statistics/{rx,tx}_bytes` | egress is usually the first limit |
| App and Postgres CPU/RAM | same host | `pidstat`, `docker stats` | join API, SSE, recording ingest and transcoding |
| Client CPU | real client | OS monitor (renderer + GPU processes), Chrome task manager | E2EE plus decoding up to 24 tiles is client-heavy |
| Join time p50/p95 | real client, bots | `blinq:join:click` → `blinq:join:first-remote-frame` | UX; gates in §7 |
| Time to first remote frame | real client, bots | `blinq:join:connected` → `blinq:join:first-remote-frame` | subscription and layer-selection cost |
| Received quality | real client, bots | WebRTC `inbound-rtp`: `frameWidth`, decoded frames per second, `freezeCount`, `packetsLost`; `qualityLimitationReason` for the local camera | tells whether quality drops come from CPU or bandwidth |
| Recording cost | recorder and server | recorder main-thread load, upload Mbit/s, `processing` → `ready` time, peak `/work` tmpfs use, stored bytes per hour | disk and CPU sizing |

The `blinq:join:*` performance marks are recorded in every build. Test builds also copy them into
`window.__blinqTest.metrics`. Keeping the marks in production builds is what makes field measurement possible
(decision); the browser swarm (§3.2) reads them from production builds too. In DevTools on a production deployment:

```js
const t = (n) => performance.getEntriesByName(n)[0].startTime
t('blinq:join:first-remote-frame') - t('blinq:join:click')
```

## 2. Rules for every measurement

- Measure a production deployment (Stage 09a compose) on a dedicated VM, never the dev stack or a laptop.
- Load generators run on hosts other than the SFU host. Each generator stays below 70% CPU; above that, the result
  measures the bots.
- Every run: 2 min warm-up, then 5 min steady state. Report avg and p95 of 5 s samples. Repeat each scenario 3 times
  and report the median run (decision).
- Record the environment (§4) with every result table. Results without an environment are discarded.

**The Stage 10 on-box runs break these rules on purpose** (decision of the maintainer: one machine now, the VM run
later as a `[user]` item). What differs, and why the numbers are still useful:
- SFU, generators, app and browsers share one host. `lk load-test` generators ran in containers next to the SFU; the
  browser bots ran on the host itself. The SFU columns come from the LiveKit container alone, so they stay meaningful
  while the generators stay well below the host's limits; the browser runs at 24 bots did not (§5.2).
- Shorter windows: 45 s warm-up and 120 s steady state for single rooms, 30 s and 60 s per ladder step, 60–120 s for
  the swarm; two runs of the full-room scenario instead of three.
- No real network: traffic stays inside the Docker VM (`lk`) or crosses Docker Desktop's port forwarding (browsers),
  so there is no physical NIC, no real loss or jitter, and Linux `pidstat`/`sar` are replaced by `docker stats` and the
  container's interface counters.

## 3. Methodology

### 3.1 SFU capacity: `lk load-test`

The LiveKit CLI starts synthetic participants that publish unencrypted pre-encoded test media. For SFU cost that is
representative: under E2EE the SFU forwards encrypted frames exactly the same way; the frame trailer adds only a few
bytes. The pinned CLI is the image `livekit/livekit-cli:v2.18.8` (`lk version 2.18.8`).

- The server runs with `room.auto_create: false`, so create each room first, with enough seats for the testers
  (`lk room create` cannot set `maxParticipants`; use the server SDK from a repo checkout, where `livekit-server-sdk`
  resolves).
- Publishers (`--video-publishers`, `--audio-publishers`) do not subscribe; `--subscribers N` adds receive-only testers.
  A 25-person meeting is therefore modeled as 25 publishers plus 25 subscribers (each subscriber receives 25 cameras
  and 25 microphones, about what 25 real people receive). Publishers send three simulcast layers
  (`--video-resolution high`), and `--layout 5x5` makes subscribers request small layers, like blinq's grid.
- `lk load-test` has no screen-share option. A 1080p15 share is modeled by one more participant that publishes a VP8
  file with `lk room join --publish screen.ivf --fps 15` (2.5 Mbit/s, the `h1080fps15` preset's bitrate, one keyframe
  every 2 s). The file must cover the whole run: `lk room join` stops publishing at its end.
- blinq's webhook handler ignores rooms that are not in its database, so the testers are not removed.
- Ladder: one full room, then rooms of 10 (10 publishers + 10 subscribers) added step by step until SFU CPU p95 exceeds
  80% of all cores, egress exceeds 80% of the NIC or plan limit, subscriber packet loss exceeds 1%, or the generators
  run out of room (decision). The last passing step is the capacity.

Against a server (SSH tunnel to its loopback-only API):

```sh
ssh -N -L 7880:127.0.0.1:7880 <user>@<server> &
node --input-type=module -e "
import { RoomServiceClient } from 'livekit-server-sdk'
const rs = new RoomServiceClient('http://127.0.0.1:7880', process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET)
await rs.createRoom({ name: 'load-1', maxParticipants: 60, emptyTimeout: 600 })"

docker run --rm livekit/livekit-cli:v2.18.8 load-test --url wss://<DOMAIN> \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" --room load-1 \
  --video-publishers 25 --audio-publishers 25 --subscribers 25 --layout 5x5 --simulate-speakers --duration 7m

# 1080p15 screen share into the same room
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=15 -t 600 -c:v libvpx -b:v 2500k -minrate 2500k -maxrate 2500k \
  -bufsize 2500k -deadline realtime -cpu-used 8 -g 30 screen.ivf
docker run --rm -v "$PWD/screen.ivf:/data/screen.ivf:ro" livekit/livekit-cli:v2.18.8 room join --url wss://<DOMAIN> \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" --identity screen-share \
  --publish /data/screen.ivf --fps 15 load-1
```

`lk load-test` prints a summary when its duration ends or on `SIGINT` (`docker kill --signal=SIGINT`): per subscriber
the tracks received, bitrate and packet loss.

**On-box setup (Stage 10).** A private LiveKit v1.13.7 container with the production LiveKit configuration from
`docker-compose.yml` (UDP port range 50000–60000, the same room settings; `limit.*` raised so it never interfered, and
`prometheus.port` set for the packet counters) on its own Docker bridge network, with every `lk` container on that
network. Nothing was published to the host, nothing touched the shared dev stack, and everything was removed
afterwards. The SFU columns are the LiveKit container's `docker stats` CPU and memory and its `eth0` counters.

### 3.2 Browser bot swarm (real blinq clients, E2EE on)

This shows what `lk load-test` cannot: real browsers with E2EE, blinq's subscription and layer selection, join time
under load, and the grid. `tests/load/swarm.ts` is a Playwright library script (not part of `pnpm test:e2e`):

```sh
SWARM_LINK='<invite link>' pnpm exec tsx tests/load/swarm.ts --bots 8 --duration 300 --out swarm.json
```

- The meeting: a room with the waiting room off, guests allowed and 25 seats, and an invite link with enough uses (or
  unlimited) for every bot and the observer. The link carries the room key, so it goes in `SWARM_LINK` only; the script
  never prints it.
- An observer (1920×1080) joins first, so every bot finds a publisher already there. Then the bots join one by one
  through the real flow (`/m/<slug>#k=…&t=…`, guest name, Join) in headless Chromium with fake media.
- Per bot: page load → pre-join, Join click → connected and → first remote frame (the `blinq:join:*` marks), and over
  the steady state the inbound packet loss, decoded frames per second per stream, freezes per minute, received Mbit/s
  and why its own camera encoder was limited. The script reads WebRTC statistics through an init script that keeps the
  app's `RTCPeerConnection`s, so it needs no test hooks and works against production.
- The observer reports the grid (`data-cols` × `data-rows`), the tile count and, per remote video, the presented frames
  per second (`requestVideoFrameCallback`) and the resolution, three times during the steady state.
- The bot host samples its own CPU; `--sfu-container <name>` also samples a local LiveKit container (single-machine
  runs). The summary is one JSON document on stdout (and in `--out`); the exit code is 1 when a bot could not join.
- Bots publish a generated test pattern (`--video-size`, default 640x360 at 15 fps, made with ffmpeg) so the bot host
  measures blinq rather than video encoding. blinq publishes it as two simulcast layers (180p and the 360p source).
- **Pacing.** `join-ip` allows 30 requests per minute per IP (/64), and each join makes 2 (`info`, then the join). One
  source IP adds at most 15 bots per minute; the default `--join-interval` is 4.5 s.
- **Several load hosts.** Run the script on each host with the same `SWARM_LINK`, its own `--name` prefix and its share
  of `--bots`, and `--no-observer` on all but one (best: the observer on a machine without bots, or a real client
  instead). Start the hosts a few seconds apart; each host with its own public IP has its own `join-ip` budget. Keep
  every host below 70% CPU (`host.cpuPercent` in the summary). On this hardware a bot costs about half a fast core
  (§5.2), so plan about 1 vCPU and 1 GB RAM per bot (planning value).
- **One machine.** `tests/load/onbox.spec.ts` creates the room and the invite on the E2E stack (test build, e2e Caddy,
  dev LiveKit) and runs the swarm: `SWARM_BOTS=12 SWARM_DURATION=120 E2E_HTTP_PORT=8090 sh scripts/e2e.sh --config
  tests/load/playwright.config.ts` (variables: `SWARM_BOTS`, `SWARM_DURATION`, `SWARM_JOIN_INTERVAL`,
  `SWARM_BOTS_PER_BROWSER`, `SWARM_VIDEO_SIZE`, `SWARM_SFU_CONTAINER`, `SWARM_OUT`).

For the full picture of one meeting (scenarios S1–S5 in §5.2), add a real client (desktop Chrome on a physical
machine, real 720p camera, 1920×1080 window) and a recorder (the room's host, signed in, recording in server mode).

### 3.3 Recording

- `tests/e2e/recording/long.spec.ts` (`@nightly`, Chromium): one server recording for `E2E_LONG_RECORDING_MINUTES`
  (nightly 30, local default 2) with 10 s samples of the recorder's state (`chunksProduced`, `chunksAcked`,
  `backlogBytes`, `retries`) and JS heap. Steady state: the backlog stays under 16 MiB and at most 3 chunks behind.
  Upload backlog: every chunk upload is held for 40 s, the backlog grows, nothing fails, and it drains within 60 s.
  Memory: the heap after a forced GC at the end is within 32 MiB of the heap after the warm-up. Partial finalize: the
  recorder's tab closes without stopping; `recordings:finalize-stale` (every 2 min, 30 s after the recorder left)
  finalizes it as `partial`, it reaches `ready`, the REC indicator is gone for the others, and the file covers what
  was uploaded. It prints chunk cadence, upload Mbit/s, heap, main-thread load, finalize time and stored size per hour.
- Manual, per format (MP4 and WebM) in scenario S4 of §5.2, plus one local-only recording: 60 minutes each.
- Stored size per hour = stored bytes ÷ duration. BLQ1 adds 16 bytes per 1 MiB segment, which is negligible.
- Transcode cost = the time from `processing` to `ready`, the server CPU while ffmpeg runs (`FFMPEG_THREADS`, default
  2), and the peak use of the `/work` tmpfs.

### 3.4 Network degradation

`tests/e2e/network/degradation.spec.ts` (`@nightly`, Chromium): a host publishes on the real `/m/<slug>` flow; a guest
receiver with a 1920×1080 window (so it receives the camera's top layer) gets 5% packet loss, 150 ms latency and
500 kbit/s each way for 60 s, then the network is restored.

- **CDP emulation and WebRTC.** `Network.emulateNetworkConditions` and `Network.emulateNetworkConditionsByRule` accept
  `packetLoss`, `packetQueueLength` and `packetReordering`, and Chromium applies them, with latency and throughput, to
  peer connections too, but only to a socket created while a rule is active. Conditions set during a call never reach
  its existing connections, while a socket created under a rule follows every later change of that rule (verified on
  Chromium 153 with a loopback `RTCPeerConnection`: 3 Mbit/s before and after a late rule; 0.3 Mbit/s with 5% loss when
  the rule came first). So the receiver starts under a neutral rule (100 Mbit/s, no delay or loss) before it connects;
  the spec then switches that global rule (empty `urlPattern`) to the impaired values and back.
- `packetQueueLength: 100` (about 1.6 s at 500 kbit/s) models a real bottleneck queue; 0 would buffer without limit
  (decision).
- Pass: the received layer or bitrate drops within 20 s; no terminal phase and no end screen during the 60 s (a
  reconnect is reported, not failed); the top layer is back and decoding within 30 s of the restore; and the SFU adapts
  instead of letting the picture freeze (median ≥ 3 decoded frames per second over the last 30 s of the impairment).
  The last check is pending a finding (§5.5).
- **Firefox and SFU-side impairment: `tc netem`** on a Linux runner, never on the shared dev stack while others test
  (root needed; details in [`TESTING.md` §6.9](TESTING.md#69-network-degradation-nightly-stage-10)):

  ```sh
  pid=$(docker inspect -f '{{.State.Pid}}' blinq-dev-livekit-1)
  sudo nsenter -t "$pid" -n tc qdisc add dev eth0 root netem rate 500kbit delay 150ms loss 5% limit 100
  sudo nsenter -t "$pid" -n tc qdisc del dev eth0 root
  ```

  This shapes the SFU's side, so it impairs every participant of that LiveKit at once; use one call per run.

### 3.5 Performance budget

`tests/e2e/perf/budget.spec.ts` (Chromium) loads each page in a new browser context (empty cache) through the e2e
Caddy, which compresses like production, waits for network idle and sums Resource Timing `encodedBodySize` over the
page's `.js` resources. Speculative prefetches (`<link rel="prefetch">`, requests with `Sec-Purpose: prefetch`) are
not needed to render and are not counted (decision). The call page is measured up to the pre-join screen of a guest
with an invite link; the E2EE worker (loaded there because the room is created when pre-join mounts) is reported but
not counted, and MediaPipe and RNNoise do not load at all in a fresh browser (blur off, browser noise suppression).
KB means 1024 bytes (decision). Each run attaches the per-file list (`js-budget.json`); `pnpm exec nuxi analyze` shows
what grew.

## 4. Environment

Template, to copy above every result set:

| Field | Value |
|---|---|
| Date, tester | |
| blinq version / commit | |
| LiveKit server / `lk` CLI version | |
| Admin settings | `media.maxCameraResolution`, `media.maxScreenShareResolution`, `media.maxScreenShareFps`, `recording.maxResolution` |
| SFU host | provider, instance type, vCPU model (dedicated or shared), RAM, NIC / bandwidth plan, region, OS and kernel, Docker version |
| Bot hosts | count, instance type, vCPU, RAM, region, Chromium version, bots per host |
| Real client | device, CPU, RAM, OS, browser and version, network (wired or Wi-Fi), RTT to the server |
| Recorder | same fields as the real client |
| Network path | RTT bot hosts ↔ SFU (`ping`), throughput (`iperf3`) |

Stage 10 on-box environment (every table in §5):

| Field | Value |
|---|---|
| Date, tester | 2026-10-03, `e2e-perf` agent (automated runs) |
| blinq version / commit | `c367c0b` (W3 base) with the Stage 10 test files; app code unchanged |
| LiveKit server / `lk` CLI version | v1.13.7 / v2.18.8 (`livekit/livekit-cli:v2.18.8`); livekit-client 2.22.3 (patched) |
| Admin settings | defaults: camera 720p, screen share 1080p at 15 fps, recording 1080p |
| SFU host | Mac Studio, Apple M5 Max (18 cores: 6 + 12), 128 GB RAM, macOS 27.0.1; Docker Desktop 4.93.0 (Engine 29.8.1), Linux VM with 18 CPUs and 7.7 GiB RAM. `lk` runs: a private LiveKit container with the production LiveKit configuration (§3.1). Swarm runs: the dev LiveKit (`docker-compose.dev.yml`: one UDP port published on the LAN IP), the e2e Caddy and the production-mode test build (`pnpm build:test`) |
| Bot hosts | the same machine. `lk`: containers in the same Docker VM. Swarm: headless Chromium 153.0.8010.12 (Playwright 1.63), 4 contexts per browser process, 640x360 at 15 fps test pattern |
| Real client | none; the swarm's observer (headless, 1920×1080) stands in |
| Recorder | headless Chromium on the same machine (long recording spec) |
| Network path | none: Docker bridge (`lk`) or Docker Desktop port forwarding on one host (swarm) |

## 5. Results (Stage 10, on-box)

### 5.1 SFU capacity (`lk load-test`, §3.1)

One full room is 25 video and audio publishers plus 25 subscribers (`--layout 5x5`). SFU CPU is in percent of one core
(`docker stats`); the generators' CPU is listed to show how much of the machine they took.

| Scenario | SFU CPU avg / p95 | SFU RAM | Egress Mbit/s | Ingress Mbit/s | Egress packets/s | Subscriber loss | Generators CPU | Pass |
|---|---|---|---|---|---|---|---|---|
| 1 room, run 1 | 65% / 71% | 627 MiB | 140 | 7.2 | 46,300 | 0% (1250/1250 tracks) | 118% | yes |
| 1 room, run 2 | 68% / 83% | 614 MiB | 140 | 7.2 | 46,300 | 0% (1250/1250 tracks) | 122% | yes |
| 1 room + 1080p15 screen share | 74% / 87% | 660 MiB | 196 | 9.9 | 50,800 | 0% | 125% | yes |
| Ladder 0: 1 × 25 | 72% / 74% | 637 MiB | 140 | 7.2 | 46,400 | 0% | 121% | yes |
| Ladder 1: 1 × 25 + 3 × 10 | 93% / 95% | 1076 MiB | 209 | 15.0 | 68,700 | 0% | 186% | yes |
| Ladder 2: 1 × 25 + 6 × 10 | 143% / 146% | 1387 MiB | 277 | 22.8 | 91,200 | 0% | 304% | yes |
| Ladder 3: 1 × 25 + 9 × 10 | 202% / 236% | 1797 MiB | 345 | 30.5 | 113,600 | 0.001% | 451% | yes (last step) |

- The ladder stopped at step 3 (230 testers in 10 rooms) because the generators had used 5.6 of the Docker VM's
  7.7 GiB; the next step would not have fit (an earlier attempt with larger steps ran the VM out of memory and was
  discarded). The SFU itself was far from any limit: 2.0 cores of 18, 345 Mbit/s, no loss. On this machine the
  generators, not the SFU, set the ceiling.
- The 1080p15 share adds about 56 Mbit/s of egress (at most 2.5 Mbit/s per receiver) and about 6% of a core.
- Ingress is small because dynacast pauses layers nobody watches: in a 5×5 grid every subscriber wants the lowest layer.

### 5.2 Browser swarm (E2EE, §3.2)

| Scenario | SFU CPU avg / max | SFU RAM | Egress / ingress Mbit/s | Bot host CPU | Received res / fps | Join p50 / p95 | First remote frame p50 / p95 | Freezes per min (p50 / max) |
|---|---|---|---|---|---|---|---|---|
| 5 people (observer + 4 bots), 3x2 grid | 20% / 23% | 232 MiB | 37 / 10 | 27% | 640x360 / 15 decoded, 12–15 presented | 298 / 314 ms | 200 / 216 ms | 0 / 0 |
| 13 people (observer + 12 bots), 4x4 grid | 57% / 60% | 327 MiB | 57 / 25 | 38% | 640x360 / 15 decoded, 13.7 presented | 280 / 316 ms | 181 / 204 ms | 0 / 0 |
| S1: 25 people (observer + 24 bots), 5x5 grid | 193% / 201% | 971–1092 MiB | 118 / 7.3 | **87% (overloaded)** | 320x180 / 7.9 decoded per stream (p50 of bots), observer ~7 presented, 6–7 of 24 tiles under 5 fps | 298 / 712 ms | 200 / 528 ms | 4 / 29 |
| S2: S1 + screen share 1080p15 | `[user]` | | | | | | | |
| S3: speaker view | `[user]` | | | | | | | |
| S4: S1 + server recording | `[user]` | | | | | | | |
| S5: burst join, 23 bots within 60 s from ≥ 2 IPs | `[user]` | | | | | | | |

- Join is the Join click → first decoded remote frame; first remote frame is connected → first frame. Page load to the
  pre-join screen took 857–868 ms (p50) in every run. No bot failed to join; packet loss stayed under 0.5%.
- The observer saw the expected grid every time (3x2, 4x4, then 5x5 with 25 tiles and 24 remote videos).
- **24 bots are more than this machine sustains.** At 87% host CPU the bots could not decode 24 streams each in time
  (7.9 of 15 fps), which also explains the freezes and the longer joins of the last bots (up to 727 ms). The 25-person
  SFU columns stay valid (the SFU container had its own cores to spare); the client columns of S1 measure the bots, not
  blinq. Up to 12 bots the host stayed at 38% and every stream decoded at the full 15 fps. One bot costs about half an
  M5 Max core here.
- SFU cost per forwarded stream is about 2.5 times the `lk load-test` figure: about 650 tracks (in + out) per core with
  browsers (1250 tracks at 1.93 cores) against about 1600 with `lk` testers (3280 tracks at 2.0 cores, ladder step 3).
  Browsers exercise congestion control, retransmission and keyframe requests that the testers do not, so §6 sizes from
  the browser figure.

### 5.3 Recording (§3.3)

| Mode | Upload format | Duration | Recorder main thread | Upload Mbit/s | Finalize → `ready` | Peak tmpfs | Stored GB per hour |
|---|---|---|---|---|---|---|---|
| server, `recording/long` local run | MP4 (H.264/AAC, Chromium's default), 6.7 s per chunk | 2.7 min, then the tab closed (partial) | 11% busy, JS heap +0.2 MiB after GC | 1.06 (synthetic test pattern) | 41 s after the tab closed (cron, grace and transcode) | not measured | 0.17 (synthetic test pattern) |
| server | MP4 | 30 min (nightly) | nightly.yml | | | | |
| server | WebM | 60 min | `[user]` | | | | |
| local-only | browser default | 60 min | `[user]` | — | — | — | (on the device) |

- Upload backlog: 40 s of held uploads built a 6-chunk, 5.2 MiB backlog that drained 1 s after the release, with no
  error and no retry; the steady-state backlog was 0.
- The partial file covered 157 s of the 161 s recorded (the last chunk was still on the recorder when its tab closed).
- Fake cameras compress far better than real ones, so upload rate and stored size here are lower bounds. The recorder
  targets 2.5 Mbit/s video at 1080p plus 128 kbit/s audio, so it uploads at most about 1.2 GB per hour. The server
  re-encodes with x264 CRF 23 (no bitrate cap), so the stored size depends on the content: plan with 1–1.8 GB per hour
  at 1080p (planning value) until an hour of real cameras is measured (`[user]`, S4).

### 5.4 Client CPU by device (S1: 24 remote tiles, E2EE) `[user]`

| Device / OS | Browser | CPU % | Received fps | Notes |
|---|---|---|---|---|
| Mid-range laptop (4 cores), Windows or Linux | Chrome | TBD | TBD | TBD |
| Same | Firefox | TBD | TBD | TBD |
| MacBook (Apple silicon) | Safari | TBD | TBD | TBD |
| Mid-range Android phone | Chrome | TBD | TBD | TBD |
| iPhone | Safari | TBD | TBD | TBD |

A headless bot on a fast desktop core needs about half a core for a 25-person grid (§5.2), so expect a mid-range
4-core laptop to be busy; this table needs real devices.

### 5.5 Network degradation (§3.4)

| Run | Before | Impaired (60 s) | After the restore | Disconnects |
|---|---|---|---|---|
| blinq, dev LiveKit (default congestion control) | 1280 wide, 720 kbit/s, 20 fps | 425 kbit/s (link-limited) within 3 s; still the 1280 layer; median 0 fps (frozen) | top layer decoding again after 3 s | none, no reconnect |
| plain livekit-client, receiver does not publish | 1280, 750 kbit/s | 640 after 8 s, 320 after 26 s; 5–10 fps | 640 after 15 s, 1280 not within 30 s | none |
| plain livekit-client, receiver publishes its camera (like blinq) | 1280, 740 kbit/s | still 1280, about 460 kbit/s, 0 fps after 12 s | instant | none |
| same, LiveKit with `congestion_control.use_send_side_bwe: true` | 1280, 780 kbit/s | still 1280; about 220 kbit/s and 5 fps after 25 s (frame rate reduced) | 1280 at 20 fps after 10 s | none |

- The connection survives: no `Disconnected`, no end screen, no reconnect, in any run.
- **Pending finding:** with LiveKit's default congestion control (receiver reports), a subscriber that also publishes
  its camera over the bad link is never moved to a lower layer; the 720p layer keeps overrunning the link and the
  picture freezes until the network recovers. The same receiver without its own camera is moved down to 180p within
  26 s. Send-side bandwidth estimation kept the video moving at about 5 fps in a single manual run (plain
  livekit-client against a private LiveKit, not blinq). `degradation.spec.ts` asserts everything else and skips on the
  frozen picture while the finding is open.

## 6. Sizing

Derived from §5 (on-box). One full meeting means 25 people with cameras and microphones on, everyone in the 5×5 grid.
README and [`DEPLOYMENT.md` §2](DEPLOYMENT.md#2-server-requirements) take their sizing from this section.

| Per full 25-person meeting | Measured on the M5 Max | Planning value for a Linux VM |
|---|---|---|
| SFU CPU | 1.9 cores with browsers (0.65–0.7 with `lk` testers) | about 4 vCPU (a cloud vCPU is one SMT thread of a slower core: assume half an M5 Max performance core) |
| SFU RAM | about 1 GB with browsers (0.6 GB with 50 `lk` testers) | the same |
| Egress | 118 Mbit/s (browsers, 180p layers) – 140 Mbit/s (`lk`); + 56 Mbit/s with a 1080p15 screen share | the same, plus retransmissions on real networks: plan 200 Mbit/s |
| Ingress | 7–10 Mbit/s in the full grid; up to about 25 Mbit/s in smaller meetings where tiles are large | the same |
| Traffic | 53–88 GB of egress per meeting hour | the same |
| Tracks (in + out) | about 1250 | the same |

- Per core: about 13 browser participants in full meetings on an M5 Max core, about 650 tracks (in + out).
- Per vCPU (planning value): about 6 participants in full meetings, about 300–400 tracks (in + out).
- Smaller meetings cost less per person: 13 people took 0.57 cores and 57 Mbit/s of egress.
- What a Linux VM changes: host networking replaces Docker Desktop's port forwarding (less overhead per packet), the
  generators move to other machines (no contention), and real networks add loss and jitter (more retransmissions and
  keyframes). vCPUs are slower than these cores. Treat the VM column as a planning value until the `[user]` run
  replaces it.

Recommended deployments (planning values derived from the measurements above; they replace the pre-measurement
figures):

| Deployment | vCPU | RAM | Bandwidth (symmetric) | Load |
|---|---|---|---|---|
| Small team | 2 | 4 GB | 100 Mbit/s | about 10 people in calls at once (13 people measured: 0.6 fast cores, 57 Mbit/s) |
| One full 25-person meeting | 4–6 | 8 GB | 250 Mbit/s | one 25-person meeting with a screen share, plus a few small calls |
| Each further full meeting | + 4 | + 1–2 GB | + 200 Mbit/s | |
| Recording | + `FFMPEG_THREADS` (default 2) while a job runs | + `RECORDING_WORK_TMPFS_SIZE` (default 4g) while a job runs | upload ≤ 1.2 GB per recording hour; disk: plan 1–1.8 GB per hour at 1080p (§5.3) | |

Match the LiveKit limits to the deployment (§8): `LIVEKIT_MAX_TRACKS` about 400 per vCPU, `LIVEKIT_MAX_BYTES_PER_SEC`
the bandwidth plan in bytes per second.

## 7. Performance budgets

| Budget | Metric | Value | Measured on `c5835ea` (Chromium, zstd through the e2e Caddy, each file counted once) | Enforced by |
|---|---|---|---|---|
| Initial JS | compressed JS to render `/` and `/login` with a cold cache, prefetches not counted | ≤ 200 KB | `/` 153.6 KiB (45 files), `/login` 193.8 KiB (48 files): within budget | `perf/budget.spec.ts` |
| Call route | compressed JS of `/m/<slug>` up to a guest's pre-join screen, without the E2EE worker, MediaPipe and RNNoise | ≤ 450 KB | 438.9 KiB (84 files; the largest, with livekit-client, is 139.7 KiB): within budget. The spec's own sum is 477.9 KiB, see below | `perf/budget.spec.ts` (skips it, see below) |
| E2EE worker | loaded at pre-join | not budgeted | 30.8 KiB | reported by `perf/budget.spec.ts` |
| Effects assets | loaded only when a user enables them | not budgeted (decision: self-hosted vendor files) | blur: MediaPipe loader 54 KiB + wasm 2.6 MiB (compressed) + model 244 KiB (served as `application/octet-stream`, so uncompressed); RNNoise: worklet 12 KiB + wasm 115 KiB | build output, gzip/zstd computed |
| Join time | click → first remote frame | PR gate < 6 s (single run); nightly p95 < 3 s; target p50 < 1.5 s | swarm: p50 280–298 ms, p95 316 ms up to 13 people (712 ms with the overloaded 25-bot host) | e2e.yml, nightly.yml (see [`TESTING.md` §6.7](TESTING.md#67-timing-policy)) |
| Client CPU | real client in S1 | TBD | `[user]` (§5.4) | manual |

- The budget values are the Stage 10 decisions (200 KB and 450 KB) rather than baseline plus 10%. Raising a budget
  needs a line in the change log below explaining why.
- F-043 (over both budgets on `c367c0b`: `/` 237.0 KiB, `/login` 252.2 KiB, `/m/<slug>` 497.5 KiB) is fixed. The
  landing and sign-in pages load their menus on use, the landing page no longer loads the form library, and links
  prefetch on hover or focus only (fix-ui). The meeting page loads the call code only when the meeting needs it
  (fix-ui), and the pre-join screen no longer loads the in-call UI (fix-call `0f48008`). The fix agents measured gzip
  over the build output: `/` 144 KiB, `/login` 182 KiB, the pre-join 455.9 KiB before and 414.0 KiB after `0f48008`
  (gzip -9). Caddy's zstd adds about 6% to gzip -9, which matches the measurement in the table.
- `budget.spec.ts` still lists all three pages as pending F-043: a listed page over its budget is reported and skipped
  instead of failing. `/` and `/login` are under it, so they are asserted (the spec's sums: 153.6 and 194.1 KiB; one
  0.2 KiB file of `/login` is listed twice). For the call route the spec sums 100 Resource Timing entries for 84
  files: 16 files (39.0 KiB) that the page preloads (initiator `link`) are listed again when the module loads them
  (initiator `script`), so its sum, 477.9 KiB, is over the budget and the check is skipped. Whether the second entry
  is a second download or a cache hit is not recorded (the spec reads `encodedBodySize`, which a cache hit reports too;
  `transferSize` would tell). Pending: count each URL once (or use `transferSize`) and drop the pending list, so the
  call route is asserted.
- Counting everything the page fetched (prefetches and the E2EE worker included): `/` 206.9 KiB, `/login` 248.4 KiB,
  `/m/<slug>` 530.7 KiB. Counting only what started before the load event: `/` 153.6 KiB, `/login` 193.8 KiB,
  `/m/<slug>` 174.5 KiB (the call code loads after it).
- Caddy's zstd at its default level compresses this JavaScript about 3% worse than gzip at level 5 and about 6% worse
  than zstd level 6 (computed over the build output). Precompressed assets or a higher zstd level would help a little
  (F-066, accepted).

## 8. LiveKit limits

`docker-compose.yml` sets LiveKit's `limit.num_tracks` from `LIVEKIT_MAX_TRACKS` (default 1600) and
`limit.bytes_per_sec` from `LIVEKIT_MAX_BYTES_PER_SEC` (default 62500000 bytes per second, 500 Mbit/s). Both are
optional `.env` settings (`.env.example`), so an operator matches them to the server (§6) without editing the compose
file; `docker compose up -d livekit` applies a change (and interrupts the calls in progress). When the node is over a
limit, LiveKit refuses new participants instead of degrading every meeting on it; a value of 0 or less turns the limit
off (`LimitsReached` in LiveKit's node selector).

- `num_tracks` counts tracks in + out. A full 25-person meeting is about 1250 tracks, and browsers cost about 650 tracks
  per fast core (measured), about 300–400 per vCPU (planning value). Recommended: about 400 per vCPU, set per server
  (decision): 1600, the default, fits the 4-vCPU reference server (one full meeting plus a few small calls); 800 on
  2 vCPU, 2400 on 6, 3200 on 8. The earlier fixed 2600 admitted two full meetings, about 8 vCPU of SFU work, whatever
  the server size, which overloads the 4-vCPU reference.
- `bytes_per_sec` counts ingress plus egress. A full meeting is about 15–25 MB/s (120–200 Mbit/s); the default
  62500000 (500 Mbit/s) fits two to four full meetings. It follows the server's bandwidth plan rather than its CPU:
  keep the default on a plan of 500 Mbit/s or more, and on a smaller plan set the plan in bytes per second (Mbit/s ×
  125000: 31250000 for 250 Mbit/s, 12500000 for 100 Mbit/s), about 25 MB/s per full meeting.

## 9. Change log

- 2026-09-28: skeleton (methodology, templates, estimates). No measurements yet.
- 2026-10-03: Stage 10 on-box measurements (§4, §5); sizing (§6), budgets (§7) and LiveKit limits (§8) derived from
  them; `lk load-test` pinned to `livekit/livekit-cli:v2.18.8`; swarm (`tests/load/swarm.ts`), degradation, long
  recording and budget specs added. The dedicated-VM run stays a `[user]` item.
- 2026-10-22: §7 measured again on `c5835ea` after the F-043 fixes (`/` 153.6 KiB, `/login` 193.8 KiB, call route
  438.9 KiB with each file counted once; the spec double-counts 16 preloaded files and skips the call route, pending a
  spec fix). §8 describes the `.env` settings `LIVEKIT_MAX_TRACKS` (default 1600) and `LIVEKIT_MAX_BYTES_PER_SEC`
  (default 62500000) that replaced the fixed 2600 tracks in `c5835ea`, with values per server size. "Estimate" became
  "planning value" for derived numbers; README and `DEPLOYMENT.md` take their sizing from §6.
