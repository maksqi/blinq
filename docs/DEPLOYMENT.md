# Deployment

This is the full operator guide for running blinq on your own server. `README.md` has the short version. The commands
below are exercised by the production smoke test (§15). The sizing comes from the load tests in
[`PERFORMANCE.md`](PERFORMANCE.md).

## 1. What runs

`docker compose up -d --wait` starts four containers from `docker-compose.yml`:

| Service | Image | Network | Role |
|---|---|---|---|
| `caddy` | `blinq-caddy:local` (Caddy 2.11.4 + caddy-l4 v0.1.2) | host | HTTPS, HTTP/3, certificates, TURN/TLS routing by SNI |
| `app` | `blinq-app:local` (Node 24.21, Nuxt, ffmpeg 9) | host, bound to `127.0.0.1` | UI and API; runs migrations and bootstrap on every start |
| `livekit` | `livekit/livekit-server:v1.13.7` | host | SFU for encrypted media, embedded TURN |
| `postgres` | `postgres:18.6-alpine3.24` | none (unix socket only) | Database |

Architecture and the reasons for host networking: [`ARCHITECTURE.md`](ARCHITECTURE.md). Threat model:
[`SECURITY.md`](SECURITY.md).

Every container runs with `no-new-privileges`, all capabilities dropped (Caddy keeps `NET_BIND_SERVICE`; the Postgres
entrypoint keeps the few it needs to drop to its own user), a read-only root filesystem with tmpfs for scratch space,
`restart: unless-stopped` and rotated logs. The app runs as uid 10001 and LiveKit as `nobody`. No service publishes
ports, and each service receives only its own variables from `.env`. Images are pinned to full versions; the app's
runtime image has no package manager, and Caddy is built with patched Go modules until a Caddy release includes the
fixes.

## 2. Server requirements

- Linux on x86_64 or arm64 (host networking is Linux-only; Docker Desktop on macOS or Windows is not supported for
  production). Ubuntu 24.04 LTS and Debian 13 are the reference systems.
- Docker Engine ≥ 28.0.1 and the Compose v2 plugin (`docker compose`, not `docker-compose`).
- A public IPv4 address (IPv6 optional), two DNS names, and the ports in §4.
- `sh scripts/preflight.sh` checks these requirements (§7).

### Sizing

The figures come from the Stage 10 load tests: 25 real browsers with end-to-end encryption and LiveKit's own load
generator, measured on one fast machine (an Apple M5 Max that ran the SFU, the app and every test client at once).
The vCPU counts below are planning values derived from those measurements: a cloud vCPU is one thread of a slower
core, so one measured core counts as two vCPU. A run on a dedicated Linux VM with separate load hosts will confirm or
replace them (`[user]`). Method, raw results and derivation: [`PERFORMANCE.md` §5–§6](PERFORMANCE.md#6-sizing).

| Deployment | vCPU | RAM | Bandwidth (symmetric) | Load |
|---|---|---|---|---|
| Small team | 2 | 4 GB | 100 Mbit/s | about 10 people in calls at once |
| One full meeting | 4–6 | 8 GB | 250 Mbit/s | one 25-person meeting with a screen share, plus a few small calls |
| Each further full meeting | + 4 | + 1–2 GB | + 200 Mbit/s | |

Measured for one full meeting (25 people, cameras and microphones on, everyone in the 5×5 grid):
- SFU CPU: 1.9 cores of the test machine with real browsers, which is about 4 vCPU (planning value).
- SFU RAM: about 1 GB.
- Egress (server to participants): 118–140 Mbit/s, plus about 56 Mbit/s for a 1080p screen share at 15 fps. Real
  networks add retransmissions, so plan 200 Mbit/s. Ingress: 7–10 Mbit/s in the full grid, up to about 25 Mbit/s in
  smaller meetings where tiles are large.
- Traffic: 53–88 GB of egress per meeting hour (without and with a screen share); check your provider's egress
  pricing.
- Smaller meetings cost less per person: 13 people took 0.57 cores and 57 Mbit/s.

Other requirements:
- The minimum is 2 vCPU and 2 GB RAM (the preflight fails below that and warns below 4 vCPU / 4 GB).
- Recording: while a job runs, the server's ffmpeg uses `FFMPEG_THREADS` (default 2) and a RAM-backed work area of up
  to `RECORDING_WORK_TMPFS_SIZE` (default `4g`). Add both if you record. The recorder uploads at most about 1.2 GB per
  recording hour (2.5 Mbit/s of 1080p video plus 128 kbit/s of audio).
- Disk: about 10 GB for images and the database, plus recordings. Plan 1–1.8 GB per recorded hour at 1080p (planning
  value: the server re-encodes with no bitrate cap, so the size depends on the picture; the synthetic test video
  measured so far stored 0.17 GB per hour, a lower bound).

### LiveKit limits

LiveKit refuses new participants once the server forwards more tracks or bytes than two optional `.env` settings
allow, so an overloaded server does not degrade every meeting on it. The defaults fit the 4-vCPU reference server on a
plan of 500 Mbit/s or more; set both to your server (derivation:
[`PERFORMANCE.md` §8](PERFORMANCE.md#8-livekit-limits)):

| `.env` | Default | Set it to |
|---|---|---|
| `LIVEKIT_MAX_TRACKS` | `1600` | about 400 per vCPU (a full meeting is about 1250 tracks, in and out): `800` on 2 vCPU, `2400` on 6, `3200` on 8 |
| `LIVEKIT_MAX_BYTES_PER_SEC` | `62500000` (500 Mbit/s) | your bandwidth plan in bytes per second, Mbit/s × 125000 (a full meeting is about 15–25 MB/s): `12500000` for 100 Mbit/s, `31250000` for 250 Mbit/s |

`0` turns a limit off. `docker compose up -d livekit` applies a change and interrupts the calls in progress.

## 3. DNS

Create records that point at the server:

| Name | Records | Needed for |
|---|---|---|
| `DOMAIN` (e.g. `meet.example.com`) | A (and AAAA if the server has IPv6) | the app, signaling, certificates |
| `TURN_DOMAIN` (e.g. `turn.meet.example.com`) | A (and AAAA) | TURN over TLS on port 443 (recommended) |

- `TURN_DOMAIN` must differ from `DOMAIN`. It is optional: without it, calls from networks that allow only HTTPS
  won't connect, while TURN/UDP and ICE/TCP still work.
- Don't put a CDN or HTTP proxy in front (for Cloudflare: "DNS only"). TURN/TLS and WebRTC media cannot pass through
  it, and the app trusts `X-Forwarded-For` only from its own Caddy.
- If you use CAA records, allow your certificate authority (for example `letsencrypt.org`).
- Check before the first start: `dig +short A meet.example.com` and `dig +short A turn.meet.example.com` print the
  server's public IP. `sh scripts/preflight.sh` checks this too.

## 4. Ports

| Port | Protocol | Exposure | Purpose |
|---|---|---|---|
| 80 | TCP | public | ACME HTTP-01 challenges, redirect to HTTPS |
| 443 | TCP | public | HTTPS, WebSocket signaling (`/rtc`), TURN/TLS (by SNI) |
| 443 | UDP | public | HTTP/3 |
| 3478 | UDP | public | TURN over UDP |
| 7881 | TCP | public | ICE over TCP (fallback when UDP is blocked) |
| 50000–60000 | UDP | public | WebRTC media |
| 30000–40000 | UDP | public **only on 1:1-NAT clouds** | TURN relay hairpin (AWS, GCP, Azure and similar) |
| 3000 | TCP | loopback | app (Caddy proxies to it) |
| 7880 | TCP | loopback | LiveKit HTTP and RoomService (`/twirp` is never public) |
| 5349 | TCP | listens on all interfaces, **keep closed** | TURN plaintext behind Caddy; accepts PROXY-protocol connections from loopback only |
| 2020 | TCP | loopback | Caddy health endpoint |
| — | unix socket | none | Postgres (shared `pgsocket` volume) |

The loopback ports can be changed in `.env` (`APP_PORT`, `LIVEKIT_HTTP_PORT`, `LIVEKIT_TURN_TLS_PORT`,
`CADDY_HEALTH_PORT`) if something else already uses them. The media ports are `LIVEKIT_RTC_TCP_PORT`,
`LIVEKIT_RTC_PORT_RANGE_START`/`_END` and `LIVEKIT_TURN_UDP_PORT`.

## 5. Firewall

Example with ufw (Ubuntu):

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
# Only on clouds with 1:1 NAT (the public IP is not on the network interface):
# sudo ufw allow 30000:40000/udp
sudo ufw enable
```

- Docker's iptables rules bypass ufw only for ports published with `ports:`. blinq publishes none: Caddy, LiveKit and
  the app use host networking and Postgres has no network, so these ufw rules govern every listener.
- Never open 5349, 3000, 7880 or 2020.
- Cloud firewalls (security groups) need the same list. On 1:1-NAT clouds open 30000–40000/udp in both the cloud
  firewall and ufw, and set `LIVEKIT_NODE_IP` to the public (elastic) IP.
- firewalld: `sudo firewall-cmd --permanent --add-port=443/udp` and so on for each row, then
  `sudo firewall-cmd --reload`.

## 6. TLS modes

Set `TLS_MODE` in `.env`:

- **`acme`** (default): Let's Encrypt certificates for `DOMAIN` and `TURN_DOMAIN`, renewed automatically. Needs
  public DNS and TCP 80 reachable from the internet. Set `ACME_EMAIL` for expiry notices. While experimenting, set
  `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory` to avoid rate limits, then remove it and run
  `docker compose up -d --force-recreate caddy` to get trusted certificates.
- **`internal`**: Caddy's own CA, for intranet or LAN installs without public DNS. Every client must trust Caddy's
  root certificate: `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./blinq-root.crt`, then
  install it in the OS trust store (and in Firefox's own certificate store, Settings → Privacy & Security →
  Certificates, where Firefox does not use the OS store). Back up the `caddy_data` volume, or clients must trust a new
  root after a reinstall.
  - TURN/TLS works the same way: `TURN_DOMAIN` gets its own certificate from the internal CA, and TURN answers over TLS
    on port 443 (verified by the smoke test, §15). Browsers check the TURN server's certificate like any HTTPS
    certificate: until the root is trusted, Chromium and Firefox abort TURN/TLS (Caddy logs `remote error: tls:
    unknown certificate authority`) and fall back to UDP and ICE/TCP, so calls from networks that allow only HTTPS
    fail on those clients. TURN over UDP needs no certificate; on a LAN, LiveKit relays to its own private address
    (the smoke test's relay-only call goes that way).
- **`files`**: your own certificate. It must cover both `DOMAIN` and `TURN_DOMAIN` (SAN or wildcard). Mount it with a
  `docker-compose.override.yml`:

  ```yaml
  services:
    caddy:
      volumes:
        - /etc/ssl/blinq:/certs:ro
  ```

  and set `TLS_CERT_FILE=/certs/fullchain.pem` and `TLS_KEY_FILE=/certs/privkey.pem`. Caddy runs as root but without
  the capability to override file permissions, so the files must be owned by root (the key with mode 600) or be
  readable by everyone. Mount real files, not a directory of symlinks (for certbot, mount all of `/etc/letsencrypt`
  and point at `live/<name>/`). Caddy stops with `blinq-caddy: TLS_CERT_FILE=... is missing or unreadable` otherwise.
  It does not watch the files: run `docker compose restart caddy` after every renewal.

## 7. Install

1. Install Docker Engine and the Compose plugin from the official Docker repository
   (https://docs.docker.com/engine/install/), then add your user to the `docker` group and log in again.
2. Get the code:

   ```sh
   git clone https://github.com/maksqi/blinq.git
   cd blinq
   git checkout v1.0.0
   ```

3. Create `.env`:

   ```sh
   sh scripts/init-env.sh
   ```

   It refuses to overwrite an existing `.env` (`--force` replaces it) and asks, with defaults in brackets:

   | Question | Variable | Default |
   |---|---|---|
   | Public hostname of blinq | `DOMAIN` | — |
   | Second hostname for TURN over TLS (`-` for none) | `TURN_DOMAIN` | `turn.<DOMAIN>` |
   | Email of the first administrator | `ADMIN_EMAIL` | `admin@<DOMAIN>` |
   | Certificates | `TLS_MODE` | `acme` |
   | Email for Let's Encrypt expiry notices (acme only) | `ACME_EMAIL` | `ADMIN_EMAIL` |
   | Public IPv4 of this server for media (`-` to detect it with STUN) | `LIVEKIT_NODE_IP` | the address `DOMAIN` resolves to |

   It then generates `APP_SECRET`, `LIVEKIT_API_SECRET`, `POSTGRES_PASSWORD` and `ADMIN_PASSWORD` (32–48 characters
   of `A–Z a–z 0–9 _ -`), `LIVEKIT_API_KEY` (`API` and 12 letters or digits) and `RECORDING_ENCRYPTION_KEY` (base64 of
   32 random bytes) from `/dev/urandom`, writes `.env` with mode 600 and prints a summary with the admin password.
   That is the only time the password is shown.

   Without questions (for scripts): `DOMAIN=meet.example.com sh scripts/init-env.sh --yes`, or options such as
   `--domain`, `--turn-domain ''`, `--tls-mode internal` and `--node-ip` (`sh scripts/init-env.sh --help`). Set
   `ADMIN_PASSWORD` in the environment to choose the first password yourself (at least 12 characters).

   To write it by hand instead: `cp .env.example .env && chmod 600 .env`, fill in every `REQUIRED` value and generate
   secrets with the `openssl` commands in the comments. Prefer letters, digits, `_` and `-` in secrets: Compose
   expands `$`, so wrap any value that contains `$` in single quotes.
4. Recommended: UDP buffers for LiveKit and HTTP/3:

   ```sh
   printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' | sudo tee /etc/sysctl.d/99-blinq.conf
   sudo sysctl --system
   ```

5. Check the host: `sh scripts/preflight.sh` (`--env-file FILE` for another file). It prints one line per check, for
   example (abridged):

   ```text
   System
     ok    Linux 6.8.0-45-generic on x86_64
     ok    4 CPUs
     ok    about 7 GB RAM
     ok    net.core.rmem_max = 7500000
   ...
   DNS
     ok    DOMAIN=meet.example.com resolves to this server (203.0.113.10)
   ...
   preflight: no failures, 1 warning(s).
   ```

   Exit code 0 means every check passed, 2 warnings only, 1 at least one failure. Fix every `FAIL` line and read
   every `warn` line. It checks Linux, Docker ≥ 28.0.1 and Compose v2, `.env` (mode 600, required values, no
   placeholders, `$` in unquoted values), that both names resolve to `LIVEKIT_NODE_IP` or a local address, that the
   ports of §4 are free, CPU and RAM, the UDP buffers, NTP and free disk space.
6. Start: `docker compose up -d --wait`. The first run builds both images: about 2 minutes on a fast 10-core machine;
   allow 5–10 minutes on a small server (not measured). The command returns once every container is healthy; with the
   images built, that took 6–13 seconds on the smoke stack (Postgres initializes the database, then the app migrates
   it and creates the admin). With `TLS_MODE=acme`, Caddy requests the certificates in the background meanwhile,
   which takes a few more seconds before `https://DOMAIN` answers. If it fails, see §12.
7. Open `https://DOMAIN`, log in with `ADMIN_EMAIL` and the printed password, and set a new password when asked.
8. Delete the `ADMIN_PASSWORD` line from `.env` (the first admin is created only once, so it is never used again),
   then run `docker compose up -d` so the app container no longer carries it.
9. In the admin panel: configure registration (invite-only by default), guests, media limits and recording retention.
   With SMTP configured in `.env`, send a test email from the settings page.

What happens on every start of the app container: `cli migrate` (applies new migrations under a database lock),
`cli bootstrap` (creates the first admin only while none exists; afterwards it prints "nothing to do"), then the
server. A failing step stops the container before the server starts, and `docker compose logs app` shows why.

## 8. Upgrades

```sh
cd blinq
# 1. Take a backup (section 9).
git fetch --tags
git checkout v1.0.1          # the release you want
docker compose build --pull  # also refreshes the base images
docker compose up -d --wait
docker compose ps            # every service "healthy"
```

- Migrations run automatically when the app starts (under a database lock, idempotent).
- Downtime is the time it takes to recreate the containers; calls in progress are interrupted.
- Migrations are forward-only. To roll back, restore the pre-upgrade backup and check out the previous tag.
- Run `docker compose build --pull && docker compose up -d --wait` monthly even without a new release to pick up
  security fixes in the base images. `docker image prune` removes old layers.

## 9. Backup and restore

A complete backup is three things, taken together:

1. **The database** (accounts, rooms, recording metadata).
2. **The `recordings` volume** (already encrypted, BLQ1 format).
3. **`.env`**, above all `RECORDING_ENCRYPTION_KEY`. **If this key is lost, every stored recording is unrecoverable.**
   Keep `.env` separately from the recordings backup (for example in a password manager); storing both together
   gives anyone with the backup the plaintext recordings.

Optionally `caddy_data` (certificates, and the internal CA in `internal` mode).

Run these in the `blinq` checkout while the stack is up:

```sh
mkdir -p "$HOME/blinq-backups"
# Database (custom format), over the socket inside the container. The single quotes let the container expand its
# own variables.
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$HOME/blinq-backups/db-$(date +%F).dump"
# Recordings (the files keep their owner, uid 10001)
docker run --rm -v blinq_recordings:/src:ro -v "$HOME/blinq-backups:/backup" alpine:3.22 \
  tar -C /src -czf "/backup/recordings-$(date +%F).tar.gz" .
# .env (store it somewhere else, encrypted)
install -m 600 .env "$HOME/blinq-backups/env-$(date +%F)"
```

Restore on a new server (same `.env`, same or newer blinq version), from the `blinq` checkout with the backup files
in the current directory:

```sh
docker compose up --no-start          # creates the volumes and containers, starts nothing
docker compose start postgres
docker compose ps postgres            # wait until it shows "healthy"
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < db-YYYY-MM-DD.dump
docker run --rm -v blinq_recordings:/dst -v "$PWD:/backup:ro" alpine:3.22 tar -C /dst -xzf /backup/recordings-YYYY-MM-DD.tar.gz
docker compose up -d --wait
```

- The app starts only in the last step, so it migrates the restored database (when the new version brings
  migrations) instead of creating a fresh one, and bootstrap finds the existing admin ("nothing to do").
- Volume names carry the project name `blinq` (`blinq_pgdata`, `blinq_recordings`, ...): `docker volume ls`.
- These exact commands (with the smoke test's project name) were verified on the smoke stack: dump, wipe with
  `docker compose down -v`, restore; the admin account and a recording file (owner 10001) came back and `/api/ready`
  answered 200.
- Test a restore at least once, and keep backups encrypted at rest.

## 10. Logs and health

```sh
docker compose ps                       # state and health of every service
docker compose logs -f app              # app logs (startup summary, requests, errors)
docker compose logs --since 1h caddy    # certificates, access log (JSON)
docker compose logs livekit             # media server, TURN
curl -fsS https://meet.example.com/api/health   # liveness
curl -fsS https://meet.example.com/api/ready    # database reachable and migrations applied; LiveKit reported
```

- `LOG_FORMAT=json` makes app logs machine-readable for log shippers; `LOG_LEVEL` controls verbosity.
- At startup the app prints one line: version, public URL, TURN on/off, SMTP on/off, registration mode.
- Docker rotates logs (json-file, 5 files of 10 MB per container). Secrets and tokens are redacted.

## 11. Recovery CLI

Reset any account's password (for example a locked-out admin). The password is read from stdin, never from the
command line; every session of that user is revoked and the action is audited. In bash or zsh:

```sh
read -rs NEW_PASSWORD   # type the new password, press Enter (nothing is shown)
printf '%s\n' "$NEW_PASSWORD" | docker compose exec -T app node .output/server/cli.mjs reset-password admin@example.com
unset NEW_PASSWORD
```

The other commands (`migrate`, `bootstrap`) run automatically at every start.

## 12. Troubleshooting

**`docker compose up` fails with "required variable ... is missing".** The message names the variable; set it in
`.env` (`sh scripts/init-env.sh` generates secrets). Values that still look like placeholders are refused at startup:
`docker compose logs app` names the variable.

**`caddy` keeps restarting.** `docker compose logs caddy` starts with a `blinq-caddy:` line that names the problem:
an unknown `TLS_MODE`, `TURN_DOMAIN` equal to `DOMAIN`, a `DOMAIN` with a scheme or port, a certificate file that is
missing or unreadable in `files` mode, or the output of Caddy's own validation of the rendered configuration.

**`app` keeps restarting.** The entrypoint prints `[blinq] entrypoint: 'migrate' failed ...` or `'bootstrap' failed
...` above the reason. `migrate`: the database is unreachable (`docker compose logs postgres`). `bootstrap`: no admin
exists yet and `ADMIN_EMAIL` / `ADMIN_PASSWORD` are missing, a placeholder or too weak (at least 12 characters).

**No certificate / ACME errors.** `docker compose logs caddy | grep -i -E 'acme|challenge|certificate'`. Check that
both names resolve to this server, that TCP 80 and 443 are reachable from outside, and that no other web server holds
them. After repeated failures, use `ACME_CA` (staging) until it works: Let's Encrypt rate-limits failed validations.

**Calls work on some networks only, or never from networks that allow only HTTPS.** Test TURN/TLS:
`openssl s_client -connect turn.meet.example.com:443 -servername turn.meet.example.com </dev/null`. It must present
the `TURN_DOMAIN` certificate. The `DOMAIN` certificate means `TURN_DOMAIN` is empty or Caddy was started before it
was set: `docker compose up -d --force-recreate caddy livekit`.

**Firefox connects only over UDP, never through TURN/TLS.** Firefox rejects TURN answers that report a loopback
address, so PROXY protocol must be on at both ends (Caddy `proxy_protocol v2`, LiveKit `turn.proxy_protocol`).
Check `docker compose logs livekit` for TURN errors.

**Relay-only test (UDP blocked).** On a client, block outbound UDP (except DNS) with the OS firewall, set
`media.peerconnection.ice.relay_only` to `true` in Firefox `about:config`, and join a call. `about:webrtc` (or
`chrome://webrtc-internals` in Chrome) must show a selected candidate pair of type `relay` over TLS on port 443.

**Participants connect but see no video, or "could not establish pc connection".** Usually the advertised IP or
firewall is wrong. Set `LIVEKIT_NODE_IP` to the server's public IPv4 (the elastic IP on 1:1-NAT clouds), open
7881/tcp and 50000–60000/udp, then `docker compose up -d livekit`. `docker compose logs livekit` shows the node IP at
startup ("using explicit node IP" when `LIVEKIT_NODE_IP` is set, "found external IP via STUN" otherwise).
- LiveKit also offers the server's IPv6 addresses. If the server has IPv6, open the same ports for IPv6 (ufw does by
  default).
- Every IPv4 candidate carries `LIVEKIT_NODE_IP`, one per local interface; Docker's default bridge (`docker0`) is
  excluded. Extra Docker bridge networks of other projects on the same host only add candidates that never connect,
  but with `LIVEKIT_NODE_IP` empty they can also mislead the STUN detection: set it on such hosts.
- Without `LIVEKIT_NODE_IP`, LiveKit asks public STUN servers (Twilio, Google) for the address at every start; set it
  to avoid that request.

**A port is already in use.** `sudo ss -tulpn | grep -E ':(80|443|3478|7881|3000|7880|5349|2020)\b'`. Stop the other
service (often Apache or nginx on 80/443) or move blinq's loopback ports in `.env`. `sh scripts/preflight.sh` checks
every port of §4.

**Docker older than 28.0.1 or Compose v1.** Upgrade from the official Docker repository. Compose v1 (`docker-compose`)
cannot parse the file.

**App unhealthy, `/api/ready` returns 503.** The database is unreachable or migrations are pending; `details.checks`
in the response says which (LiveKit is reported there too, but does not make the app unready). `docker compose ps`
and `docker compose logs app postgres livekit`. The reason of the last failed healthcheck:
`docker inspect --format '{{json .State.Health}}' blinq-app-1`. "password authentication failed" after editing
`POSTGRES_PASSWORD`: the password is set only when the database is created; change it back, or run `ALTER USER`
inside the container.

**Recording stuck in "processing" or "failed".** `docker compose logs app | grep -i recording`. Common causes: the
work area is too small (`RECORDING_WORK_TMPFS_SIZE` should be about twice the longest recording), the job hit
`FFMPEG_TIMEOUT_MINUTES`, the disk is full, or the browser produced media outside the allowlist. Failed recordings
are never served; the error is shown in the recordings list.

**"This browser can't join encrypted calls".** The browser lacks the APIs needed for end-to-end encryption, and blinq
never falls back to an unencrypted call. Use a current Chrome, Edge, Firefox or Safari (README, "Browser support").

**Sign-in answers "Too many attempts" (429).** Failed sign-ins are counted per network (an IPv4 address or an IPv6
/64), per network and account, and per account. After 5 failures on a key the wait starts at about a second and
doubles with every further failure, up to 15 minutes; `Retry-After` says how long, and failures older than 24 hours no
longer count. There is no lockout: the account key only slows networks that already failed for that account, so the
owner can always sign in from another network, and any password reset (§11, an admin reset or the emailed link) clears
the account's wait. More than 8 sign-ins in flight from one network, or more than 16 passwords queued for hashing on
the server (4 are hashed at once), also answer 429, with `Retry-After: 1`. Many of those at once usually mean a login
flood: `docker compose logs caddy` shows where it comes from.

**People behind one address get "Too many attempts" when they join.** Joining allows 30 requests per minute per
network (IPv4 address or IPv6 /64), and each join takes two, so about 15 people per minute can join from behind one
office NAT. The others wait for the minute to pass and try again. Waiting-room screens are capped at 50 per network
(429 with `Retry-After: 10`).

**Someone lands in the waiting room although the room has none.** After a participant is removed or denied, everyone
who joins from the same network (IPv4 address or IPv6 /64) goes through the waiting room for the rest of the meeting,
so a removed person cannot come straight back. A host or co-host admits the others from the waiting-room panel. A
removed person who has an invite link and switches networks can still ask to join again: lock the room or revoke the
link to stop that.

**Joining fails with "The meeting service isn't available" (503).** Either the app cannot reach LiveKit, or the server
is too busy: a join waits at most 15 seconds for its room's lock. For LiveKit, `/api/ready` (§10) reports
`checks.livekit` as `down`, `docker compose logs app | grep 'LiveKit call failed'` names the failed operation, and
`docker compose ps livekit` and `docker compose logs livekit` show why. In-call host
actions and recording also answer 503 while LiveKit is unreachable. A busy server recovers by itself; if it happens
often, check CPU and the database (`docker stats`, `docker compose logs app postgres`) against the sizing in §2.

**New participants can't connect while big meetings run.** The server may have reached `LIVEKIT_MAX_TRACKS` or
`LIVEKIT_MAX_BYTES_PER_SEC` (§2), where LiveKit refuses new participants. Raise them only if CPU and bandwidth have room.

**A request answers 413.** Request bodies are limited to 1 MB (20 MB under `/api/recordings/`, where one recording
chunk may be up to 16 MiB), by Caddy and again by the app, which also counts bodies sent without a length. The web app
stays far below that; a 413 points at a script or client that sends too much.

## 13. Security hardening

- Keep the host patched (for example `unattended-upgrades`), allow SSH keys only, and rebuild images monthly (§8).
- `.env` stays mode 600 and never leaves the server unencrypted.
- Deploy tagged releases and review changes before upgrading: a compromised server can serve JavaScript that leaks
  room keys (see [`SECURITY.md`](SECURITY.md)).
- Don't expose 5349, 3000, 7880 or 2020, and don't put another reverse proxy or CDN in front (unsupported in v1).
- Keep registration invite-only unless you need otherwise; review guest access and retention in the admin panel.
- Secret rotation:
  - A new `APP_SECRET` invalidates every room invite link.
  - A new `LIVEKIT_API_SECRET` needs `docker compose up -d` so the app and LiveKit restart together.
  - `RECORDING_ENCRYPTION_KEY` cannot be rotated in v1: changing it makes existing recordings unreadable.

## 14. Uninstall

`docker compose down` stops and removes the containers and keeps all data. `docker compose down -v` also deletes the
database, recordings and certificates. This cannot be undone.

## 15. Smoke test (developers and CI)

`sh scripts/smoke-prod.sh` runs this deployment end to end on a development machine or CI runner (Linux, or macOS with
Docker Desktop, where the "host" network is the Docker VM). It never touches a real installation: it uses the
project name `blinq-smoke`, a throwaway `.env.smoke` and `TLS_MODE=internal` with `DOMAIN=blinq.localhost`.

1. Records the listening sockets of the host network, detects the host's IPv4 for `LIVEKIT_NODE_IP` and moves any
   loopback or media port that is already taken (80 and 443 must be free).
2. Writes `.env.smoke` with `init-env.sh --yes`, runs the preflight (Linux), and checks `docker compose config` with
   TURN on, with TURN off, and without `APP_SECRET` (the error must name it).
3. Builds both images and runs `docker compose up -d --wait`.
4. Checks every container with `docker inspect`: capabilities, `no-new-privileges`, read-only root, users, networks
   (`none` for Postgres), no published ports, log rotation; that the app user can write only its tmpfs areas and the
   recordings volume; that the argon2 binding is in the image; that Postgres refuses the socket without a password.
5. Runs `tests/smoke-prod/*.spec.ts` in the pinned Playwright image on the host network: health and readiness,
   security headers (HSTS, CSP nonce, the Permissions-Policy override, COOP and CORP, the 308 redirect, `Alt-Svc`),
   routing (`/api/webhooks/*` and `/twirp/*` are 404, 2 MB bodies get 413, 2 MB recording chunks do not), the
   certificates of both names, TURN over TLS through Caddy with PROXY protocol, the login page in Chromium and Firefox
   under the enforced CSP, and two Chromium ↔ Firefox calls with audio and video both ways: a direct one (every IPv4
   candidate of the SFU is `LIVEKIT_NODE_IP`, ports from the media range) and a relay-only one through LiveKit's
   TURN, which relays to the SFU's private address (`turn.allow_restricted_peer_cidrs`).
6. Restarts the app and checks that migrate and bootstrap ran again, idempotently, with exactly one admin.
7. Compares the listening sockets with step 1: only the ports of §4 may be new, and 3000, 7880 and 2020 only on
   loopback; nothing on 2019 or 5432.
8. Scans every container log for the secrets of `.env.smoke`, LiveKit tokens and unredacted `access_token` values.
9. Removes the stack and its volumes (`--keep` leaves them for inspection).

Output: `logs/smoke-prod/` (summary, `compose.log`, listeners, the Playwright report). `--no-build` reuses existing
images (CI builds them with its layer cache).
