# Stage 09 — Production deployment

Status: 9a done; 9b needs a real server (user)
Owner(s): `infra` (9a, Wave 1); user (9b, final, on a real server)
Depends on: 9a: Stage 01 (W0b merged: CLI, `/api/health`, `/api/ready`, env parsing, CI workflows). 9b: Stage 10
(release candidate).
Blocks: 9a: Stage 10 (smoke gate, clean `docker build` in every merge gate, container review). 9b: the `v1.0.0`
sign-off.

## Goal
One `docker compose up -d --wait` on a Linux host brings up blinq behind HTTPS: Caddy (automatic certificates, HTTP/3,
TURN/TLS on 443 by SNI), LiveKit in host networking, the app bound to loopback, and Postgres with no network at all. The
operator follows README and `docs/DEPLOYMENT.md` verbatim: generate `.env`, run the preflight, start, log in, change the
admin password. 9a proves this in a local and CI smoke test with `TLS_MODE=internal`. 9b proves it on a real VM with
real DNS, real certificates and a relay-only call with UDP blocked.

## Scope
### In scope
- 9a: `Dockerfile` (app), `docker/app/**`, `docker/caddy/**`, `docker-compose.yml`, the LiveKit production config,
  `scripts/{init-env.sh,preflight.sh,smoke-prod.sh}`, the smoke specs, README deployment sections, `docs/DEPLOYMENT.md`.
- 9b: installing on a real server by following the docs, and reporting every deviation.
### Out of scope (and where it lives instead)
- Env parsing and `.env.example` content: Stage 01 (`orchestrator`, frozen); request changes in the report.
- `/api/health`, `/api/ready`, the CLI (`migrate`, `bootstrap`, `reset-password`): Stage 01 (`server-core`).
- Dev compose, `docker/e2e/**`, workflows: Stage 01 (`devops-ci`), frozen afterwards; `infra` requests the
  `docker.yml` changes.
- Load tests, sizing numbers, security review: Stage 10 (`e2e`, `security-review`); `infra` marks every size as an
  estimate.
- GHCR publishing: backlog (`release.yml` stays prepared, never run).

## Owned paths
- `infra` (9a): `Dockerfile`, `docker/app/**`, `docker/caddy/**`, `docker-compose.yml`,
  `scripts/{init-env.sh,preflight.sh,smoke-prod.sh}`, `tests/smoke-prod/**` (decision: the orchestrator adds it to the
  ROADMAP ownership map), `README.md`, `docs/DEPLOYMENT.md`, this file.
- 9b (user): no files; results go into the Notes section of this file through the orchestrator.
### Consumes (must not edit)
- `.env.example`, `.env.dev.example`, `.dockerignore`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `nuxt.config.ts`, `server/utils/env.ts`, `server/cli.ts`, `server/database/migrate.ts`,
  `server/database/migrations/**`, `scripts/{build-cli.mjs,detect-ip.sh,with-lock.sh}`, `.github/workflows/**`,
  `docker-compose.dev.yml`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`.

## Tasks
### 9a — App image (`Dockerfile`, `docker/app/**`)
- [x] `# syntax=docker/dockerfile:1`; stages `ffmpeg` (`mwader/static-ffmpeg:9.0.2`), `build` and `runtime` (both
      `node:24-bookworm-slim`, so the native `@node-rs/argon2` binary matches the runtime libc).
- [x] `build`: `npm install -g pnpm@11.20.0` (decision: no corepack download at build time); copy `package.json`,
      `pnpm-lock.yaml`, `pnpm-workspace.yaml`; `RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch`;
      then `COPY . .` and `pnpm install --offline --frozen-lockfile` (the `postinstall` `nuxt prepare` needs the
      sources); then `pnpm build` (runs `nuxt build` and `scripts/build-cli.mjs`). `BLINQ_TEST_HOOKS` is never set.
- [x] `runtime`: `COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/`; `.output` → `/app/.output`;
      `server/database/migrations` → `/app/migrations`; both owned by root and read-only for the app user.
- [x] Non-root user `blinq` with uid/gid 10001 (decision); `/data/recordings` created and owned by it (the named
      volume inherits the owner on first mount); `WORKDIR /app`; `USER 10001:10001`.
- [x] `ENV NODE_ENV=production NITRO_HOST=127.0.0.1 NITRO_PORT=3000 MIGRATIONS_DIR=/app/migrations
      RECORDINGS_DIR=/data/recordings RECORDING_WORK_DIR=/work FFMPEG_PATH=/usr/local/bin/ffmpeg
      FFPROBE_PATH=/usr/local/bin/ffprobe`.
- [x] `docker/app/entrypoint.sh` (POSIX sh, `set -eu`): `node .output/server/cli.mjs migrate && node
      .output/server/cli.mjs bootstrap && exec node .output/server/index.mjs`. It never prints the environment.
- [x] `docker/app/healthcheck.mjs`: `fetch('http://127.0.0.1:' + (process.env.NITRO_PORT ?? 3000) + '/api/ready')`
      with a 2 s timeout; exit 0 on 200, else 1 (the slim image has no curl or wget). `HEALTHCHECK` in the Dockerfile
      mirrors the compose values.
- [x] `ENTRYPOINT ["/app/docker/entrypoint.sh"]`; `STOPSIGNAL SIGTERM`; OCI labels (`org.opencontainers.image.*`,
      version from `package.json` via a build arg).
### 9a — Caddy image and config (`docker/caddy/**`)
- [x] `docker/caddy/Dockerfile`: `caddy:2.11.4-builder` running `xcaddy build v2.11.4 --with
      github.com/mholt/caddy-l4@v0.1.2`, copied into `caddy:2.11.4`; the config files and `entrypoint.sh` are copied in.
      Done: the builder cross-compiles on `$BUILDPLATFORM` (no emulation for multi-platform builds); the final image
      is `caddy:2.11.4-alpine` (the same image as `caddy:2.11.4`), without file capabilities (root, `NET_BIND_SERVICE`).
- [x] `docker/caddy/entrypoint.sh` renders `/run/blinq/Caddyfile` (tmpfs) from fragments and then runs
      `exec caddy run --config /run/blinq/Caddyfile --adapter caddyfile`:
      - TURN on/off: the `layer4` listener wrapper and the TURN site block only when `TURN_DOMAIN` is non-empty.
      - `TLS_MODE=acme`: global `email {$ACME_EMAIL}`; `acme_ca {$ACME_CA}` only when `ACME_CA` is set.
      - `TLS_MODE=internal`: global `local_certs`. `TLS_MODE=files`: `tls {$TLS_CERT_FILE} {$TLS_KEY_FILE}` in both
        site blocks; the script fails fast when a file is missing or unreadable.
      - Any other `TLS_MODE`, or `TURN_DOMAIN` equal to `DOMAIN`, exits 1 with a message naming the variable.
      - After rendering: `caddy validate` (config errors show up in `docker compose logs caddy`).
- [x] Global options: `admin off`; `servers :443 { listener_wrappers { layer4 { @turn tls sni {$TURN_DOMAIN}; route
      @turn { tls; proxy { proxy_protocol v2; upstream 127.0.0.1:{$LIVEKIT_TURN_TLS_PORT} } } } tls } }`
      (TURN variant only). HTTP/3 stays on (default protocols `h1 h2 h3`).
- [x] Main site `{$DOMAIN}`:
      - `header` for all responses: `Strict-Transport-Security "max-age=31536000; includeSubDomains"`, `-Server`.
      - `encode zstd gzip`.
      - `@rtc path /rtc /rtc/*` → `reverse_proxy 127.0.0.1:{$LIVEKIT_HTTP_PORT}` (WebSocket signaling). `/twirp` is
        never proxied to LiveKit, so it reaches the app and 404s.
      - `@webhooks path /api/webhooks/*` → `respond 404`.
      - `@chunks path_regexp ^/api/recordings/[^/]+/chunks/[^/]+$` → `request_body { max_size 20MB }`, then the app.
      - Everything else → `request_body { max_size 1MB }` and `reverse_proxy 127.0.0.1:{$APP_PORT}`.
      - Use mutually exclusive `handle` blocks: two `request_body` directives on one request both wrap the body, so
        the smaller limit would win.
      Done. HSTS is its own `header` directive, because a block that deletes a field is deferred and would miss the
      responses Caddy generates itself (413). `encode` uses an explicit text-type list without `text/event-stream`
      (decision: the waiting-room SSE is never buffered by the encoder).
- [x] Access log: `log { output stdout; format filter { request>uri query { replace access_token REDACTED };
      resp_headers>Set-Cookie delete } }` (JSON). Keep Caddy's default credential redaction (`log_credentials` off).
      Done; the query values `t` and `k` are redacted too (decision: the names of the fragment's invite token and
      room key, in case one ever reaches a query string).
- [x] TURN site block `{$TURN_DOMAIN}` exists only for certificate management: `tls { issuer acme {
      disable_tlsalpn_challenge } }` in `acme` mode (the L4 wrapper takes TLS-ALPN traffic for this SNI; HTTP-01 on
      TCP 80 is used) and `abort` for every HTTP request.
- [x] Health site `http://:{$CADDY_HEALTH_PORT}` with `bind 127.0.0.1` and `respond "OK" 200`. Without `bind` Caddy
      listens on every interface.
- [x] Never configure `trusted_proxies`: Caddy then overwrites any client-sent `X-Forwarded-For`, which the app's
      limiters rely on.
### 9a — LiveKit production config (`LIVEKIT_CONFIG` in `docker-compose.yml`)
- [x] `port: ${LIVEKIT_HTTP_PORT}`, `bind_addresses: [127.0.0.1]` (HTTP/WebSocket only; TURN still binds `0.0.0.0`).
- [x] `rtc`: `tcp_port: ${LIVEKIT_RTC_TCP_PORT}`, `port_range_start`/`port_range_end` from env, `use_external_ip: true`,
      `node_ip: ${LIVEKIT_NODE_IP:-}` (an explicit value wins over STUN; verify that an empty value counts as unset,
      otherwise pass `--node-ip` from a `sh -c` wrapper) (decision), `interfaces.excludes: [docker0]` plus Docker
      bridges (exact names; also consider `ips.excludes` with CIDRs, verify in the ICE candidates).
      Done (decision, verified in the v1.13.7 sources and by running it): with `use_external_ip: true` LiveKit replaces
      an explicit `node_ip` by the STUN result (and cannot start offline), so the config renders `use_external_ip: true`
      only when `LIVEKIT_NODE_IP` is empty and `node_ip` otherwise; an empty `node_ip` is YAML null, i.e. unset.
      Only `docker0` is excluded: LiveKit matches exact names, other bridges have random `br-*` names, and
      `ips.excludes` with Docker's 172.16.0.0/12 would also drop real addresses (AWS's default VPC is 172.31.0.0/16).
      With the node IP set every IPv4 candidate carries it anyway (the smoke call asserts this).
- [x] `turn`: `enabled: true`, `udp_port: ${LIVEKIT_TURN_UDP_PORT}`, `relay_range_start: 30000`,
      `relay_range_end: 40000`; with `TURN_DOMAIN`: `domain`, `tls_port: ${LIVEKIT_TURN_TLS_PORT}`,
      `external_tls: true`, `proxy_protocol: true`; without it `tls_port: 0` (LiveKit refuses a TLS port without a
      domain). Render both cases with Compose
      `${TURN_DOMAIN:+...}` interpolation or a wrapper (decision) and check both with `docker compose config`.
      Done with interpolation: `key:${VAR:+ value}` renders YAML null (LiveKit's default) when the variable is empty.
- [x] `turn.allow_restricted_peer_cidrs: [<node IP>/32]` when the node IP is private (LAN installs, the smoke test);
      otherwise TURN refuses to relay to the SFU. Done whenever `LIVEKIT_NODE_IP` is set (a public address is not
      affected by the list).
- [x] `keys: { ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET} }`; `webhook: { api_key: ${LIVEKIT_API_KEY}, urls:
      [http://127.0.0.1:${APP_PORT}/api/webhooks/livekit] }`.
- [x] `room`: `auto_create: false`, `empty_timeout: 300`, `departure_timeout: 20`, `max_participants: 25`,
      `enable_remote_unmute: false`.
- [x] `limit`: `num_tracks: 2600` (about two full 25-person rooms, tracks in and out) and `bytes_per_sec: 62500000`
      (500 Mbit/s). Both are estimates (decision); Stage 10 replaces them from `docs/PERFORMANCE.md`.
- [x] `logging: { level: info, pion_level: error }`. Strict parsing: one unknown key stops the server, so every change
      is tested with `docker compose up livekit` and its logs.
### 9a — `docker-compose.yml`
- [x] `name: blinq`; services `postgres`, `livekit`, `app` (built from `.`, image `blinq-app:local`), `caddy` (built
      from `docker/caddy`, image `blinq-caddy:local`).
- [x] Host networking for `caddy`, `livekit` and `app`; `postgres` uses `network_mode: none`. No service has `ports:`.
- [x] Required variables use `${VAR:?set VAR in .env (sh scripts/init-env.sh)}`: `DOMAIN`, `APP_SECRET`,
      `RECORDING_ENCRYPTION_KEY`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `POSTGRES_PASSWORD`. Everything else has the
      `.env.example` default via `${VAR:-default}`.
- [x] Each service receives only the variables it needs through `environment:` (decision: no `env_file`, so Caddy
      and Postgres never see app secrets). The app gets `DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}
      @localhost/${POSTGRES_DB}?host=/var/run/postgresql`, `NITRO_HOST=127.0.0.1`, `NITRO_PORT=${APP_PORT}` and
      `LIVEKIT_URL=http://127.0.0.1:${LIVEKIT_HTTP_PORT}`.
      Done, with one change (decision): postgres.js 3.4 ignores `?host=` (it becomes a startup parameter and the client
      dials localhost over TCP, so the first smoke run could not migrate). The app gets `DATABASE_URL=postgres:///
      ${POSTGRES_DB}` plus `PGHOST=/var/run/postgresql`, `PGUSER` and `PGPASSWORD`, which postgres.js reads when the
      URL has no host.
- [x] `postgres`: `postgres:18-alpine`; volumes `pgdata:/var/lib/postgresql` and `pgsocket:/var/run/postgresql` (the
      app mounts `pgsocket` too); `POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256`
      (decision: initdb makes the loopback `host` lines `trust` unless told otherwise); healthcheck
      `pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB` (the init server listens only on the socket, so it
      cannot report healthy too early).
- [x] Healthchecks with `interval`, `timeout`, `retries`, `start_period` and `start_interval`: Postgres as above;
      LiveKit `wget -q -O /dev/null http://127.0.0.1:${LIVEKIT_HTTP_PORT}/`; app `node /app/docker/healthcheck.mjs`
      (`start_period` 120 s for first-boot migrations); Caddy
      `wget -q -O /dev/null http://127.0.0.1:${CADDY_HEALTH_PORT}/`.
- [x] `depends_on`: app → postgres `service_healthy`, livekit `service_healthy`; caddy → app `service_started` (not
      healthy), so certificates are requested while the app is still migrating.
- [x] `restart: unless-stopped` everywhere; logging `json-file` with `max-size: 10m`, `max-file: 5` (YAML anchor).
- [x] Named volumes `pgdata`, `pgsocket`, `caddy_data` (`/data`), `caddy_config` (`/config`), `recordings`
      (`/data/recordings`).
- [x] App tmpfs: `/work:size=${RECORDING_WORK_TMPFS_SIZE:-4g},mode=0700,uid=10001,gid=10001` and `/tmp:size=64m`;
      verify the app user can write both.
- [x] Hardening: `security_opt: [no-new-privileges:true]` and `cap_drop: [ALL]` everywhere; Caddy `cap_add:
      [NET_BIND_SERVICE]`; Postgres `cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]` (decision: the official
      entrypoint needs them before it drops to the `postgres` user); `read_only: true` with tmpfs for `/tmp` (all),
      `/run` (Caddy) and `/var/run` paths as needed; LiveKit runs as `user: "65534:65534"` (decision, verify).
- [x] App: `init: true` (reaps orphaned ffmpeg processes), `stop_grace_period: 30s`.
### 9a — Scripts
- [x] `scripts/init-env.sh`: refuses to overwrite an existing `.env` without `--force`; copies `.env.example`; prompts
      for `DOMAIN`, `TURN_DOMAIN` (default `turn.<DOMAIN>`, empty allowed), `ADMIN_EMAIL`, `ACME_EMAIL`; generates
      `APP_SECRET`, `LIVEKIT_API_SECRET`, `POSTGRES_PASSWORD`, `ADMIN_PASSWORD` from `[A-Za-z0-9_-]`, at least 32
      characters (URL-safe and `$`-free, since Compose expands `$` and `DATABASE_URL` embeds the password);
      `LIVEKIT_API_KEY` = `API` + 12 alphanumerics; `RECORDING_ENCRYPTION_KEY` = base64 of 32 random bytes; reads from
      `/dev/urandom`; `chmod 600 .env`; prints the admin password once and reminds to back up `.env`.
      Non-interactive mode via env (`DOMAIN=... sh scripts/init-env.sh --yes`) for the smoke test.
- [x] `scripts/preflight.sh` (production checks added to the Stage 01 dev part; default mode `prod`, `dev` keeps the
      existing checks): Linux; Docker Engine ≥ 28.0.1 (warn below; blinq publishes no ports) and Compose v2 (fail on
      v1); `.env` present, mode 600, no placeholder values, required variables set; `DOMAIN` and `TURN_DOMAIN` resolve
      (A/AAAA) to `LIVEKIT_NODE_IP` or a local address (warn with the resolved addresses); free ports via `ss -Hltnu`:
      80, 443/tcp, 443/udp, 3478/udp, 7881/tcp, and on loopback 3000, 7880, 5349, 2020; CPU ≥ 2 and RAM ≥ 2 GB (warn
      below 4 vCPU / 4 GB, marked estimates); `net.core.rmem_max` and `wmem_max` ≥ 7500000 (print the `sysctl.d` fix);
      clock synchronized (`timedatectl`); free disk for `/var/lib/docker`. Exit codes: 0 ok, 1 failure, 2 warnings only.
      Done. There was no Stage 01 preflight to extend: `dev` checks Node, pnpm, Docker, Compose v2 and ffmpeg.
- [x] `scripts/smoke-prod.sh` (runs on Linux CI and inside the Docker VM on macOS):
      1. Snapshot listeners (baseline).
      2. Write a throwaway `.env.smoke` with `init-env.sh --yes`: `DOMAIN=blinq.localhost`,
         `TURN_DOMAIN=turn.blinq.localhost` (decision), `TLS_MODE=internal`, `LIVEKIT_NODE_IP` = the VM or runner IP.
      3. `docker compose -p blinq-smoke --env-file .env.smoke up -d --build --wait`.
      4. Run `tests/smoke-prod/*.spec.ts` in `mcr.microsoft.com/playwright:v1.63.0-noble` with `--network host`
         (repo mounted read-only; only pure-JS packages are loaded).
      5. Assert the listeners against the baseline.
      6. Scan all container logs for the secrets from `.env.smoke`.
      7. `down -v` unless `--keep`, and exit non-zero on any failure.
      Done, plus: compose config checks (TURN off, missing `APP_SECRET`), `docker inspect` hardening checks, an app
      restart (idempotent migrate and bootstrap) and `--no-build` for CI (decision). Listeners are read with busybox
      `netstat -tulnp` in a helper container on the host network and PID namespace (no `ss` inside the Docker VM on
      macOS). Ports already taken on the host network are moved (locally the dev stack's 7880 becomes 17880).
- [x] `tests/smoke-prod/` specs:
      - `health`: `/api/health` 200; `/api/ready` 200.
      - `pages`: the login page renders with no CSP violation or console error.
      - `headers`: HSTS, CSP with a nonce, `nosniff`, `Referrer-Policy: no-referrer`, the Permissions-Policy
        override, COOP/CORP; `http://` redirects (308) to `https://`; `Alt-Svc` advertises h3.
      - `routing`: `/api/webhooks/livekit` 404; `/twirp/livekit.RoomService/ListRooms` 404; a 2 MB body to
        `/api/auth/login` gets 413; the TURN name serves the TURN certificate and no HTTP.
      - `call`: a Chromium ↔ Firefox call with media flowing both ways. Until `/m/[slug]` exists (Wave 2) it is a
        transport-level call (decision): room created through RoomService on loopback, tokens minted with
        `livekit-server-sdk`, and `livekit-client`'s UMD build injected into a same-origin page with `bypassCSP`
        (this spec only). Stage 10 switches it to the real UI flow.
      Done, plus: `routing` sends a chunked 2 MB body that Caddy itself refuses (skipped while the login handler is a
      stub that answers first), checks both certificates against the internal root and runs a STUN Binding over TLS
      on the TURN name, whose mapped address proves PROXY protocol end to end; `call` asserts that every IPv4 SFU
      candidate is `LIVEKIT_NODE_IP` with a port from the configured range, and a second, relay-only Chromium ↔
      Firefox call goes through LiveKit's TURN/UDP to the SFU's private address (`allow_restricted_peer_cidrs`).
      Browsers reject the internal CA for TURN over TLS (Caddy logs `unknown certificate authority`), so a
      relay-only call over TURN/TLS is left to 9b.
### 9a — Docs
- [x] `README.md`: fill every `TODO(stage-09a)` section — requirements (estimates), ports table, DNS, firewall
      (including 30000–40000/udp on 1:1-NAT clouds), install, first login and removing `ADMIN_PASSWORD`, upgrade,
      backup and restore (including the recording key), troubleshooting summary, links to `docs/DEPLOYMENT.md`.
- [x] `docs/DEPLOYMENT.md`: replace every `TODO(stage-09a)` with verified commands; leave `TODO(stage-10)` sizing.
### 9a — CI coordination and requests (in the report)
- [x] `docker.yml` (frozen; exact diff requested): Buildx with GHA cache; native `ubuntu-24.04` and
      `ubuntu-24.04-arm` matrix builds of both images (decision); `docker compose config -q` with `.env.example` plus
      test secrets; `sh scripts/smoke-prod.sh` on amd64; logs uploaded on failure.
      Done in `docker.yml` directly (infra was allowed to edit it), plus a check that argon2, ffmpeg and caddy-l4 load
      in each architecture's image.
- [x] `package.json`: `pnpm build` runs `pnpm vendor` first once `scripts/vendor-assets.mjs` exists (Wave 2), so image
      and local builds match. `.dockerignore`: anything the clean build shows is missing or leaking.
      Done: `build` already runs `pnpm vendor`, so no change is needed. `.dockerignore` (edited by infra) also leaves
      out `docs`, `tests`, `logs`, `docker/caddy`, `docker/e2e`, the compose files and locally vendored assets.
- [x] `docs/ROADMAP.md`: add `tests/smoke-prod/**` to the `infra` row. The merge gate adds `sh scripts/smoke-prod.sh`.
      Requested in the report.
### 9b — Real server (user)
- [ ] VM with a public IPv4 (Ubuntu 24.04 LTS or Debian 13, 4 vCPU / 8 GB as an estimate), Docker Engine ≥ 28.0.1.
- [ ] DNS A (and AAAA) records for `DOMAIN` and `TURN_DOMAIN`; firewall per `docs/DEPLOYMENT.md`.
- [ ] Follow README verbatim. Write down every step that failed, was unclear or needed an extra command.
- [ ] Check certificates, redirect, HSTS, external port scan, relay-only call, reboot survival, a backup and restore
      dry run and an upgrade (commands under Tests).

## Tests
- 9a smoke: `tests/smoke-prod/{health,pages,headers,routing,call}.spec.ts` via `sh scripts/smoke-prod.sh`.
- Static checks: `docker compose config -q`; `sh -n` and `shellcheck` on `scripts/*.sh` and `docker/**/*.sh`;
  `caddy adapt` of every rendered variant (TURN on/off × `acme`/`internal`/`files`) in the Caddy image.
- Clean build: `git archive --format=tar HEAD | docker build -t blinq-app:clean -` (only committed files; catches
  `.dockerignore` and stray-workspace problems).
- Multi-arch: `docker buildx build --platform linux/arm64` (native on the Mac) and `linux/amd64` for both images.
- Listener check: `ss -Htulpn` diffed against the baseline. Expected new listeners: `*:80/tcp`, `*:443/tcp`,
  `*:443/udp`, `*:3478/udp`, `*:7881/tcp`, `*:5349/tcp`, UDP in 50000–60000 and 30000–40000 (during calls), and
  `127.0.0.1` only for 3000, 7880 and 2020. Nothing else: no 2019 (Caddy admin), no 5432.
- 9b (user): `openssl s_client -connect DOMAIN:443 -servername DOMAIN` and `-servername TURN_DOMAIN` (both
  `Verify return code: 0`); `curl -sI http://DOMAIN/` (308 to https); `curl -sI https://DOMAIN/` (HSTS);
  `nmap -Pn -p- DOMAIN` from another machine; relay-only call from a client with outbound UDP blocked plus Firefox
  `media.peerconnection.ice.relay_only=true` (`about:webrtc` shows a relay candidate over TLS on 443).

## Definition of Done
### 9a
- [x] [agent-manual] `smoke-prod.sh` passes locally (Docker VM on macOS) — evidence: `sh scripts/smoke-prod.sh`
      output in the report.
- [ ] [user] `smoke-prod.sh` passes in CI — evidence: docker.yml smoke job (first run after the user pushes).
- [x] [auto] `ss -tulpn` shows only the intended public listeners and loopback-only 3000/7880/2020 — evidence:
      listener assertion in `scripts/smoke-prod.sh`.
- [x] [agent-manual] A clean `docker build` works from committed files only — evidence:
      `git archive --format=tar HEAD | docker build -t blinq-app:clean -`.
- [x] [auto] Images build for linux/amd64 and linux/arm64 — evidence: docker.yml matrix;
      `docker buildx build --platform linux/arm64` locally.
- [x] [auto] Postgres has no network and is reachable only through the socket — evidence: smoke `docker inspect`
      check (`NetworkMode` = `none`) and no 5432 listener.
- [x] [auto] Containers are hardened (non-root app, `CapDrop` ALL, `no-new-privileges`, read-only roots) — evidence:
      `docker inspect` assertions in `scripts/smoke-prod.sh`.
- [x] [auto] A missing required variable stops `up` with a message naming it — evidence: smoke step with
      `APP_SECRET` removed (`docker compose config` fails naming `APP_SECRET`).
- [x] [auto] HSTS, CSP and the other headers are present — evidence: `tests/smoke-prod/headers.spec.ts`.
- [x] [auto] `/api/webhooks/*` and `/twirp/*` are 404 publicly; a 2 MB body gets 413 — evidence:
      `tests/smoke-prod/routing.spec.ts`.
- [x] [auto] A two-browser call works through Caddy and LiveKit in host networking — evidence:
      `tests/smoke-prod/call.spec.ts`.
- [x] [auto] No secret from `.env.smoke` appears in any container log — evidence: log scan in `scripts/smoke-prod.sh`.
- [x] [agent-manual] `docker compose config -q` passes for TURN on and off, and every Caddy variant adapts — evidence:
      commands under Tests.
- [x] [agent-manual] `init-env.sh` output passes `preflight.sh` and env validation; `.env` is mode 600 — evidence:
      `sh scripts/init-env.sh --yes && sh scripts/preflight.sh; stat -c %a .env`.
- [x] [agent-manual] Migrate and bootstrap run on every start, and a restart is idempotent — evidence:
      `docker compose restart app` in the smoke stack, then `/api/ready` 200 and a single admin.
- [x] [agent-manual] README and `docs/DEPLOYMENT.md` have no `TODO(stage-09a)` left — evidence:
      `grep -rn 'TODO(stage-09a)' README.md docs` prints nothing.
- [x] [auto] `lint`, `check:english` and actionlint are green — evidence: ci.yml.
### 9b
- [ ] [user] Valid certificates for `DOMAIN` and `TURN_DOMAIN` — evidence: both `openssl s_client` checks.
- [ ] [user] HTTP redirects to HTTPS and HSTS is present — evidence: `curl -sI` output.
- [ ] [user] A relay-only call works with UDP blocked (TURN/TLS on 443) — evidence: `about:webrtc` screenshot.
- [ ] [user] The external port scan shows only the documented public ports — evidence: `nmap` output.
- [ ] [user] README followed verbatim; every deviation is fixed in the docs — evidence: 9b notes below.
- [ ] [user] The stack survives a reboot, and a backup restores onto a fresh volume — evidence: 9b notes below.

## Notes and gotchas
- Host networking is Linux-only in production. On macOS the "host" is the Docker VM, which is fine for the smoke
  test but never for serving users.
- TURN/TLS is always advertised as `turns:TURN_DOMAIN:443`; there is no way to use another port. PROXY protocol lets
  LiveKit see the real client address (Firefox rejects the loopback XOR-MAPPED-ADDRESS otherwise).
- Port 5349 listens on all interfaces but accepts only PROXY-protocol connections from loopback; the firewall must
  keep it closed anyway.
- `POSTGRES_PASSWORD` only takes effect when the data volume is created. Changing it later needs `ALTER USER` inside
  the container.
- `pg_isready` succeeds without authenticating, so the healthcheck works with `scram-sha-256` everywhere.
- ACME issuance needs 80/tcp and correct DNS before the first start; use `ACME_CA` (Let's Encrypt staging) while
  experimenting to avoid rate limits.
- `bypassCSP` exists only in the transport-level smoke call; every other spec fails on CSP violations.
- 9a results (infra, 2026-09-28, macOS Docker Desktop 29.8 / Compose 5.5, arm64), run on `main` (62f7d34, server-core
  merged) plus this branch, because the branch base 2f8fe39 still has the W0a stubs of `/api/ready` and bootstrap:
  - `sh scripts/smoke-prod.sh`: passed with 82 checks and 14 of 14 specs; `up --wait` 6–13 s with built images.
    `LIVEKIT_HTTP_PORT` moved to 17880 there because the dev stack publishes 127.0.0.1:7880 inside the Docker VM;
    preflight skipped (macOS).
  - `git archive HEAD | docker build` (app 703 MB, Caddy 147 MB); `docker buildx build --platform linux/arm64` and
    `linux/amd64` (Caddy cross-compiled, the app emulated) for both images.
  - LiveKit v1.13.7 started with the rendered config for TURN on/off × node IP set/empty; all six Caddy variants
    adapt; `init-env.sh --yes` output passes `preflight.sh` on Linux (the Docker VM, exit 2: UDP buffers, no
    `timedatectl`) and `parseEnv`; `.env` mode 600; §9 backup, wipe and restore verified on the smoke stack.
  - Not verified here (9b or CI): real ACME certificates (HTTP-01 for `TURN_DOMAIN`), TURN over TLS with trusted
    certificates in a browser, STUN node-IP detection on a 1:1-NAT cloud, the CI jobs.
- 9b results (filled in by the orchestrator from the user's notes): —
