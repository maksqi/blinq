# Testing

How blinq is tested: which layer a test belongs to, where it lives, how to run it, and the rules that keep parallel
agents from breaking each other's runs. Tools: Vitest 5 with `@nuxt/test-utils` 4.3, and Playwright 1.63. The
security properties the tests must prove are listed in [`SECURITY.md` §10](SECURITY.md#10-verification). Every stage
file names the test or command that proves each DoD item.

Owner: `devops-ci` from W0b on; the orchestrator after Wave 3.
`(decision)` marks a choice this document makes where the plan left it open.

## 1. Test pyramid

| Layer | Tool | Runs against | Belongs here | Does not belong here |
|---|---|---|---|---|
| Unit | Vitest `unit` (Node) | nothing: no Postgres, LiveKit, SMTP or network | Pure logic: HKDF derivations with test vectors, app envelope and BLQ1 encoding, grid math, hotkey matcher, subscription policy, permission matrix, token grants, limiter math, env parsing, zod schemas, retention math with an injected clock | Anything that needs a running service, a browser or the Nuxt runtime |
| Component | Vitest `nuxt` (happy-dom) | the Nuxt runtime, in-process | Components and composables that need auto-imports, the router, Pinia or `useState` | Logic that fits a plain module in `app/lib` |
| API | Vitest `api` | the built test server, Postgres, Mailpit, a fake LiveKit RoomService | Every HTTP rule: validation, error codes, authorization matrix, CSRF, cookies, rate limits, SSE, webhooks, DB side effects, email content | Browser behavior |
| E2E | Playwright | the test build behind the e2e Caddy, the dev LiveKit | What only browsers prove: media and E2EE between browsers, UI flows, CSP, layout, recording end to end, timing | Rules an API test already proves |
| Manual | people | real devices, a real VM | The browser matrix (§9) and Stage 9b | Anything that can be automated |

- Push logic down. When an E2E spec needs many cases, move the decision into a pure function and table-test it there.
- A bug fix starts with a failing test in the lowest layer that reproduces it.
- DoD evidence points at a file (`— evidence: tests/api/auth/login.test.ts`) or a command
  (`` — evidence: `pnpm test:e2e -- call/e2ee` ``).

## 2. Commands

| Command | What it runs |
|---|---|
| `pnpm test` | Vitest `unit` project (`pnpm test:watch` to watch, `pnpm test --coverage` for V8 coverage) |
| `pnpm exec vitest run --project nuxt` | Nuxt-environment component tests (no package script yet) |
| `sh scripts/with-lock.sh pnpm test:api` | API tests; the global setup builds the test server first |
| `sh scripts/with-lock.sh pnpm build:test` | the test build (`BLINQ_TEST_HOOKS=1`) that E2E runs against |
| `pnpm test:e2e` | `sh scripts/e2e.sh`: on macOS the Docker runner (§6.2), on Linux and in CI the host mode; takes the lock itself |
| `pnpm test:e2e --project=firefox call/e2ee` | one project, spec paths matching `call/e2ee` (arguments go to Playwright) |
| `pnpm test:e2e:docker` | the Docker runner directly, on any OS (`sh scripts/e2e-docker.sh`) |
| `pnpm exec playwright show-report` | the last HTML report; `pnpm exec playwright show-trace <zip>` opens a failure trace |
| `pnpm exec playwright install chromium firefox webkit` | host mode only (Linux, CI, `E2E_HOST=1`); the Docker runner brings its browsers |
| `pnpm check:english` | fails on any Cyrillic character in tracked and new files |

Arguments: pnpm 11 forwards everything after the script name, including a literal `--`.
- Vitest drops every argument after `--`, so `pnpm test -- grid` silently runs the whole project. Write `pnpm test grid`.
- Playwright reads arguments after `--` as file filters, so the evidence form `pnpm test:e2e -- call/e2ee` works.

## 3. Where tests live

```
app/lib/**, app/composables/**, shared/**      <name>.test.ts next to the code             unit
server/services/**, server/utils/**            <name>.test.ts next to the code             unit
server/database/**, scripts/**                 <name>.test.ts (schema and script helpers)  unit
app/**                                         <Name>.nuxt.test.ts                         nuxt
tests/api/<domain>/*.test.ts                   e.g. tests/api/auth/login.test.ts           API
tests/api/_harness/                            global setup, client, factories, Mailpit, webhook signer
tests/e2e/<area>/*.spec.ts                     e.g. tests/e2e/call/e2ee.spec.ts            E2E
tests/e2e/fixtures/                            Playwright fixtures, combined with mergeTests
tests/fixtures/media/                          reference and malicious media files
```

- **Never** put a test file under `server/api`, `server/routes`, `server/middleware`, `server/plugins` or
  `server/tasks`. Nitro scans them and would register the file as a route, middleware, plugin or task.
- `*.nuxt.test.ts` runs only in the `nuxt` project. A plain `*.test.ts` never needs the Nuxt runtime.
- Time and randomness are injected (`Clock` from `server/contracts/index.ts`, `now()` parameters). Fakes implement the
  interfaces in `server/contracts/**` and `app/lib/contracts/**` instead of mocking module paths.
- Crypto code has the fixed test vectors from `docs/API.md` plus tamper cases: a flipped bit, truncation, a wrong AAD.
- Non-ASCII test data (Cyrillic layouts, bidi characters) is written as `\u` escapes or built with
  `String.fromCodePoint`, never as literal characters.

## 4. Vitest projects (`vitest.config.ts`)

| Project | Includes | Environment | Notes |
|---|---|---|---|
| `unit` | `**/*.test.ts` in `app/lib`, `app/composables`, `shared`, `server/services`, `server/utils`, `server/database`, `scripts` | `node` | Aliases `~`, `@`, `~~` and `#shared` resolve as in Nuxt; runs with the dev stack stopped |
| `nuxt` | `app/**/*.nuxt.test.ts` | `nuxt` (happy-dom) | `mountSuspended`, `mockNuxtImport`, `registerEndpoint` from `@nuxt/test-utils/runtime`; slow to start, keep them few |
| `api` | `tests/api/**/*.test.ts` | `node` | `globalSetup: tests/api/_harness/global-setup.ts`; test timeout 30 s, hook timeout 240 s (covers the build) |

`node_modules`, `.claude`, `.nuxt` and `.output` are excluded everywhere, so worktrees never leak tests into each other.

## 5. API tests

### 5.1 Harness (`tests/api/_harness/`, owner `server-core`)

`global-setup.ts` runs once per `pnpm test:api`:
1. Builds the test server (`pnpm build:test`, under the lock).
2. Recreates a dedicated database, the worktree's database name plus `_test_api` (`blinq` → `blinq_test_api`, the
   Stage 01 name that CI uses; `blinq_auth` → `blinq_auth_test_api`) (decision), and migrates it with the bundled CLI
   (`.output/server/cli.mjs migrate`).
3. Starts `.output/server/index.mjs` on a free port with an explicit environment (the built server does not read
   `.env`): that database, `LIVEKIT_URL=fake://local`, SMTP pointing at Mailpit, `PUBLIC_URL` set to its own origin.
4. Hands the base URL to test files with `provide('apiBaseUrl')` (`inject('apiBaseUrl')` in tests); stops on teardown.

All files share one server, limiter store and settings cache. So API files run one at a time (single fork,
`fileParallelism: false`), and tests that change admin settings restore them in `afterEach`.

Helpers next to it (`tests/api/_harness/index.ts`): `createClient()` (an `ApiClient` with a cookie jar and its own
`X-Forwarded-For` from `uniqueIp()`), `expectApiError()`; factories (`createUser`, `createAdmin`, `createSession`,
`loginAs`, `createRoom`, `createRoomInvite`, `createInvite`, `createMeeting`, `createGuestSession`,
`createParticipant`); a Mailpit client (`waitForMessage`, `expectNoMessage`, `extractFragmentToken`); `signWebhook()`.

### 5.2 Rules

- **Unique data per test.** Emails like `u-<uuid>@example.test`, unique room names. No test depends on another test's
  data or on order, and none asserts on global counts (all users, all rooms, all emails).
- **Rate limits.** Every test sends its own `X-Forwarded-For` from `uniqueIp()`: a random /64 in `2001:db8::/32`
  (limiters key IPv6 by /64) or an address in `198.51.100.0/24` or `203.0.113.0/24`. The app trusts the header only
  because it is reachable solely from loopback behind Caddy.
- **CSRF.** Mutations send `Origin: <apiBaseUrl>`. CSRF tests send a foreign `Origin` or `Sec-Fetch-Site: cross-site`
  and expect `CSRF_REJECTED`.
- **Assertions.** Check the status and `data.code` (`shared/utils/error-codes/*`), never message text.
- **Time.** The built server's clock is never moved (Stage 01 decision). Expiry and retention tests age rows in the
  test database instead, for example by setting `expires_at` in the past. Pure time math is unit-tested with a `Clock`.

### 5.3 Email (Mailpit)

- The dev stack's Mailpit catches every message: SMTP `127.0.0.1:1025`, API `http://127.0.0.1:8025/api/v1`, UI
  `http://localhost:8025`.
- Find mail by its unique recipient (`GET /api/v1/search?query=to:"<address>"`), fetch `GET /api/v1/message/<ID>`, and
  take the token from the link fragment (`/invite#<token>`, `/verify-email#<token>`, `/reset-password#<token>`).
- Poll with a timeout (delivery is asynchronous). "No enumeration" tests assert that nothing arrived.
- Never call `DELETE /api/v1/messages`: every agent shares this Mailpit.

### 5.4 LiveKit

- **Fake (default).** `LIVEKIT_URL=fake://local` selects an in-memory `RoomServiceAdapter` (interface in
  `server/contracts/index.ts`) that records every call. `GET /api/__test/livekit-calls` returns them as
  `[{ method, args, at }]` in test builds only (proposed in [`API.md` §11](API.md#11-test-only-none-in-production),
  pending orchestrator approval). Authorization-matrix and host-action tests assert on the calls for their own room:
  `removeParticipant`, `updateParticipant` with the complete permission object, and `updateRoomMetadata` only through
  `publishRoomState`.
- **Real (a few tests).** Files named `*.livekit.test.ts` run only when `API_LIVEKIT_URL` is set, and the harness then
  starts the server against it (dev: `http://127.0.0.1:7880`) (decision). They cover what the fake cannot: room
  create/list/delete with `auto_create: false`, the metadata round trip, errors for missing rooms and participants.
  CI runs them as a small separate job.
- The dev LiveKit is shared: use unique room names, delete your rooms in teardown, never touch rooms you did not create.

### 5.5 Webhooks

LiveKit posts `Content-Type: application/webhook+json` with an `Authorization` JWT whose `sha256` claim is the base64
SHA-256 of the raw body. Tests sign the same way, so the app's `WebhookReceiver.receive(body, authHeader)` accepts them:

```ts
import { createHash } from 'node:crypto'
import { AccessToken } from 'livekit-server-sdk'

export async function signWebhook(body: string, apiKey: string, apiSecret: string): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret)
  token.sha256 = createHash('sha256').update(body).digest('base64')
  return token.toJwt()
}
```

Build bodies in LiveKit's JSON shape with `new WebhookEvent({ event: 'participant_joined', id, room: { name } })
.toJsonString()` (`WebhookEvent` from `livekit-server-sdk`). Signature tests also send a wrong secret, a modified body
and a replayed event id (must be deduplicated).

## 6. E2E tests (Playwright)

### 6.1 What E2E runs against

Both modes run the same flow (`scripts/e2e.sh`): a test build behind the e2e Caddy (`docker/e2e/Caddyfile`), with app
and LiveKit signaling on one origin.

**Docker runner** (`scripts/e2e-docker.sh`; the only local mode, §6.2). Every service shares the runner container's
network namespace (`docker/e2e/runner.compose.yml`), and no port is published on the host:

```
runner container: Playwright browsers, the fixtures, the test build (node .output/server/index.mjs)
  + in its network namespace: Caddy :8080, LiveKit :7880/:7881/:7882, Postgres :55432, Mailpit :1025/:8025
Playwright ─► Caddy http://localhost:8080 (E2E_BASE_URL)
                ├─ /rtc*            ─► LiveKit 127.0.0.1:7880 (signaling)
                ├─ /api/webhooks/*  ─► 404 (LiveKit calls the app directly)
                └─ everything else  ─► the test build on 127.0.0.1:3000
Browsers ══ media: the runner's eth0 address, UDP 7882 / TCP 7881 ══► LiveKit
LiveKit ─ webhooks ─► http://127.0.0.1:3000/api/webhooks/livekit
Fixtures ─► the app on 127.0.0.1:3000, Postgres 127.0.0.1:55432, Mailpit 127.0.0.1:8025, LiveKit 127.0.0.1:7880
```

**Host mode** (Linux and CI, or `E2E_HOST=1`): browsers on the host, the shared dev stack, the app on your port.

```
Playwright ─► e2e Caddy (E2E_BASE_URL, default http://localhost:8080; docker/e2e/compose.yml)
                ├─ /rtc*            ─► dev LiveKit :7880 (signaling)
                ├─ /api/webhooks/*  ─► 404 (LiveKit calls the app directly)
                └─ everything else  ─► the test build on your PORT (node .output/server/index.mjs)
Browsers ══ media: LAN IP from scripts/detect-ip.sh, UDP 7882 / TCP 7881 ══► dev LiveKit
dev LiveKit ─ webhooks ─► http://host.docker.internal:<PORT>/api/webhooks/livekit (PORT 3000–3005)
```

On native Linux (CI) `host.docker.internal` does not reach the host's loopback interface, so `docker/e2e/compose.yml`
adds a small forwarder service (`docker/e2e/host-gateway.Caddyfile`) that relays traffic from the Docker network to the
app on the host. It also makes LiveKit webhooks reach the app in CI.

- The test build (`pnpm build:test`) is the production build plus the harness page `/dev/call` and
  `window.__blinqTest` (and `GET /api/__test/livekit-calls` if approved, which only API tests use).
- App and signaling are same-origin, so the production CSP (`connect-src 'self'`) applies unchanged. The CSP additions
  for `localhost:7880` exist only in `nuxt dev`.
- The app runs with `PUBLIC_URL` = `E2E_BASE_URL` and `LIVEKIT_PUBLIC_URL` = the same origin with `ws://`, so links,
  cookies and CSRF checks use the Caddy origin. `http://localhost` is a secure context, so WebCrypto and E2EE work.
- LiveKit advertises a non-loopback address because Firefox rejects loopback ICE candidates: the runner's eth0
  address (detected when its LiveKit starts), or the LAN IP in host mode. E2E runs with 1 worker; every test creates
  its own rooms.
- All E2E traffic reaches the app from one IP (Caddy: loopback in the runner, the Caddy container in host mode), so
  per-IP limits are a shared budget across a whole run: for example `auth-ip` allows 10 attempts per minute. Keep
  failing-login specs few, or give them distinct accounts and wait out windows instead of relying on retries. Fixtures
  that call the app directly on `127.0.0.1` come from loopback, so the app trusts their `X-Forwarded-For`
  (`server/utils/client-ip.ts`) in both modes.

### 6.2 Running locally

Every local Playwright run happens inside Docker (decision, 2026-10-22). Browsers on a Mac play the fake-media tone
and remote audio through its speakers (Playwright mutes only headless Chromium), so never run `pnpm test:e2e`,
`pnpm exec playwright test` or `E2E_HOST=1` on the maintainer's Mac. Lint, typecheck, Vitest, API tests and builds
stay on the host.

```sh
sh scripts/e2e-docker.sh --project=chromium tests/e2e/<area>
# the PR selection of e2e.yml:
sh scripts/e2e-docker.sh --project=chromium --project=firefox --project=webkit-ui --project=mobile-chromium \
  --grep-invert @nightly
```

On macOS `sh scripts/e2e.sh …` is the same command: it hands over to `scripts/e2e-docker.sh`. Docker must be running;
the shared dev stack and your `pnpm dev` server are not involved (the runner brings its own services and uses no host
port). The script:
1. holds the machine-wide lock (`scripts/with-lock.sh`) for the whole run;
2. builds the runner image `docker/e2e/runner.Dockerfile` (build context `docker/e2e/` only): the Playwright 1.63.0
   noble image pinned by digest (it must match `@playwright/test` in `pnpm-lock.yaml`), static ffmpeg/ffprobe 9 from
   `mwader/static-ffmpeg:9.0.2`, psql, the docker CLI, PulseAudio, an Xvfb display and pnpm 11.20;
3. starts `docker/e2e/runner.compose.yml` (project `blinq-e2e-docker`): the runner plus Caddy, LiveKit v1.13.7,
   Postgres 18 (data on tmpfs) and Mailpit in its network namespace, and waits until all are healthy;
4. runs `scripts/e2e.sh` in runner mode inside the runner: `pnpm install --frozen-lockfile` into the runner's
   `node_modules` volume, `pnpm build:test`, a fresh `blinq_e2e` database over TCP, `migrate` and `bootstrap` with the
   bundled CLI, the app on `127.0.0.1:3000` with the E2E environment, then `pnpm exec playwright test` with your
   arguments;
5. removes the containers on exit, also after a failure or Ctrl-C (the volumes stay). The exit code is Playwright's.

The first run of a checkout installs and builds from scratch (a few minutes); later runs reuse the volumes.

| Variable | Effect |
|---|---|
| `E2E_SKIP_BUILD=1` | reuses the test build in the `.output` volume; fails unless it is a Linux test build |
| `E2E_DB_NAME` | the test database (default `blinq_e2e`) |
| `E2E_LIVEKIT_SEND_SIDE_BWE=true` | starts the runner's LiveKit with `rtc.congestion_control.use_send_side_bwe` (A/B runs; default `false`) |
| `E2E_BUILD_HEAP_MB` | Node heap for the build in the runner (default 4096; Docker Desktop's VM is shared with other containers) |
| `E2E_HOST=1` | macOS: the old host mode with host browsers, which play audio through the speakers |

The runner receives the caller's `E2E_*`, `SWARM_*`, `PLAYWRIGHT_*` and `PW_*` variables, `CI`, `DEBUG` and
`NO_COLOR`. Its ports are fixed (app 3000, Caddy 8080): `E2E_APP_PORT` and `E2E_HTTP_PORT` apply to host mode only.
`E2E_NIGHTLY_BROWSERS=1` is refused (§6.3).

How the runner works:
- **Mounts.** The checkout is mounted at its own absolute path, so `logs/e2e/`, `test-results/`,
  `playwright-report/`, `.data/e2e/` and every absolute path are the same inside and outside. `node_modules`,
  `.output` and `.nuxt` are Linux-only volumes named `blinq-e2e-<hash of the checkout path>-*` (the script prints the
  prefix): the host's macOS copies (`@node-rs/argon2`, rolldown, esbuild and other native packages) are never
  touched, and a worktree never shares a build with the main checkout. The pnpm store volume `blinq-e2e-pnpm-store` is
  shared. To free the space of a removed worktree: `docker volume rm $(docker volume ls -q --filter name=<prefix>)`.
- **Build.** Nitro deletes and recreates its output directory, which fails on a mount point, so in the runner it
  builds into a container directory (a global `.nuxtrc` in the runner's `HOME`) and `scripts/e2e.sh` copies the result
  into the `.output` volume.
- **Audio.** PulseAudio runs in the runner with a single null sink (`docker/e2e/runner-init.sh`). Firefox plays audio
  only through PulseAudio, and without a sound server its `AudioContext` never leaves `suspended`: the mic chain falls
  back to the raw microphone (F-060) and the Web Audio specs (`media/mic-chain`, RNNoise, gain) fail. Nothing is
  played on a real device.
- **Display.** `runner-init.sh` also starts Xvfb on `:99` (`DISPLAY` is set in the image). Headless Firefox on Linux
  creates WebGL contexts only through an X display: without one `getContext('webgl2')` fails, background blur is
  reported as unsupported, and the Firefox blur specs (`media/blur-swap`, `media/persistence`,
  `media/no-external-requests`, `security/external-requests`) cannot run. No Firefox pref or EGL setting changes that
  in headless mode. With the display, Mesa's llvmpipe renders WebGL2 on the CPU. The browsers stay headless; headless
  Chromium (SwiftShader) and WebKit ignore the display. A Linux CI runner needs the same (`xvfb-run` or `DISPLAY`).
- **Logs.** The app writes `logs/e2e/app.log`; the runner's Caddy writes its access log straight into
  `logs/e2e/caddy.log` (`E2E_ACCESS_LOG_OUTPUT`), so the log scan of §6.5 sees a request as soon as it is logged.
- **Containers.** The runner mounts the Docker socket: `security/log-scan` reads `docker logs` of the runner's LiveKit
  and Postgres, and `rooms/key-leak` runs `pg_dump` in that Postgres. The runner sets `E2E_LIVEKIT_CONTAINER` and
  `E2E_POSTGRES_CONTAINER` (`blinq-e2e-docker-livekit-1`, `blinq-e2e-docker-postgres-1`); without them the specs use
  the dev stack's `blinq-dev-livekit-1` and `blinq-dev-postgres-1` (host mode). The load swarm reads the same
  LiveKit variable unless `SWARM_SFU_CONTAINER` is set.
- **Load runs.** `SWARM_BOTS=12 SWARM_DURATION=120 sh scripts/e2e-docker.sh --config tests/load/playwright.config.ts`
  runs the swarm in the runner (`E2E_HTTP_PORT` is not needed there). Browsers and the SFU share the namespace, so
  media never crosses eth0 and the swarm's SFU Mbit/s columns read about 0; its CPU and memory columns are real.

Host mode (`sh scripts/e2e.sh …` on Linux and in CI; `E2E_HOST=1` on macOS) needs the shared dev stack
(`pnpm dev:deps`) and a set-up worktree (§7). Stop your `pnpm dev` server first (the E2E server uses your port). The
script holds the lock, builds the test build, recreates and migrates the `blinq_e2e` database in `blinq-dev-postgres-1`,
starts `.output/server/index.mjs` with the E2E environment (§6.1), starts the e2e Caddy (`docker/e2e/compose.yml`,
project `blinq-e2e`), waits for health, runs Playwright with your arguments, and stops everything on exit.
Variables: `E2E_SKIP_BUILD=1` reuses the last test build; `E2E_APP_PORT` overrides the app port; `E2E_DB_NAME`
overrides the database name; `E2E_HTTP_PORT` (default 8080) moves the e2e Caddy, and with it `E2E_BASE_URL`,
`PUBLIC_URL` and `LIVEKIT_PUBLIC_URL`, to another port when something else holds 8080.

Artifacts (both modes): `test-results/` (trace, video and screenshot kept on failure), `playwright-report/`, and the
logs in `logs/e2e/{app,caddy}.log`. `pnpm exec playwright show-report` and `show-trace` only open the results and
start no test browser, so they may run on the host.

### 6.3 Projects and fake media (`playwright.config.ts`)

| Project | Engine | Media setup | Runs |
|---|---|---|---|
| `chromium` | Desktop Chrome | flags `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`, `--auto-select-desktop-capture-source=Entire screen`, `--auto-accept-this-tab-capture`, `--autoplay-policy=no-user-gesture-required` | all specs |
| `firefox` | Desktop Firefox | prefs `media.navigator.streams.fake` and `media.navigator.permission.disabled` = true, `permissions.default.camera` and `permissions.default.microphone` = 1, `media.autoplay.default` = 0 | all specs |
| `webkit-ui` | Desktop Safari (WebKit) | mock capture devices through `context.grantPermissions(['camera', 'microphone'])` (Playwright ≥ 1.62) | `@ui` specs |
| `mobile-chromium` | Pixel 7 emulation | the Chromium flags | `@responsive` specs |

- Locally all four projects run on the runner's Linux builds of Chromium, Firefox and WebKit, as in CI. The nightly
  projects of `E2E_NIGHTLY_BROWSERS=1` are not run locally, and `scripts/e2e-docker.sh` refuses the variable: `msedge`
  has no Linux arm64 build, and `webkit` needs macOS WebKit, which no container provides.
- Linux WebKit has no `RTCRtpScriptTransform`, so it cannot do E2EE. There the call page must show the
  unsupported-browser screen and never connect (a useful `@ui` check). E2EE on WebKit runs only in the non-blocking
  macOS WebKit nightly job.
- Fake devices produce moving video and a tone. Specs assert decoded frames and non-silent audio, never pixel content.
- Screen share uses the `useFakeScreenSource` hook (a 1920×1080 canvas), not the desktop picker, so it is deterministic.
- For a Chromium ↔ Firefox call in one test, `joinAs` launches the other browser with the same flags or prefs.
- Nightly adds Edge (`channel: 'msedge'`, nightly.yml on Linux x64). macOS WebKit with E2EE is checked by hand (§9).
- Tags, set with the `tag` option (`test('login renders', { tag: '@ui' }, async ({ page }) => { … })`): `@ui` (no media
  or E2EE; also runs in `webkit-ui`), `@responsive` (also runs in `mobile-chromium`), `@nightly` (nightly.yml only; PR
  runs pass `--grep-invert @nightly`) (decision).

### 6.4 Fixtures (`tests/e2e/fixtures/`)

Specs import `test` and `expect` from `tests/e2e/fixtures/index.ts`. It exports
`test = mergeTests(base, livekit, join, media, recording)` (each file exports its own `test.extend(...)`) and re-exports
`expect`.

| File | Owner | Provides |
|---|---|---|
| `base.ts` | `devops-ci` | the global guards (§6.5), `secrets.track(value)`, the per-test `allowConsoleErrors` option |
| `livekit.ts` | `call-core` | `joinAs(role, options)` |
| `media.ts` | `media-fx` | processor helpers (blur, noise suppression) |
| `recording.ts` | `recording-client` | ffprobe/volumedetect helpers, forced MIME, chunk-failure injection |
| `join.ts` | `rooms-backend` | the `rooms` fixture: DB-backed users, rooms, invites and joins through the real API (creates `call_participants` rows) |

Call-core's fake-device helpers, first-frame waits and `getStats` polling live in `livekit.ts`. W0a commits
`livekit.ts`, `media.ts` and `recording.ts` as stubs, so `index.ts` (frozen after W0b) does not change when `call-core`
implements them (decision). Other areas add fixture files through a report request.

**`joinAs(role, options)`** (`livekit.ts`): LiveKit-only peers for call-core behavior. `role` is `host`, `cohost` or
`participant`. Options (`JoinOptions`): `name`, `kind` (`user` or `guest`), `room` (reuse a room from an earlier
`joinAs`/`createRoom` in the same test), `browser` (launch another engine), `e2ee` (`off` only for the
unencrypted-publisher negative test), `key` (another room key, for the wrong-key test), `page` (drive the test's own
page), `join` (click Join and wait for the call, default true), `wait` (wait for pre-join, default true), `camera`,
`microphone`, `viewport` and `params` (extra harness fragment parameters such as `maxShare`, `shareFps`, `title`, `rec`).
It returns a `JoinedPeer`: `page`, `context`, `identity`, `name`, `role`, `room`, `token` and `url` (the harness URL;
navigate there again to rejoin). The fixture also provides `createRoom()`.
- Creates the LiveKit room with `RoomServiceClient.createRoom` under a unique name (the server runs with
  `auto_create: false`) and deletes it on teardown.
- Mints the token with `livekit-server-sdk` (every source allowed). These peers have **no** `call_participants` rows,
  so every in-call API (`/api/calls/**`, recording start) answers `CALL_NOT_PARTICIPANT` for them: use the `rooms`
  fixture for anything that calls the server.
- Generates `K` and the epoch, then opens `/dev/call#url=…&token=…&k=…&epoch=…&slug=…&name=…&e2ee=…` in a new browser
  context. It registers the key and token with `secrets.track`.

**`rooms`** (`join.ts`): real users, rooms and joins (example in the file header).
- `createUser({ displayName?, role? })` writes a verified user and a session straight to the E2E database;
  `useIdentity(context, who)` puts that session (or a guest's cookie) into a browser context.
- `createRoom(owner, settings?)` builds K, slug and proof in Node and calls `POST /api/rooms`. Also `addCohost`,
  `createInvite`, `inviteLink`, `join` / `tryJoin` (`POST /api/join/:slug`, keeps the guest cookie), `admit`,
  `waitForAdmission` (reads the waiting-room SSE) and `callApi`.
- `harnessPath(room, grant, name)` only builds `/dev/call#…`; the spec calls `page.goto`, clicks `join-button` and waits
  for the `inCall` phase itself (helpers such as `waitForPhase` live in `livekit.ts`).

### 6.5 Global guards (every test)

`base.ts` auto-fixtures fail the test when:
- a `securitypolicyviolation` event fires in any page (an init script records directive, blocked URI and source);
- a console message of type `error` or an uncaught page error appears, unless it matches the test's narrow
  `allowConsoleErrors` list (for example a deliberate 403 in a negative test) or one of the few benign framework and
  library messages that `FRAMEWORK_NOISE` in `base.ts` lists by their exact text, each with its cause (a build-manifest
  fetch cancelled by a navigation; Firefox rejecting livekit-client's unhandled `AudioContext.resume()` on unload; a
  VideoFrame dropped by the blur library's teardown; livekit-client's failed retry to play the blur processor's
  `<video>` in Firefox);
- a secret appears in the app log or the e2e Caddy log: any tracked value (room key, join proof, LiveKit token,
  invite/session/guest token, password) or a generic pattern (JWT-shaped `eyJ…`, `#k=`). Logs: `logs/e2e/app.log` and
  `logs/e2e/caddy.log`.

Fixture API (`base.ts`): `guards.watch(context)` for extra browser contexts, `guards.allowConsoleError(pattern)`,
`secrets.track(value)` (values of at least 8 characters) and `secrets.expectNoLeaks()`. Secrets from the test
environment are tracked automatically, and a final log scan runs once per worker.

**Hydration.** In every watched context (the test's own and each `guards.watch(context)`), `page.goto`, `reload`,
`goBack` and `goForward` resolve only once the Nuxt app has hydrated (`nuxtApp.isHydrating === false`, set when the
root `<Suspense>` resolves, for client-only routes too). Before that a server-rendered button has no handler, so a
click does nothing, and mounting `v-model` resets fields filled in so far (F-069, F-070); fast pages in the Docker
runner made specs hit both. The wait is skipped for `waitUntil: 'commit'`, non-HTML answers, pages without
`#__nuxt`, and contexts with JavaScript off (the test's `javaScriptEnabled: false`, or
`guards.watch(context, { hydration: false })`), as in the F-020 pre-hydration specs (`auth/prehydration`). After a full
navigation that the page starts itself (`window.location`), call `waitForHydration(page)`.

**Call pages.** A watched page's `goto` (and `reload`) of a call page (`/dev/call`, `/m/<slug>`, any letter case)
without an explicit `waitUntil` waits for `commit`, then for hydration, never for `load` or `DOMContentLoaded`: in a
long run Firefox sometimes reports neither for a fully rendered call page (F-064; seen in the Docker runner on four
specs of one run, never in a fresh browser: 0 of 300 navigations). It can even lose the commit of a fresh context's
first navigation (the Cross-Origin-Opener-Policy process switch) while another context is in a call; when the commit
has not arrived after 15 s but the page shows the target path, the navigation counts as done and the test gets a
`note` annotation. The caller's own signal, usually the pre-join screen, marks the page ready.

`rooms/key-leak.spec.ts` (Stage 04) goes further. It records every request URL and body, WebSocket frame and SSE URL,
then searches them, a `pg_dump` of the test database and both logs for `K` and everything derived from it.

### 6.6 Test hooks (`window.__blinqTest`)

Contract: `app/lib/contracts/test-hooks.ts`. The hooks exist only in dev and `pnpm build:test` output, because
`__BLINQ_TEST_HOOKS__` is a compile-time constant. Harness pages live in `app/dev/*`, registered only in dev and test
builds. ci.yml proves the production build has no `__blinqTest` and that `/dev/call` returns 404.

| Hook | Used for |
|---|---|
| `metrics` | join timing: `performance.mark` timestamps for click, connected and first remote frame |
| `useFakeScreenSource(enabled)` | screen share with a synthetic 1920×1080 canvas instead of `getDisplayMedia` |
| `publishUnencryptedTrack()` | `call/unencrypted-blocked`, from a harness client joined with `e2ee=off`: peers must never subscribe to its track |
| `forceRecordingMime(mime)` | recording format specs (implemented by `recording-client`) |
| `measureNoiseSuppression()` | `media/rnnoise-offline`: input and output RMS in dBFS plus the output peak (implemented by `media-fx`) |
| `state` | feature snapshots: `state.call` (phase and local media), `state.subscriptions` (policy output incl. requested sizes), `state.inboundVideo` / `state.inboundAudio` (`getStats` per remote track, every 500 ms), `state.receivers` (`{ identity, source, ready, transform }` per subscribed remote track, every 500 ms), `state.audio`, `state.localScreen`, `state.harness` (harness only), `state.roomState` (collab-ui); `state.join` (rooms-ui: `{ phase, problem, notice, requestId, duplicate, leave() }`); `state.media` (media-fx: `blur`, `noise`, `gain`, `cameraTrackSid`, `micTrackSid`, plus `blurActive`, `blurLoading`, `blurFrames`, `rnnoiseActive`, `noiseBusy`, `sampleRate`, `micProcessing`, device ids and `support`) and `state.mediaFx.restartCamera()`; `state.recording` (recording-client: `recordingId`, `mime`, `chunksProduced`, `chunksAcked`, `retries`, plus `phase`, `mode`, `error`, `backlogBytes`, `startedAt`, `framesDrawn`) |

App code reaches the hooks only through `testHooks()` (`app/lib/contracts/test-hooks.ts`), which returns `undefined`
outside dev and test builds.

### 6.7 Timing policy

Join time runs from `blinq:join:click` to `blinq:join:first-remote-frame` (detected with `requestVideoFrameCallback`),
with the remote peer already publishing. Specs: `call/join-time` (harness) and `join/guest-invite` (real flow).

| Where | Samples | Assertion |
|---|---|---|
| Local | 1 | none: the value is printed and attached to the report |
| PR gate (e2e.yml, `CI` set) | 1 | < 6 s |
| Nightly (`E2E_NIGHTLY=1`) | 1 discarded warm-up, then 10 warm joins (same browser, page reloaded, same live room) | p95 < 3 s by nearest rank, which for 10 samples is the slowest join (decision) |

Other latency limits in stage DoDs are asserted as written, everywhere: lobby admit → SSE < 1 s, host action → peer
≤ 1 s, REC indicator ≤ 1 s. If one flakes, fix the cause or measure at a lower layer; never raise a limit quietly.

### 6.8 Recording tests (Stage 08)

- **Format.** `forceRecordingMime` selects WebM (VP9/Opus) or MP4 (H.264/AAC). A type the browser cannot record
  (`MediaRecorder.isTypeSupported` false, for example MP4 in Firefox) is skipped with an annotation, never passed.
- **Flow.** A host with an account records a two-person call for about 10 s, stops, polls until the recording is
  `ready`, and downloads the server's MP4.
- **File checks.** ffmpeg and ffprobe 9 come from `PATH` (copied from `mwader/static-ffmpeg:9.0.2` into the runner
  image and in CI):
  - `ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name -of json out.mp4`: duration about
    10 s (tolerance set in Stage 08), exactly one `h264` video stream and one `aac` audio stream;
  - `ffmpeg -hide_banner -nostats -i out.mp4 -vn -af volumedetect -f null -`: `max_volume` above the Stage 08
    threshold (digital silence reads about -91 dB), which proves the remote audio reached the mix.
- **Upload failures.** `page.route('**/api/recordings/*/chunks/*', …)` aborts selected chunk uploads; the file must
  still be complete.
- **At rest (API tests).** Stored bytes are ciphertext, tampering or truncation is an error, Range responses are exact,
  and the malicious fixtures in `tests/fixtures/media/` are rejected.
- **Background tab (`recording/background`, `@nightly`).** Playwright keeps every page visible (even minimized or
  headed), so the spec emulates a hidden tab: `visibilityState` hidden, no `requestAnimationFrame`, main-thread
  timers at most once per second; workers are untouched. The compositor's worker clock must keep about 30 fps for
  60 s, and `freezedetect` finds no frozen stretch in the file.
- **Nightly.** One long recording (≥ 30 min, decision) covers upload backlog, memory and the `partial` finalize path.

### 6.9 Network degradation (nightly, Stage 10)

- Playwright's offline mode and CDP `Network.emulateNetworkConditions` shape only HTTP and WebSocket traffic: use them
  for signaling drops. WebRTC media needs `tc netem`.
- On the Linux runner, impair the dev LiveKit container's interface (SFU → browser media):
  ```sh
  pid=$(docker inspect -f '{{.State.Pid}}' blinq-dev-livekit-1)
  sudo nsenter -t "$pid" -n tc qdisc add dev eth0 root netem rate 1mbit delay 150ms 30ms loss 3%
  sudo nsenter -t "$pid" -n tc qdisc del dev eth0 root
  ```
- Scenario (Chromium ↔ Firefox call): 20 s baseline, 60 s impaired, then cleared, 30 s recovery. Pass: no
  `Disconnected` event; `framesDecoded` keeps rising; the received resolution drops to a lower simulcast layer while
  impaired and returns to the baseline layer within 30 s after clearing; audio stays non-silent. Stage 10 tunes the
  numbers.
- CI only (root on Linux). Never impair the shared dev stack while other agents are testing.

## 7. Parallel agents and isolation

- **Setup.** `node scripts/worktree-setup.mjs <agent> <port>` installs with the frozen lockfile, creates and migrates
  `blinq_<agent>` (dashes become underscores) on the shared Postgres at `127.0.0.1:55432`, vendors browser assets, and
  writes `PORT`, `PUBLIC_URL` and `DATABASE_URL` into the worktree's `.env`.
- **Ports.** 3000 is the orchestrator's; agents use 3001–3005 for `pnpm dev`. The dev LiveKit sends webhooks only to
  `host.docker.internal:3000–3005`. E2E in the Docker runner uses no host port at all, so it never collides with a
  `pnpm dev` server or another program on 8080.
- **Heavy commands** run under `sh scripts/with-lock.sh <command>`: `pnpm build`, `pnpm build:test`, `pnpm test:api`,
  image builds. `scripts/e2e-docker.sh` and `scripts/e2e.sh` take the lock themselves. The lock is the directory
  `/tmp/blinq-heavy.lock` (`BLINQ_LOCK_DIR` overrides it); a lock left by a killed process is removed automatically.
  One E2E run at a time, machine-wide: the runner's compose project `blinq-e2e-docker` exists once per machine.
- **Browsers only in Docker.** On the maintainer's Mac every Playwright run (E2E, nightly specs, load) goes through
  `sh scripts/e2e-docker.sh` (§6.2); never start a browser on the host.
- **The shared dev stack is not yours.** Never run `docker compose down`, run `up` with other settings, or remove its
  volumes. If it is down, say so in your report.
- **Shared services, private data.** Postgres: only your databases (`blinq_<agent>`, `blinq_<agent>_test_api`). Mailpit:
  search by your recipients, never clear it. LiveKit: unique room names, delete only your own. Never assert on
  server-wide counts.
- Each worktree has its own `.output/`, `test-results/` and `playwright-report/`, and its own runner volumes
  (`blinq-e2e-<hash>-node-modules`, `-output`, `-nuxt`). `.claude/**` is excluded from Vitest, ESLint, TypeScript and
  the Nuxt watcher.

## 8. CI (`.github/workflows/`, owner `devops-ci`)

| Workflow | Runs on | Jobs |
|---|---|---|
| `ci.yml` | push, PR | frozen install + `git diff --exit-code`; lint; typecheck; `unit` + `nuxt`; `check:english` over `git ls-files`; gitleaks; actionlint; `pnpm audit`; `build` + `build:test` (the prod build has no `__blinqTest`, and `/dev/call` returns 404); API tests (Postgres and Mailpit services, fake RoomService); a small real-LiveKit API job |
| `e2e.yml` | push, PR | `scripts/e2e.sh` in host mode on the Linux runner: dev compose (LiveKit `node_ip` = the runner's eth0 IP); test build; e2e Caddy; `chromium` + `firefox` (1 worker), `webkit-ui`, `mobile-chromium`; ffmpeg/ffprobe from `mwader/static-ffmpeg:9.0.2`; report, traces and logs uploaded on failure |
| `docker.yml` | push, PR (from Stage 09a) | image build with BuildKit cache; `docker compose config`; `scripts/smoke-prod.sh` (prod compose with `TLS_MODE=internal`, a Playwright container on the host network); `ss -tulpn` shows only the intended public listeners |
| `nightly.yml` | schedule | join-time p95, network degradation, long recording, Edge, macOS WebKit (non-blocking) |
| `release.yml` | `workflow_dispatch` | prepared; never run until the user asks |

Actions are pinned by commit SHA. After every merge the orchestrator runs the same gate locally
([`ROADMAP.md`](ROADMAP.md) → Merge gate).

Local equivalents of the CI-only checks:
- `node scripts/check-build.mjs` — asserts the production build contains no test hooks or harness chunks (and the
  test build does).
- `sh scripts/scan-secrets.sh` — gitleaks over the repository history (`.gitleaks.toml` allowlists the public dev-only
  values in `.env.dev.example` and `docker-compose.dev.yml`).
- `sh scripts/lint-workflows.sh` — actionlint over `.github/workflows/` and shellcheck over every `*.sh` script.
- `sh scripts/e2e-docker.sh --project=chromium --project=firefox --project=webkit-ui --project=mobile-chromium
  --grep-invert @nightly` — the `e2e.yml` selection in the Docker runner (§6.2). Nightly specs run the same way with
  the nightly environment and arguments, for example
  `E2E_NIGHTLY=1 sh scripts/e2e-docker.sh --project=chromium --grep @nightly recording/long`.
  `network/degradation` needs `tc` on the SFU's interface and stays CI-only (§6.9); Edge and macOS WebKit are not run
  locally (§6.3).
- `pnpm audit` is report-only in `ci.yml` and blocking in `release.yml`.

## 9. Manual cross-browser matrix `[user]`

Run before the release (Stage 10) on real devices, against a deployment installed by following the README. Replace
each cell with `pass`, `fail (#issue)` or `n/a`. "expect hidden" passes when the control is not offered. The automated
coverage it complements is listed in the README ("Browser support").

blinq version under test: `1.0.0-rc.1`, the local tag of the release candidate that Stage 9b installs. On the server,
`git describe --tags` in the checkout prints the tag; the app's startup log line (`docker compose logs app`) shows the
package version, `1.0.0`.

| Check | Chrome | Edge | Firefox | Safari macOS | Safari iOS | Chrome Android |
|---|---|---|---|---|---|---|
| Join + E2EE | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |
| Camera/mic switching | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |
| Speaker selection | TODO [user] | TODO [user] | TODO [user] | TODO [user] (expect hidden) | TODO [user] (expect hidden) | TODO [user] (expect hidden) |
| Screen share | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] (expect hidden) | TODO [user] (expect hidden) |
| Background blur | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |
| Noise suppression (RNNoise) | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |
| Recording | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |
| Hotkeys | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] (hardware keyboard) | TODO [user] (hardware keyboard) |
| Chat | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |
| Responsive layout | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] | TODO [user] |

Tested: TODO [user] (date, tester, browser and OS versions, blinq version or tag).

How to check each row (a signed-in host creates the room on the dashboard and shares an invite link from the room page
or the in-call Invite button; the other devices join with that link):
- **Join + E2EE:** two devices join one room. The green badge at the top left of the call says "Encrypted" on both
  (phones show only its shield icon); open it on each device: the safety codes match.
- **Camera/mic switching:** during the call, pick another camera and microphone from the arrow next to the Camera and
  Microphone buttons (or More options → Settings → Devices); the other side gets the new device without a rejoin.
- **Speaker selection:** where the picker is offered (the arrow next to Microphone, or Settings → Devices → Speaker),
  choose another output; the sound moves to it.
- **Screen share:** Share screen, pick a window; with the default limits it is sent at up to 1080p and 15 fps. Text is
  readable on the receiver, and Stop presenting restores the layout.
- **Background blur:** in pre-join and in the call (More options → Blur background, or Settings → Video and audio
  effects: Off, Light, Strong); the other side sees the change without the video restarting.
- **Noise suppression (RNNoise):** choose "Enhanced (RNNoise)" under noise suppression, in pre-join or in Settings;
  fan or keyboard noise audibly disappears on the other side, without the audio restarting.
- **Recording:** a host or co-host with an account presses Record and records about 1 min with "Record to the server",
  then with "Save to this device only". Everyone sees the REC indicator while it runs; the server recording plays with
  audio and video under Recordings, and the local file plays on the recording device.
- **Hotkeys:** M (mic), V (camera), Space (push-to-talk while muted), ? (help); repeat with a Cyrillic layout active.
- **Chat:** messages reach every device; `<img src=x onerror=alert(1)>` shows as text.
- **Responsive layout:** portrait and landscape; the control bar stays reachable; no horizontal scrolling. Phones show
  up to 6 tiles per page.

Known platform limits:
- iOS and Android browsers offer no screen capture to web pages, so blinq hides the screen-share button there.
- `supportsAudioOutputSelection()` is false on Safari (macOS, iOS) and Android: the speaker picker is hidden there.
- Safari before 17.2 publishes without simulcast under E2EE.
- A browser without E2EE support gets an explanation screen; blinq never falls back to an unencrypted call.
