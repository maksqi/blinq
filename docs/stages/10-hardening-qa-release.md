# Stage 10 — Hardening, QA and release

Status: in progress
Owner(s): `e2e`, `security-review` (read-only), `quality-review` (read-only), fix agents (grouped by owner area),
`docs` (Wave 3); `orchestrator` (findings list, frozen files, release)
Depends on: every earlier stage merged (Stages 01–08 and 9a)
Blocks: Stage 9b (user, real server) and the `v1.0.0` release

## Goal
blinq is ready for a first release. An independent security review and a correctness/performance review find no
open high or critical issue. The E2E suite exercises the real product flows (`/m/[slug]`, not the harness) in Chromium
and Firefox. Network degradation, a 25-participant room, a performance budget, accessibility and responsive layouts are
tested. The measured numbers replace every sizing estimate. The docs are final, `CHANGELOG.md` exists, and `v1.0.0` is
tagged locally (never pushed without the user).

## Scope
### In scope
- Security review and fixes; quality review and fixes.
- E2E migration to real flows, cross-browser jobs, network degradation, load tests, performance budget,
  accessibility, responsive polish.
- `docs/PERFORMANCE.md`, final README/DEPLOYMENT/TESTING, `CHANGELOG.md`, release candidate and release tags.
### Out of scope (and where it lives instead)
- New features: backlog in `docs/ROADMAP.md`. Wave 3 only fixes, tests and documents.
- The real-server install and the manual browser matrix: Stage 9b and `docs/TESTING.md` (user).
- Pushing, GitHub releases and GHCR images: the user decides; `release.yml` stays unrun.

## Owned paths
- `e2e`: `tests/e2e/**`, `tests/api/security/**` (decision), `tests/load/**` (decision), `tests/smoke-prod/**` (taken
  over from `infra` for the real-flow call step), `docs/PERFORMANCE.md` (decision: one writer for measurements).
- `security-review`, `quality-review`: no files; reports only.
- Fix agents: the paths of the owning area in the `docs/ROADMAP.md` ownership map, one agent per area.
- `docs`: `README.md`, `CHANGELOG.md`, `docs/TESTING.md`, `docs/DEPLOYMENT.md`, and ticking boxes in `docs/stages/**`.
- `orchestrator`: the Findings list below, `package.json` version, workflows, new dev dependencies, tags.
### Consumes (must not edit)
- `docs/SECURITY.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md` (drift goes into requests).
- `shared/**`, `server/database/**`, `nuxt.config.ts`, `.github/workflows/**`, `playwright.config.ts` (requests).

## Tasks
### Kickoff
- [ ] Record the W3 base SHA in `docs/ROADMAP.md`; every W3 agent checks it with `git merge-base --is-ancestor`.
- [ ] Feature freeze: a change without a finding id or a test task is rejected at merge.
### Security review (`security-review`, read-only)
Each item gets a verdict (pass, finding) and an evidence pointer. Findings carry severity (critical, high, medium,
low), location, reproduction and owner area.
- [ ] Authorization: a table-driven matrix of every route in `docs/API.md` × {anonymous, guest of room A, guest of room
      B, participant, co-host, host, other user, admin, disabled user, user with a pending password change} →
      expected status. A route missing from the table fails the test (the route list is read from `server/api/**`).
- [ ] IDOR: rooms, room invites, meetings, recordings (metadata, file, chunks, delete), sessions, lobby requests,
      participant identities from another room, admin resources.
- [ ] CSRF: every mutating route with no `Origin`, a foreign `Origin` and `Sec-Fetch-Site: cross-site` → 403
      `CSRF_REJECTED`; the webhook is exempt but rejects a missing or bad signature; GET routes change nothing.
- [ ] Rate limits: login, register, password-reset request, email verification, invite preview/accept, join info,
      join with a room password, lobby cap per room, SSE connections, chunk uploads → 429 with `Retry-After`; IPv6
      keyed by /64; an `X-Forwarded-For` sent from outside through Caddy never changes the limiter key.
- [ ] Headers and CSP on every page type: SSR pages (home, login, dashboard, admin), the client-only call page, error
      pages (403, 404, 500), API JSON, recording files (`sandbox; default-src 'none'`, `no-store`), `/_nuxt/*`
      assets and Caddy-generated responses (redirect, webhook 404, 413).
- [ ] Cookies: `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`; rotation on login and
      privilege change; logout, password change and disable revoke; guest cookies are per room.
- [ ] Secrets in logs: after the full E2E run with `LOG_LEVEL=debug`, collect app, Caddy, LiveKit and Postgres logs
      and scan for every secret the run produced (collected by the fixtures) plus patterns: JWTs (`eyJ`), unredacted
      `access_token=`, `#k=`, `#t=`, and the `.env` secret values.
- [ ] Dependencies: `pnpm audit --prod --audit-level high` exits 0; the full `pnpm audit` is triaged in the report.
- [ ] Containers: `docker inspect` (user, `CapDrop`, `SecurityOpt`, `ReadonlyRootfs`, `NetworkMode`);
      `trivy image --severity HIGH,CRITICAL --ignore-unfixed` on both images (run from its container) (decision); no
      secrets in image layers (`docker history --no-trunc`, no `.env` in `/app`).
- [ ] Supply chain: frozen lockfile, explicit `allowBuilds`, `minimumReleaseAge`, every `uses:` pinned to a 40-hex SHA,
      images pinned by version, `@mediapipe/tasks-vision` at 0.10.14, gitleaks over the full history, and zero
      browser requests to any host other than `DOMAIN` during E2E.
- [ ] E2EE: the key never leaves the browser (Stage 04 check repeated on the real flows), unencrypted publishers are
      blocked, chat is ciphertext on the wire, no RPC methods are registered, token grants match the role table.
- [ ] Recording input: malicious fixtures rejected, oversize chunks 413, quotas enforced, the ffmpeg process
      environment holds no secret (read `/proc/<pid>/environ` during a job).
- [ ] Web: open redirects (`/login?redirect=//evil.example`), XSS payloads in display names, room names and chat
      render as text, `Host`/`X-Forwarded-Host` never reach emailed links.
- [ ] Abuse: a login flood keeps other routes responsive (argon2 semaphore); SSE and lobby caps hold; body limits hold.
### Quality review (`quality-review`, read-only)
- [ ] Correctness: races (invite `max_uses`, double admit, concurrent first joins create one meeting), webhook
      idempotency, error paths map to documented codes, no unhandled rejections, injected clocks used everywhere.
- [ ] Resource hygiene: listeners, timers, workers and media tracks released on leave; heap stable after 20
      join/leave cycles in one tab.
- [ ] Performance: N+1 queries, missing indexes (`EXPLAIN` on hot queries), route splitting, lazy MediaPipe and RNNoise.
- [ ] Code: dead code, stray TODOs, `any`, duplicated logic that belongs in `shared/`, drift from `docs/API.md`.
- [ ] UI copy: English, sentence case, errors say what happened and what to do.
### Fix agents
- [ ] One agent per owner area works through its findings; every fix ships with a regression test and the reviewer's
      reproduction is re-run.
- [ ] Medium and low findings are fixed or accepted with a reason in the Findings list; high and critical are fixed.
### E2E on real flows (`e2e`)
- [ ] Fixtures in `tests/e2e/fixtures/`: `loginAs(role)`, `createRoom(options)`, `inviteLink(room)`,
      `openAsGuest(link)`, `admit(requestName)`, merged with `mergeTests`; still against `pnpm build:test` for stats
      hooks.
- [ ] Move the call specs from `/dev/call` to `/m/[slug]`: E2EE Chromium ↔ Firefox, wrong key, join time, layers,
      screen share, hotkeys, reconnect. The harness stays only for what the UI cannot express (unencrypted publisher).
- [ ] Full journeys: first admin login → forced change → invite user → user creates room → guest joins via
      lobby → host actions → chat → recording → playback → admin audit entry.
- [ ] WebKit UI-only on Linux (`@ui`): auth pages, dashboard, and the call page's unsupported-browser screen.
- [ ] nightly.yml (request): macOS WebKit and Edge jobs, non-blocking (`continue-on-error`).
- [ ] `tests/smoke-prod/call.spec.ts`: replace the transport-level call with the real UI flow on the prod image.
### Network degradation (`e2e`)
- [ ] `tests/e2e/network/degradation.spec.ts` (nightly): Chromium receiver; CDP `Network.emulateNetworkConditions` with
      the WebRTC parameters (`packetLoss: 5`, `latency: 150`, throughput 500 kbit/s) for 60 s; `tc netem` on the
      runner's LiveKit interface as the fallback and for Firefox (decision).
- [ ] Assert: the inbound video layer or bitrate drops within 20 s; no `Disconnected` and no end screen during the
      60 s; after the conditions are lifted the high layer returns within 30 s.
### 25-participant load (`e2e`)
- [ ] SFU: `lk room create` first (`auto_create` is off), then `lk load-test --room <name> --video-publishers 25
      --audio-publishers 25 --duration 5m` against `wss://DOMAIN` from a separate machine, plus one on-box run
      against loopback. Scenarios: one full room; one full room with a 1080p15 screen share; rooms of 10 added until
      80 % CPU.
- [ ] Browser swarm `tests/load/swarm.ts` (Playwright library): N guests per load host join one room through the real
      invite flow with fake media and E2EE; records per-bot join time and first remote frame; an observer tab checks
      the 5×5 grid and decoded frame rates.
- [ ] Record per run: host size, versions, CPU, RAM, ingress/egress Mbit/s (`docker stats`, `sar -n DEV`), packet
      loss, join time p50/p95.
- [ ] `docs/PERFORMANCE.md`: method, raw results, derived sizing (per 25-person room and per vCPU), recommended LiveKit
      `limit.num_tracks` and `limit.bytes_per_sec` (request to `infra` owner area via a fix agent).
### Performance budget (`e2e`)
- [ ] `tests/e2e/perf/budget.spec.ts` sums `encodedBodySize` of script resources (decision on the limits):
      - `/` and `/login`: initial JS ≤ 200 KB compressed.
      - `/m/[slug]` up to the pre-join screen (without MediaPipe, RNNoise and the E2EE worker): ≤ 450 KB.
- [ ] Join time (click → first remote frame): p50 < 1.5 s and p95 < 3 s nightly; < 6 s on the PR gate.
### Accessibility and responsive polish (`e2e` finds, fix agents fix)
- [ ] `tests/e2e/a11y/*.spec.ts` with `@axe-core/playwright` (new dev dependency, request): every page type in light
      and dark theme, plus pre-join, in-call grid, chat, participants and lobby panels, dialogs.
- [ ] Keyboard-only journeys: login, create room, join, mute/unmute, share screen, leave; visible focus; dialogs
      trap and restore focus; `aria-live` for toasts, chat and lobby requests; `prefers-reduced-motion` respected.
- [ ] Responsive: every page type at 375, 768 and 1440 px (no horizontal overflow, controls in the viewport, touch
      targets ≥ 44 px on phones), `@responsive` on the `mobile-chromium` project.
### Docs final and release (`docs`, `orchestrator`)
- [ ] `docs`: README install re-verified against the smoke stack; sizing from `docs/PERFORMANCE.md` replaces every
      estimate in README and `docs/DEPLOYMENT.md` (`TODO(stage-10)`); troubleshooting updated from the fixes;
      `docs/TESTING.md` gets the manual browser matrix table (Chrome, Edge, Firefox, Safari macOS, Safari iOS, Android
      Chrome) for the user to fill in.
- [ ] `docs`: drift in `docs/API.md`, `docs/SECURITY.md` or `docs/ARCHITECTURE.md` goes to the orchestrator as exact
      edits.
- [ ] `docs`: `CHANGELOG.md` in Keep a Changelog format with `## [1.0.0] - <date>`: Added, Security, Known limitations
      (the non-goals from `docs/SECURITY.md`).
- [ ] `orchestrator`: `package.json` version `1.0.0`; full gate; commit `chore(release): v1.0.0`; local tag
      `v1.0.0-rc.1` for Stage 9b (decision), then `git tag -a v1.0.0 -m "blinq v1.0.0"` after 9b passes. No push.
### Findings (orchestrator-maintained)
Format: `- [ ] F-NNN [severity] <area> — <summary> — owner: <agent> — status: open | fixed <sha> | accepted
(<why>)`.
- [ ] F-001 [low] server — `deleteUser` publishes `user.revoked` after the row is deleted (`call_participants.user_id`
      already null); the admin service works around it in `beforeDelete` — owner: fix-server — status: open
- [ ] F-002 [low] server — 404 error responses carry `cache-control: no-cache` (Nitro error handler), not the documented
      `no-store` — owner: fix-server — status: open
- [x] F-003 [low] admin — the overview counts live meetings from the first 100 rooms only ("100+") — owner: admin —
      status: accepted (the overview says "100+" beyond 100 rooms; a counts endpoint is a feature, backlog)
- [x] F-004 [low] ci — nightly.yml runs `--project=msedge`, which `playwright.config.ts` did not define — owner:
      orchestrator — status: fixed (W3 kickoff, `E2E_NIGHTLY_BROWSERS=1`)
- [ ] F-005 [medium] call — `LocalMedia` ignores server-side mutes, so the local toggles stay "on" after a host mute;
      collab-ui works around it in `ParticipantNotices` — owner: fix-call — status: open
- [ ] F-006 [low] call — the SDK logs data-channel errors when a room is deleted (end for all) — owner: fix-call —
      status: open
- [ ] F-007 [low] call — participant-side dialogs live in a zero-footprint `start` control-bar item; no always-mounted
      overlay slot in `CallFeature` — owner: orchestrator (contract) + fix-call — status: open
- [x] F-008 [low] rooms — co-hosts can only be promoted during a call (no user lookup for non-admins) — owner:
      orchestrator — status: accepted (a user lookup for non-admins would reveal accounts; co-hosts are promoted during a call, backlog)
- [ ] F-009 [low] recording — local-only file names use the slug; the room name is not in `CallContext` — owner:
      orchestrator (contract) + fix-call — status: open
- [x] F-010 [low] media — `/vendor/mediapipe/*.tflite` is served as `text/plain` (with `nosniff`) — owner:
      orchestrator (`nuxt.config.ts`) — status: fixed (route rule; `check-build.mjs production` asserts it)
- [ ] F-011 [low] rooms — the sessionStorage fragment store (`blinq:fragment:/m/<slug>`) can keep an untaken key after
      sign-out — owner: fix-ui — status: open
- [x] F-012 [medium] ci — the production SSR bundle contains `__blinqTest` (a JSDoc comment in
      `app/lib/call/features/room-settings/index.ts`; SSR chunks are not minified), so `check-build.mjs production`
      fails — owner: orchestrator — status: fixed (comment reworded)
- [x] F-013 [medium] ci — gitleaks reports 15 `generic-api-key` false positives (fake passwords in tests, the temporary
      password alphabet), so the ci.yml gitleaks job fails — owner: orchestrator — status: fixed (`.gitleaks.toml`
      allowlist limited to that rule in test files)
- [ ] F-014 [medium] ui — after creating a room the "Room created" toast (bottom right) covers the pre-join Join button
      at 1280×720; hovering it to click Join pauses its dismissal (`rooms/create-and-join` fails in Firefox) — owner:
      fix-ui — status: open
- [ ] F-015 [high] call — E2EE: livekit-client keeps one decrypt flag per participant that every `TrackPublished`
      overwrites, and the worker passes frames through undecrypted when it is off; blinq checks encryption per track,
      so a compromised SFU can announce one `NONE` track and get plaintext played, mixed and recorded on that
      participant's encrypted tracks (security-review S-01) — owner: fix-call (+ the livekit-client patch) — status: open
- [ ] F-016 [medium] server — login: the DB backoff races (40 parallel wrong passwords → 40×401, no 429), there is no
      `auth-ip` limiter, the argon2 semaphore queue is unbounded (a 200-request flood slows a real login to ~1 s), and
      `PATCH /api/rooms/:id {password}` re-hashes with no limiter (S-02) — owner: fix-server — status: open
- [ ] F-017 [medium] server — anyone can soft-lock a known account: the email-only backoff key makes the victim's
      correct password answer 429 for up to 900 s (S-03, contradicts SECURITY.md §4) — owner: fix-server — status: open
- [ ] F-018 [medium] server — "removed is final for the meeting" holds per guest session or user only: a removed guest
      with a fresh cookie and the same multi-use invite is admitted again (S-04) — owner: fix-server (+ fix-call hint)
      — status: open
- [ ] F-019 [medium] server — no cap on waiting-room SSE streams per request or IP (150/150 opened) (S-05) — owner:
      fix-server — status: open
- [ ] F-020 [medium] ui — forms submitted before hydration send `GET /login?email=…&password=…` or `/?link=…#k=…`
      into the URL, history and the Caddy log (S-06) — owner: fix-ui (+ fix-infra: Caddy query redaction) — status: open
- [x] F-021 [medium] deps — `pnpm audit --prod --audit-level high` exits 1: node-forge GHSA-86w9-cpqp-85rv and braces
      GHSA-vfj7-8cjw-p6xm (build-time only, no patched release on npm) (S-07) — owner: orchestrator — status: fixed
      (`auditConfig.ignoreGhsas` with reasons in `pnpm-workspace.yaml`, `shadcn-vue` moved to devDependencies)
- [ ] F-022 [low] infra — the app runtime image keeps npm (all 7 HIGH trivy findings) and the Caddy binary has 6 HIGH
      Go module findings (S-09) — owner: fix-infra — status: open
- [ ] F-023 [low] infra — `postgres:18-alpine` and `node:24-bookworm-slim` are pinned by major version only (S-10) —
      owner: fix-infra (+ orchestrator for workflows) — status: open
- [ ] F-024 [low] server — password-reset request timing reveals whether an account exists (7.7 ms vs 1.5 ms) (S-11)
      — owner: fix-server — status: open
- [ ] F-025 [low] server — chunked request bodies bypass the 1 MB limit outside Caddy (nuxt-security checks
      `Content-Length` only) (S-12) — owner: fix-server — status: open
- [ ] F-026 [low] server — the room-password backoff has the same race as login (25 parallel guesses evaluated) (S-13)
      — owner: fix-server — status: open
- [x] F-027 [low] infra — ffmpeg runs as the app uid and could read the app's `/proc/<pid>/environ` after an ffmpeg
      exploit (S-14) — owner: orchestrator — status: accepted (no capability to switch uid; signed-in input behind the
      ffprobe allowlist; documented in SECURITY.md §6)
- [ ] F-028 [low] server — `/api/**` responses carry no `Cross-Origin-Resource-Policy` (S-15) — owner: fix-server —
      status: open
- [ ] F-029 [low] ui — the key vault survives an expired session (cleared only when a previous user was known; no 401
      hook) (S-16, SECURITY.md §3.1) — owner: fix-ui — status: open
- [ ] F-030 [low] ui — `/M/<slug>#k=…` (mixed case) keeps the key in the address bar: the fragment store matches the
      path case-sensitively (S-17) — owner: fix-ui — status: open
- [ ] F-031 [low] call — chat and reaction envelopes can be replayed by the SFU after a reload or 5000 ids (in-memory
      dedupe, no freshness check) (S-18) — owner: fix-call — status: open
- [ ] F-032 [low] server — Nitro error bodies reflect `X-Forwarded-Host` in `url` (Caddy overwrites it in production)
      — owner: fix-server (with F-002) — status: open
- [x] F-033 [low] server — a resume within 120 s skips the lock and capacity checks (`resume.ts`) — owner:
      orchestrator — status: accepted (by design: a reconnecting participant keeps the seat it already holds)
- [x] F-034 [low] call — co-hosts can mute, remove and rename other co-hosts — owner: orchestrator — status: accepted
      (SECURITY.md "manage co-hosts" means promoting and demoting, which stays host-only)
- [x] F-035 [low] server — an invited guest can fill the 50-slot lobby for an hour; there is no deny-all — owner:
      orchestrator — status: accepted (hosts lock the room or revoke the invite; deny-all is a feature, backlog)
- [ ] F-036 [high] call — a camera or mic that finishes opening after leave/dispose is never stopped
      (`app/lib/livekit/local-media.ts:84-110,240-256`; `dispose` does not drain the queues): the camera light stays on
      (quality-review) — owner: fix-call — status: open
- [ ] F-037 [medium] call — the heap grows ~1.3 MB per join/leave in one tab: livekit-client's WeakRef
      `onDeviceChange` closure keeps every `Room`, and @tanstack/vue-form drops `formApi.mount()`'s cleanup so form
      devtools listeners keep the component and the `CallSession` — owner: fix-call (patches) — status: open
- [ ] F-038 [medium] ui — join error screens keep the preview session (camera, mic, Room, E2EE worker) alive
      (`app/composables/rooms/useJoinFlow.ts:99-107`) — owner: fix-ui — status: open
- [ ] F-039 [medium] server — a LiveKit full reconnect (left on the old session, joined on the new one) is enforced as
      a removal (`server/services/meetings/webhooks.ts:62-103`) — owner: fix-server — status: open
- [x] F-040 [medium] db — `recordings.meeting_id` has no index (deleting a user with 5000 meetings takes 4.5 s vs
      68 ms); `room_invites.created_by`, `user_invites.created_by/used_by` are unindexed FKs; no partial index for the
      stale-waiting sweep or `recordings.started_at` — owner: orchestrator — status: fixed 55a129b (migration 0001_w3_indexes)
- [ ] F-041 [medium] call — `startPreview` and `watchDevices` continue after dispose and add a `devicechange` listener
      that keeps the session alive (`app/lib/call/session.ts:270-279,997-1002`) — owner: fix-call — status: open
- [ ] F-042 [medium] call — unhandled promise rejections from the hotkeys and pre-join toggles (`CallView.vue:89-98`,
      `PreJoin.vue:163,172`) — owner: fix-call — status: open
- [ ] F-043 [medium] perf — initial JS is over the Stage 10 budget (gzip: `/` 222 KiB, `/login` 225 KiB, `/m/<slug>`
      no-key screen 464 KiB); one 814 KB chunk with livekit-client and all call code loads even on error screens —
      owner: fix-ui (pages, entry) + fix-call (call chunk) — status: open
- [ ] F-044 [medium] api — drift: request schemas strip unknown keys (API.md says strict); 503 `SERVICE_UNAVAILABLE`
      is undocumented and the join screen shows it as unknown; `VALIDATION_FAILED` with status 416; 413/415 normalized
      to `VALIDATION_FAILED`; `recording_busy` documented under upload but thrown by DELETE — owner: orchestrator
      (docs) + fix-server + fix-ui — status: open
- [ ] F-045 [medium] ui — copy: many `ERROR_MESSAGES` give no next step (`shared/utils/error-codes/index.ts`); one
      setting is labeled "Hosts only" in the call and "Hosts and co-hosts" on the room page — owner: fix-ui (+ fix-call
      label) — status: open
- [ ] F-046 [low] server — LiveKit `createRoom`/`deleteRoom` run inside the room-lock transaction (pool max 10);
      `GET /lobby` writes; (unconfirmed) demoting a co-host does not stop their screen share under the "hosts" policy —
      owner: fix-server — status: open
- [ ] F-047 [low] server — bare clocks in `settings.ts`, `recordings/processor.ts`, `auth/providers/identity.ts`,
      `utils/cookies.ts` — owner: fix-server — status: open
- [x] F-048 [low] server — the dashboard room list (`OR`) and own-recordings list plus count use seq scans at volume
      (5–16 ms at 60k rooms) — owner: orchestrator (indexes, with F-040) — status: accepted (5–16 ms at 60k rooms; `recordings.started_at` indexed in 0001_w3_indexes)
- [ ] F-049 [low] client — a BroadcastChannel can open after dispose (`useJoinFlow.ts:156-162`); `MicChain.destroy`
      does not stop `processedTrack`; recording uploads retry forever after unmount; livekit's iOS `visibilitychange`
      listener is never removed (upstream) — owner: fix-ui + fix-call — status: open
- [ ] F-050 [low] code — dead code (`RECORDING_INVALID_MEDIA`, `notImplemented()`, hint `room.changed`,
      `hasModerationMenu`, `bytesEqual`, `queuePosition`, `displayedSetting`) and duplicates (UUID regex ×8,
      `likePattern` ×5, moderator check ×3, server forks of `StreamEvent` and the settings patch schema) — owner:
      fix-server + fix-call + fix-ui (dead code); duplicates accepted for v1 — status: open
- [ ] F-051 [low] ui — the 403 and 404 error pages log `[NUXT_E1005]` to the console while hydrating (e2e-security) —
      owner: fix-ui — status: open
- [ ] F-052 [high] ui — axe critical `aria-required-children` on `/settings/sessions`: the session list has
      `role="list"` but its items have no `listitem` role (SessionList.vue) (e2e-a11y) — owner: fix-ui — status: open
- [x] F-053 [medium] ui-kit — slider thumbs (`role="slider"`) have no accessible name; `aria-label` stays on the root
      (`app/components/ui/slider/Slider.vue`) — owner: orchestrator — status: fixed (the thumb gets the name; a11y
      `axe-call` runs without the exception)
- [ ] F-054 [medium] call — chat messages are `<li>` inside `<ol role="log">`, which drops the list semantics
      (ChatPanel) — owner: fix-call — status: open
- [ ] F-055 [medium] ui — destructive buttons in the dark theme are 4.42:1 (#f66c6d on #432c33) — owner: fix-ui —
      status: open
- [ ] F-056 [medium] call — closing the device settings dialog opened from More options leaves focus on `<body>`
      (WCAG 2.4.3) — owner: fix-call — status: open
- [ ] F-057 [medium] ui — a long room name overflows the dashboard by 118 px at 375 px and pushes dialogs past the
      screen edge (RoomListItem `ItemTitle`) — owner: fix-ui — status: open
- [ ] F-058 [medium] ui — touch targets under 44 px on phones on every page except the call control bar (shadcn
      buttons, inputs, selects, switches, toggle groups, pagination, sidebar trigger, slider thumb; logo, Show password,
      text links; the E2EE badge and tile options in the call) — owner: fix-ui (+ fix-call for call controls) —
      status: open
- [ ] F-059 [low] call — toggling the mic right after joining, before the first publish, logs "could not update mute
      status for unpublished track" — owner: fix-call — status: open
- [ ] F-060 [low] call — when the mic chain's AudioContext never runs (e.g. no audio backend), the published mic is
      silence with no warning (e2e-prod, Firefox in the Playwright Linux image) — owner: fix-call — status: open
- [ ] F-061 [low] e2e — `call/e2ee` and `media/mic-chain` assert `totalAudioEnergy > 0`, which comfort noise from a
      silent sender satisfies — owner: e2e-flows (call) + fix-call (media) — status: open
- [ ] F-062 [low] infra — Caddy logs livekit-client's `join_request=` query (the SDP offer with ICE credentials) —
      owner: fix-infra (+ orchestrator for the e2e Caddyfile) — status: open

## Tests
- API: `tests/api/security/{authz-matrix,idor,csrf,rate-limits,cookies,headers}.test.ts`.
- E2E: `tests/e2e/{call,rooms,join,collab,media,recording,admin,auth}/**` on real flows;
  `tests/e2e/security/{headers,log-scan,external-requests}.spec.ts`; `tests/e2e/network/degradation.spec.ts`;
  `tests/e2e/perf/budget.spec.ts`; `tests/e2e/a11y/*.spec.ts`; `tests/e2e/**/responsive.spec.ts`.
- Load: `lk load-test` runs and `tests/load/swarm.ts` (manual, results in `docs/PERFORMANCE.md`).
- Prod: `sh scripts/smoke-prod.sh` with the real-flow call.
- Manual (user): Stage 9b and the browser matrix in `docs/TESTING.md`.

## Definition of Done
- [ ] [agent-manual] Every DoD item of Stages 01–08 and 9a is checked — evidence:
      `awk '/^## Definition of Done/{d=1;next} /^## /{d=0} d && /^- \[ \]/ && !/\[user\]/' docs/stages/0*.md`
      prints nothing (`[user]` items such as 9b are excluded until the user runs them).
- [ ] [agent-manual] No high or critical finding is open — evidence: Findings list in this file;
      `pnpm audit --prod --audit-level high` exits 0; trivy output in the report.
- [ ] [auto] Authorization, IDOR, CSRF, rate-limit, cookie and header suites pass — evidence:
      `pnpm test:api -- security`.
- [ ] [auto] Headers and CSP are correct on every page type with zero violations — evidence:
      `pnpm test:e2e -- security/headers`.
- [ ] [auto] No secret appears in app, Caddy, LiveKit or Postgres logs after the full run — evidence:
      `pnpm test:e2e -- security/log-scan`.
- [ ] [auto] The browser makes no request to any host other than `DOMAIN` — evidence:
      `pnpm test:e2e -- security/external-requests`.
- [ ] [auto] Real-flow E2E passes on Chromium and Firefox; WebKit UI-only passes on Linux — evidence: e2e.yml
      (`chromium`, `firefox`, `webkit-ui` projects).
- [ ] [auto] macOS WebKit and Edge jobs run nightly (non-blocking) — evidence: nightly.yml job results.
- [ ] [auto] Under degradation, quality drops, nothing disconnects for 60 s, and it recovers within 30 s — evidence:
      `pnpm test:e2e -- network/degradation` in nightly.yml.
- [ ] [agent-manual] A 25-participant room is measured with `lk load-test` and the browser swarm — evidence:
      `docs/PERFORMANCE.md` results table with hardware and versions.
- [ ] [agent-manual] README and `docs/DEPLOYMENT.md` sizing comes from `docs/PERFORMANCE.md` — evidence:
      `grep -rn 'TODO(stage-10)\|estimate' README.md docs/DEPLOYMENT.md` shows no unmeasured size.
- [ ] [auto] The performance budget holds (initial JS ≤ 200 KB, call route ≤ 450 KB) — evidence:
      `pnpm test:e2e -- perf/budget`.
- [ ] [auto] Join time p50 < 1.5 s and p95 < 3 s nightly; < 6 s on the PR gate — evidence: nightly.yml join-time job,
      `pnpm test:e2e -- call/join-time`.
- [ ] [auto] axe reports no serious or critical violation on any page type in either theme — evidence:
      `pnpm test:e2e -- a11y`.
- [ ] [auto] No horizontal overflow; controls stay in the viewport at 375/768/1440 px on every page type — evidence:
      `pnpm test:e2e -- responsive`.
- [ ] [agent-manual] Keyboard-only journeys work — evidence: `tests/e2e/a11y/keyboard.spec.ts` plus a local check
      in the report.
- [ ] [agent-manual] `smoke-prod.sh` passes with the real-flow call — evidence: `sh scripts/smoke-prod.sh`.
- [ ] [agent-manual] The full local gate is green on the release commit — evidence: `pnpm lint && pnpm typecheck &&
      pnpm test && pnpm test:api && pnpm build && pnpm check:english && pnpm test:e2e` and a clean `docker build`.
- [ ] [user] CI is green on the release commit — evidence: ci.yml, e2e.yml and docker.yml runs after the user pushes.
- [ ] [agent-manual] Docs are final and consistent — evidence: no `TODO(stage-` left
      (`grep -rn 'TODO(stage-' README.md docs`), `pnpm check:english`, every relative link resolves.
- [ ] [agent-manual] `CHANGELOG.md` has the 1.0.0 entry and the tag exists only locally — evidence:
      `git tag -l 'v1.0.0*'`; `git ls-remote --tags origin` does not list it.
- [ ] [user] README install followed verbatim on a fresh server — evidence: Stage 9b DoD.
- [ ] [user] Manual browser matrix completed — evidence: table in `docs/TESTING.md`.

## Notes and gotchas
- Reviewers never edit files; the orchestrator turns their reports into the Findings list and assigns fix agents by
  owner area, so no path gets two writers.
- `lk load-test` does not use E2EE. The SFU forwards encrypted frames the same way, so it still measures SFU cost;
  the browser swarm adds the client-side E2EE cost.
- 25 real Chromium bots with fake video need many cores; spread them over several load hosts and keep the observer tab
  on a separate machine.
- CDP network emulation exists only in Chromium; Firefox degradation needs `tc netem` on a Linux runner.
- Linux WebKit has no `RTCRtpScriptTransform`, so it can only test UI and the unsupported-browser screen.
- Keep test-only hooks out of the prod image: specs that need `window.__blinqTest` run against `pnpm build:test`, never
  against the smoke stack.
