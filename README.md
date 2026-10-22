# blinq

Self-hosted, end-to-end encrypted video meetings for teams. blinq runs meetings of up to 25 people with encrypted
audio, video, screen share and chat on one Linux server, started with one `docker compose up`. The stack is a Nuxt web
app and API, a LiveKit SFU with built-in TURN, PostgreSQL, and Caddy for automatic HTTPS. The room key travels only in
the meeting link's fragment (`#k=…`), which browsers never send to a server. So neither the media server nor the
database ever sees your calls or chat in plaintext.

**Status:** version 1.0.0. What it contains: [CHANGELOG.md](CHANGELOG.md). What comes next: the backlog in
[docs/ROADMAP.md](docs/ROADMAP.md#backlog-not-in-v1).

## Features

- **End-to-end encryption** for media and chat (LiveKit E2EE and AES-GCM). The key exists only in the link fragment
  and in participants' browsers, never on the server. A safety code lets participants check that they share one key.
- **Rooms of up to 25 people** with grid and speaker views, pinning, and an active-speaker highlight.
- **Host controls:**
  - a waiting room (admit or deny), locking the room, and removing a participant;
  - muting microphones and turning off cameras;
  - giving voice (letting a participant with a raised hand speak);
  - setting a participant's volume for everyone;
  - co-hosts.
- **Screen share** at 720p–1080p and 5–30 fps (the admin sets the maximum), with optional tab or system audio.
- **Chat, reactions and raised hands.**
- **Background blur and noise suppression** (RNNoise), both processed in the browser.
- **Recording in the browser**, in one of two modes:
  - uploaded and stored encrypted on the server (the server and admins can decrypt it);
  - saved only on the recording device, which keeps it end-to-end encrypted.
- **Admin panel:** users, account invites, registration mode, guests, media quality and limits, recordings and
  retention, the audit log, an SMTP test.
- **Invite-only accounts** by default (open or domain-restricted registration are options), plus **guests** who join
  from a room invite link without an account.
- **Dark and light theme** (follows the system), a **responsive** layout down to phones, and keyboard shortcuts,
  including push-to-talk.
- **Self-hosted:** one `docker compose up`, automatic HTTPS, and TURN over TLS on port 443 for restrictive networks.
  No third-party services, CDNs or telemetry.

## Requirements

- A Linux server (x86_64 or arm64; Ubuntu 24.04 LTS and Debian 13 are the reference systems) with Docker Engine
  ≥ 28.0.1 and the Compose v2 plugin (`docker compose`). Production uses host networking, so Docker Desktop on macOS
  or Windows is not supported for production.
- A public IPv4 address. 1:1 NAT (common on cloud VMs) works with one extra UDP range (see [Ports](#ports)). Set
  `LIVEKIT_NODE_IP` to the public address.
- DNS names that point at the server: `DOMAIN` for blinq, and `TURN_DOMAIN` (recommended) for TURN over TLS.
- The public ports below, free on the server (no other web server on 80 or 443) and open in the host firewall and in
  any cloud security group.
- `sh scripts/preflight.sh` checks all of this on the server before the first start.
- Sizing, from the Stage 10 load tests with 25 encrypted browser clients. They were measured on one fast machine, so
  the vCPU counts are planning values for a Linux VM until a run on a dedicated VM confirms them (details:
  [docs/DEPLOYMENT.md §2](docs/DEPLOYMENT.md#sizing), [docs/PERFORMANCE.md §6](docs/PERFORMANCE.md#6-sizing)):

  | Use | vCPU | RAM | Bandwidth (symmetric) |
  |---|---|---|---|
  | Small team: about 10 people in calls at once | 2 | 4 GB | 100 Mbit/s |
  | One full 25-person meeting with a screen share, plus a few small calls | 4–6 | 8 GB | 250 Mbit/s |
  | Each further full meeting | + 4 | + 1–2 GB | + 200 Mbit/s |

  - Measured for one full meeting: about 1 GB of SFU RAM and 118–140 Mbit/s of egress (about 56 Mbit/s more with a
    1080p screen share), which is 53–88 GB of traffic per meeting hour.
  - Recording adds ffmpeg (`FFMPEG_THREADS`, default 2) and its RAM work area (`RECORDING_WORK_TMPFS_SIZE`, default
    4g) while a job runs. Plan 1–1.8 GB of disk per recorded hour at 1080p (planning value; only synthetic video has
    been measured so far).
  - Match `LIVEKIT_MAX_TRACKS` (default 1600, about 400 per vCPU) and `LIVEKIT_MAX_BYTES_PER_SEC` (default 62500000,
    your bandwidth in bytes per second) in `.env` to the server: see
    [docs/DEPLOYMENT.md §2](docs/DEPLOYMENT.md#livekit-limits).

- Optional: an SMTP server for emailed account invites, email verification and password reset. The server never
  emails room links, because they contain the key.
- TLS, one of three modes:
  - Let's Encrypt (`TLS_MODE=acme`), which needs ports 80 and 443 reachable from the internet;
  - Caddy's internal CA for LAN installs (`internal`);
  - your own certificate files (`files`).

## Quick start

The short version for a fresh Linux server. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) explains every step and option.

1. **DNS.** Create A records (and AAAA, if the server has IPv6) for `DOMAIN` (for example `meet.example.com`) and
   `TURN_DOMAIN` (for example `turn.meet.example.com`) that point at the server. No CDN or HTTP proxy in front: with
   Cloudflare, use "DNS only".
2. **Firewall.** Open the public ports (see [Firewall](#firewall)).
3. **Docker.** Install Docker Engine and the Compose plugin from the official repository
   (https://docs.docker.com/engine/install/).
4. **Get the code and create `.env`:**
   ```sh
   git clone https://github.com/maksqi/blinq.git
   cd blinq
   sh scripts/init-env.sh
   ```
   The script asks for `DOMAIN`, `TURN_DOMAIN`, the first admin's email, the TLS mode, the Let's Encrypt email and the
   server's public IPv4 (`LIVEKIT_NODE_IP`). It generates every secret, writes `.env` with mode 600, and prints the
   first admin password once. Without questions: `DOMAIN=meet.example.com sh scripts/init-env.sh --yes`. To write
   `.env` by hand instead, see [docs/DEPLOYMENT.md §7](docs/DEPLOYMENT.md#7-install).
5. **Check the server.** Raise the UDP buffers first (recommended for LiveKit and HTTP/3), then run the preflight:
   ```sh
   printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' | sudo tee /etc/sysctl.d/99-blinq.conf
   sudo sysctl --system
   sh scripts/preflight.sh
   ```
   It prints one `ok`, `warn` or `FAIL` line per check and ends with `preflight: all checks passed.` (exit code 0) or
   `preflight: no failures, N warning(s).` (exit code 2). Fix every `FAIL` line before you continue (exit code 1).
6. **Start:**
   ```sh
   docker compose up -d --wait
   ```
   The first run builds both images, which takes several minutes. The command returns once all four services are
   healthy; `docker compose ps` shows them as `healthy`.
7. **First login.** Open `https://DOMAIN` and sign in with `ADMIN_EMAIL` and the password the script printed. You
   must choose a new password. Then delete the `ADMIN_PASSWORD` line from `.env` and run `docker compose up -d`, so
   the app container no longer carries it (the first admin is created only once; it is never used again).
8. **Invite people** from Admin → Invites, or change the registration mode in Admin → Settings.
9. **Back up `.env`**, above all `RECORDING_ENCRYPTION_KEY`. Without it, stored recordings cannot be decrypted (see
   [Backup and restore](#backup-and-restore)).

## Ports

Public (open these in the firewall):

| Port | Protocol | Used by | Purpose | `.env` |
|---|---|---|---|---|
| 80 | TCP | Caddy | ACME HTTP-01 challenges, redirect to HTTPS | — |
| 443 | TCP | Caddy | HTTPS, WebSocket signaling (`/rtc`), TURN over TLS (routed by SNI on `TURN_DOMAIN`) | — |
| 443 | UDP | Caddy | HTTP/3 | — |
| 3478 | UDP | LiveKit | TURN over UDP | `LIVEKIT_TURN_UDP_PORT` |
| 7881 | TCP | LiveKit | ICE over TCP (media when UDP is blocked) | `LIVEKIT_RTC_TCP_PORT` |
| 50000–60000 | UDP | LiveKit | WebRTC media | `LIVEKIT_RTC_PORT_RANGE_START`, `LIVEKIT_RTC_PORT_RANGE_END` |
| 30000–40000 | UDP | LiveKit TURN | only on clouds with 1:1 NAT: TURN relay hairpin | — |

Not public (loopback or socket only; keep them closed):

| Port | Used by | Notes | `.env` |
|---|---|---|---|
| 3000/tcp | blinq app | bound to 127.0.0.1; Caddy is the only way in | `APP_PORT` |
| 7880/tcp | LiveKit API | bound to 127.0.0.1; Caddy proxies only `/rtc`, never `/twirp` | `LIVEKIT_HTTP_PORT` |
| 5349/tcp | LiveKit TURN (plain, behind Caddy) | listens on all interfaces but accepts only PROXY-protocol connections from loopback; block it in the firewall | `LIVEKIT_TURN_TLS_PORT` |
| 2020/tcp | Caddy health | bound to 127.0.0.1 | `CADDY_HEALTH_PORT` |
| unix socket | PostgreSQL | no network at all (`network_mode: none`) | — |

The production smoke test (`sh scripts/smoke-prod.sh`) starts a test stack and fails if anything outside these two
tables listens.

### Firewall

No service publishes ports through Docker (Caddy, LiveKit and the app use host networking, Postgres has no network),
so the host firewall governs every listener. With ufw:

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 3478/udp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:60000/udp
# Only on clouds with 1:1 NAT (AWS, GCP, Azure and similar: the public IP is not on the network interface):
# sudo ufw allow 30000:40000/udp
sudo ufw enable
```

- Open the same list in the cloud firewall (security group). Never open 3000, 7880, 5349 or 2020.
- On 1:1-NAT clouds, also set `LIVEKIT_NODE_IP` to the public (elastic) IP.
- firewalld and more details: [docs/DEPLOYMENT.md §5](docs/DEPLOYMENT.md#5-firewall).

## Configuration

- `.env` holds the infrastructure settings and secrets. Every variable is documented in `.env.example`, and the full
  list is in [docs/API.md](docs/API.md) (Environment).
- Runtime behavior is set in the admin panel and applies without a restart: registration mode, guests, video
  quality, participant and room limits, recording, retention.

## Operations

Run these in the `blinq` checkout. Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §8–§12.

### Status and logs

```sh
docker compose ps                               # every service should be "healthy"
docker compose logs -f app                      # startup summary, requests, errors (secrets are redacted)
docker compose logs caddy                       # certificates and the JSON access log
docker compose logs livekit                     # media server and TURN
curl -fsS https://meet.example.com/api/health   # liveness
curl -fsS https://meet.example.com/api/ready    # database reachable and migrations applied (503 with details if not)
```

### Upgrade

```sh
# 1. Take a backup (below).
git fetch --tags
git checkout v1.0.1          # the release you want
docker compose build --pull  # also refreshes the base images
docker compose up -d --wait
```

Migrations run automatically every time the app starts (idempotent, under a database lock) and are forward-only: to
roll back, restore the pre-upgrade backup and check out the previous tag. Calls in progress are interrupted while the
containers are recreated. Rebuild monthly (`docker compose build --pull && docker compose up -d --wait`) to pick up
security fixes in the base images.

### Backup and restore

A complete backup is three things, taken together:

1. **The database**: `docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > blinq-db.dump`
2. **The recordings volume** (already encrypted): `docker run --rm -v blinq_recordings:/src:ro -v "$PWD:/backup" alpine tar -C /src -czf /backup/blinq-recordings.tar.gz .`
3. **`.env`**, above all `RECORDING_ENCRYPTION_KEY`. **If this key is lost, every stored recording is unrecoverable.**
   Keep `.env` apart from the recordings backup (for example in a password manager): together they give anyone the
   plaintext recordings.

Restore onto a new server with the same `.env`: create the stack without starting it, start Postgres, `pg_restore`,
unpack the recordings, then start everything. The exact commands and checks are in
[docs/DEPLOYMENT.md §9](docs/DEPLOYMENT.md#9-backup-and-restore). Test a restore at least once.

### Reset a password

The new password is read from stdin, never from the command line; all sessions of the account are revoked.

```sh
read -rs NEW_PASSWORD   # type it and press Enter; nothing is shown
printf '%s\n' "$NEW_PASSWORD" | docker compose exec -T app node .output/server/cli.mjs reset-password admin@example.com
unset NEW_PASSWORD
```

### Troubleshooting

- **`docker compose up` stops with "required variable … is missing a value".** Set the named variable in `.env`
  (`sh scripts/init-env.sh` generates secrets). A service that exits instead names its problem in
  `docker compose logs <service>`; Caddy's configuration errors start with `blinq-caddy:`.
- **No certificate.** `docker compose logs caddy | grep -i -E 'acme|challenge|certificate'`. Both names must resolve
  to this server and TCP 80 and 443 must be reachable from the internet. While experimenting, set
  `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` to stay clear of Let's Encrypt's rate limits.
- **Calls fail on networks that allow only HTTPS.** They need TURN over TLS on port 443, so `TURN_DOMAIN` must be set
  and resolve to the server. `openssl s_client -connect turn.meet.example.com:443 -servername turn.meet.example.com
  </dev/null` must show the `TURN_DOMAIN` certificate.
- **People join but see no video ("could not establish pc connection").** The advertised address or the firewall is
  wrong: set `LIVEKIT_NODE_IP` to the server's public IPv4 (the elastic IP behind 1:1 NAT), open 7881/tcp and
  50000–60000/udp (plus 30000–40000/udp behind 1:1 NAT), then `docker compose up -d`.
- **App unhealthy.** `docker compose logs app postgres livekit`; `/api/ready` names the failing check.
- **Sign-in says "Too many attempts" (429).** Failed sign-ins slow down the network they come from: after 5 failures
  the wait doubles with each further failure, up to 15 minutes (`Retry-After` says how long). There is no lockout: the
  account's owner can always sign in from another network, and a password reset (above) clears the account's wait.
- **Many people behind one office address get "Too many attempts" when they join.** About 15 joins per minute are
  allowed per network; the others try again a minute later.
- **Someone lands in the waiting room although the room has none.** After a removal, joiners from the removed
  person's network (IPv4 address or IPv6 /64) go through the waiting room for the rest of the meeting. Admit them from
  the waiting-room panel.
- **Joining says "The meeting service isn't available" (503).** The app cannot reach LiveKit (`/api/ready` reports
  `livekit` as `down`; `docker compose logs livekit`), or the server was too busy to take the join within 15 seconds.

More cases (Firefox and TURN, ports in use, old Docker, recordings, LiveKit limits, 413 responses) are in
[docs/DEPLOYMENT.md §12](docs/DEPLOYMENT.md#12-troubleshooting).

## Browser support

Targets: current Chrome, Edge, Firefox and Safari on the desktop, Safari on iOS, and Chrome on Android.

Tested automatically ([docs/TESTING.md](docs/TESTING.md)):
- **Chromium and Firefox:** end-to-end encrypted calls between the two on the real meeting flow, plus every other UI
  flow, in each pull request's E2E run. The production smoke test also runs a Chromium ↔ Firefox call on the
  production images, directly and relayed through TURN.
- **WebKit on Linux:** the UI only (sign-in, settings, dashboard and admin pages, accessibility, security headers, and
  the call page's unsupported-browser screen). Linux WebKit cannot run end-to-end encrypted calls.
- **Microsoft Edge:** the E2E suite every night (non-blocking).
- **Safari on macOS with E2EE:** not automated yet (backlog); it is part of the manual check below.

Before a release, the maintainers check the targets on real devices (Chrome, Edge, Firefox, Safari on macOS and iOS,
Chrome on Android) with the manual matrix in
[docs/TESTING.md §9](docs/TESTING.md#9-manual-cross-browser-matrix-user), which also records the results.

Known limits:
- No screen sharing on iOS or Android: those browsers don't offer screen capture to web pages.
- No speaker (audio output) selection on Safari, iOS or Android. Audio plays on the system output.
- Safari before 17.2 sends video without simulcast under E2EE, so others always receive its full resolution.
- A browser without E2EE support gets an explanation screen. blinq never falls back to an unencrypted call.

## Development

Prerequisites:
- Node 24 (`.node-version`; ≥ 22.19 also works).
- pnpm 11.20 (`packageManager` in `package.json`).
- Docker (Docker Desktop on macOS). Browser tests run Playwright inside Docker, so no local browsers are needed.
- ffmpeg 9, for the recording tests.

```sh
cp .env.dev.example .env
pnpm install
pnpm dev:deps       # Postgres on 127.0.0.1:55432, LiveKit, Mailpit (http://localhost:8025)
pnpm cli bootstrap  # once: creates the dev admin from ADMIN_EMAIL / ADMIN_PASSWORD
pnpm dev            # applies migrations, then serves http://localhost:3000
```

- Sign in as `admin@blinq.local` with the dev password from `.env.dev.example`. You are asked to change it.
- Mailpit at http://localhost:8025 catches every email the app sends.
- The dev LiveKit advertises your LAN IP (`scripts/detect-ip.sh`), because Firefox rejects loopback ICE candidates.
  If detection fails (for example on a VPN), set `LIVEKIT_NODE_IP`.
- The dev Postgres uses port 55432, because a local Postgres often owns 5432.

Checks and tests (details in [docs/TESTING.md](docs/TESTING.md)). Lint, typecheck, unit and API tests run on the host;
browser tests run in Docker:

```sh
pnpm lint && pnpm typecheck
pnpm test                                  # unit tests
sh scripts/with-lock.sh pnpm test:api      # API integration tests (builds the test server)
pnpm test:e2e:docker                       # Playwright in Docker (sh scripts/e2e-docker.sh [playwright args])
pnpm check:english                         # everything in the repository must be English
sh scripts/smoke-prod.sh                   # production compose stack with TLS_MODE=internal (docs/DEPLOYMENT.md §15)
```

`pnpm test:e2e:docker` passes its arguments to Playwright, for example
`pnpm test:e2e:docker --project=chromium tests/e2e/call`. On macOS, `sh scripts/e2e.sh` hands over to it. Setup,
projects and options: [docs/TESTING.md §6](docs/TESTING.md#6-e2e-tests-playwright).

Contributors and AI agents: read [AGENT.md](AGENT.md) before changing anything.

## Documentation

| Document | Contents |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | what each release contains, and its known limitations |
| [AGENT.md](AGENT.md) | rules for contributors and AI agents, the stack, commands, known gotchas |
| [docs/ROADMAP.md](docs/ROADMAP.md) | stages, status, dependencies, file ownership |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, topology, data model, key flows |
| [docs/API.md](docs/API.md) | HTTP API, LiveKit contracts, crypto derivations, settings, environment |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model, E2EE design, hardening, vulnerability reports |
| [docs/TESTING.md](docs/TESTING.md) | test layers, commands, fixtures, CI, the manual browser matrix |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | production deployment in depth: DNS, ports, firewall, TLS modes, install, upgrades, backups, troubleshooting |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | load-test method, results, sizing, budgets, LiveKit limits |
| [docs/stages/](docs/stages/) | one file per implementation stage, each with its Definition of Done |

## Security

A summary of [docs/SECURITY.md](docs/SECURITY.md):
- **E2EE.** Audio, video, screen share and chat are encrypted in the browser with keys derived from the room key.
  The SFU, TURN, the network, the database and backups see only ciphertext.
- **The key never reaches the server.** It lives in the link fragment `#k=…` and in participants' browsers. The
  server stores only a hash of a join proof derived from it. Compare the safety code in a call to confirm that
  everyone has the same key.
- **Limits:**
  - blinq does not protect against a malicious or compromised app server, which could serve JavaScript that steals
    the key;
  - there is no per-sender authenticity: any key holder could impersonate another participant;
  - the server sees metadata (who joins when, display names, timing);
  - a removed participant still knows the key until the host rotates it, which is possible between meetings (not
    during one);
  - server-stored recordings are encrypted at rest but readable by the server and admins. Local-only recordings stay
    end-to-end encrypted.
- **Hardening.** Invite-only accounts, argon2id password hashing, rate limiting with backoff, CSRF protection, a
  strict CSP, HSTS, no third-party requests, and secrets only in `.env`.
- **Report vulnerabilities privately** (docs/SECURITY.md §11), not in public issues.

## License

TBD.
