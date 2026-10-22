# AGENT.md — working on blinq

blinq is a self-hosted, Docker-based video conferencing app (Zoom-like). It supports rooms of up to 25 people, end-to-end
encrypted media and chat (LiveKit E2EE, key only in the URL fragment), host moderation, screen share at 720p–1080p,
browser-side recording, an admin panel, invite-only accounts plus guests, and HTTPS everywhere. It starts with
`docker compose up`.

This file is the entry point for every human and AI agent working in this repository. Read it fully before touching
anything, then read your stage file in `docs/stages/` and the parts of `docs/API.md` you consume.

- Roadmap, ownership map and status: `docs/ROADMAP.md`
- System design: `docs/ARCHITECTURE.md` · Contracts: `docs/API.md` · Threat model and rules: `docs/SECURITY.md`
- Testing: `docs/TESTING.md` · Deployment: `docs/DEPLOYMENT.md` · Performance: `docs/PERFORMANCE.md`

---

## 1. Golden rules

1. **English only.** Code, comments, identifiers, docs, UI strings, test names, commit messages — everything in the
   repository is English. `pnpm check:english` fails CI on any Cyrillic character.
2. **Never weaken E2EE.**
   - The room key `K` exists only in the browser: the URL fragment, sessionStorage and the key vault.
   - Never send `K` or anything derived from it to the server, except the join proof `P` exactly as specified in
     `docs/API.md`. Never log it. Never put it in a query string or path.
   - Never attach, mix or record a remote publication whose encryption is `NONE`.
3. **Secrets come only from environment variables**, validated in `server/utils/env.ts`. No secrets, keys or
   passwords in code, fixtures or docs examples (use obvious placeholders like `change-me-...`).
4. **Never log secrets.** This covers session/guest/invite/reset tokens, LiveKit tokens, passwords, keys and
   proofs. Use the logger's redaction; never `console.log` request bodies.
5. **Stay inside your owned paths** (see `docs/ROADMAP.md` → Ownership map). Never edit frozen files (§4). Need a
   dependency or a contract change? Put it in your report; the orchestrator applies it.
6. **Contracts are law.** Zod schemas in `shared/schemas/*`, error codes in `shared/utils/error-codes/*`, LiveKit
   metadata/attributes/topics and SSE events in `docs/API.md`. Implement them exactly. Don't fork them locally.
7. **Every change ships with tests** (§7) and keeps `lint`, `typecheck`, `test`, `build` and `check:english` green.
8. **Validate every input at the boundary** with the shared zod schema. Authorize every request on the server
   (`requireUser`, `requireAdmin`, `resolveCaller` + the permission matrix). The UI hiding a button is not
   authorization.
9. **No `v-html`** (lint error), no `eval`, no inline event-handler strings, no external network requests from the
   browser (CSP `connect-src 'self'`), no CDN assets. Everything is self-hosted.
10. **Ask instead of guessing** when a requirement is ambiguous. Write the question in your report and implement
    the simplest option consistent with the docs, marked `(decision)`.

## 2. Stack (pinned; verified 2026-09-28)

| Area | Choice | Notes |
|---|---|---|
| Runtime | Node 24 LTS (Docker/CI), local Node ≥22.19 works | `.node-version` = 24 |
| Package manager | pnpm 11.20 (`packageManager` field) | strict dep builds: `allowBuilds` in `pnpm-workspace.yaml` |
| Framework | Nuxt 4.5 (Nitro 2.13, h3 1.15, Vite 8, Vue 3.5) | **never add `h3` v2** |
| Language | TypeScript ^6 strict | **not TS 7** (no JS API for vue-tsc) |
| UI | shadcn-vue 2.8 (reka-ui 2.10), Tailwind 4.3, `@lucide/vue`, vue-sonner 2, `@nuxtjs/color-mode` 4 | `lucide-vue-next` and `radix-vue` are forbidden |
| State and forms | Pinia 4, VueUse 15, zod 4, `@tanstack/vue-form` + shadcn `Field` | shadcn `Form` is deprecated; no vee-validate |
| Security | nuxt-security 2.6 | xssValidator and global rateLimiter disabled; own limiters |
| Database | PostgreSQL 18, drizzle-orm 0.45 + drizzle-kit 0.31, postgres.js 3.4 | core query builder only (no `db.query.*`) |
| Auth | own DB sessions, `@node-rs/argon2` 2.2 | argon2id m=19456 t=2 p=1; pass `algorithm: 2` |
| Media | livekit-client 2.22, livekit-server-sdk 2.19, @livekit/track-processors 0.8, @sapphi-red/web-noise-suppressor 0.4 | LiveKit server v1.13.7 |
| Mail | nodemailer 10 | optional SMTP |
| Tests | Vitest 5 + @nuxt/test-utils 4.3, Playwright 1.63 | |
| Proxy | Caddy 2.11.4 + caddy-l4 v0.1.2 | TURN/TLS on 443 via SNI |

## 3. Repository map

```
app/                  Nuxt srcDir (`~` and `@` point here)
  components/ui/      shadcn-vue components (frozen; all installed in W0a)
  components/<area>/  feature components: app, auth, admin, rooms, recordings, call/<feature>
  composables/        useX composables (auto-imported)
  layouts/ pages/ middleware/ plugins/ stores/
  lib/e2ee/           key generation, HKDF derivations, join proof, app envelope, key vault
  lib/livekit/        room factory, SubscriptionManager, AudioEngine
  lib/call/features/  auto-discovered call features (registries via import.meta.glob)
  lib/media/          blur and noise-suppression processors
  lib/recording/      compositor, mixer, recorder, uploader
  lib/layout/         grid/speaker layout math
server/
  api/                thin route handlers only (no tests here!)
  middleware/         request id, session, CSRF, password-change guard
  plugins/            sync-only Nitro plugins (Nitro v2 does not await async plugins)
  tasks/              scheduled tasks (retention, cleanup)
  services/<domain>/  domain logic (auth, users, rooms, join, lobby, calls, livekit, recordings, mail, settings, audit)
  database/           Drizzle schema (frozen) and generated migrations (frozen)
  mail/               email templates
  utils/              env, logger, errors, crypto helpers, limiters, sse
  cli.ts              migrate | bootstrap | reset-password (bundled to .output/server/cli.mjs)
shared/               code shared by app and server (no Vue/Nitro imports)
  schemas/<domain>.ts zod contracts        utils/error-codes/<domain>.ts        utils/permissions.ts
tests/api/            API integration tests      tests/e2e/   Playwright specs + fixtures
docker/ scripts/ docs/ .github/workflows/
```

Only `shared/utils` and `shared/types` auto-import. Import everything else from `shared/` via `#shared/...`.

## 4. Frozen files (orchestrator only)

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version`
- `nuxt.config.ts`, `tsconfig*.json`, `eslint.config.*`, `vitest.config.*`, `playwright.config.*`,
  `drizzle.config.ts`, `components.json`
- `server/utils/env.ts`, `server/utils/api-error.ts`, `.env.example`, `.env.dev.example`
- `server/contracts/**`, `app/lib/contracts/**`, `app/lib/e2ee/**` (except `key-vault.ts`), `app/composables/useApi.ts`,
  `app/composables/useAuthState.ts`
- `server/database/schema/**`, `server/database/migrations/**` — never run `drizzle-kit generate` yourself
- `app/components/ui/**` (shadcn), `app/layouts/**`, app navigation
- `shared/**` contracts
- `.github/workflows/**`, `docker-compose.dev.yml`, `.claude/**` (local only: `.claude` is git-ignored globally on the
  maintainer's machine, so `.claude/settings.json` with `worktree.baseRef: "head"` is not committed)

If you need a change here, describe it precisely in your report (file, change, reason). The orchestrator applies
it centrally.

## 5. Commands

| Command | What it does |
|---|---|
| `pnpm dev:deps` | start the shared dev stack (Postgres :55432, LiveKit, Mailpit) with `--wait` |
| `pnpm dev` | migrate the DB, then `nuxt dev` (PORT from env, default 3000) |
| `pnpm lint` / `pnpm typecheck` | ESLint / vue-tsc |
| `pnpm test` | Vitest unit tests |
| `pnpm test:api` | API integration tests (builds the server once in globalSetup) |
| `pnpm build` / `pnpm build:test` | production build / test build with `BLINQ_TEST_HOOKS=1` |
| `pnpm test:e2e` | Playwright through `scripts/e2e.sh`: inside the Docker runner on macOS (never host browsers there) |
| `pnpm check:english` | fails on Cyrillic in tracked files |
| `pnpm db:migrate` | apply migrations (`pnpm cli migrate`) |
| `pnpm cli <cmd>` | `migrate`, `bootstrap`, `reset-password <email>` (password via stdin) |

Wrap heavy commands with `scripts/with-lock.sh` (for example `sh scripts/with-lock.sh pnpm build`) so parallel agents
don't overload the machine.

## 6. Coding conventions

**General**
- TypeScript strict everywhere. Prefer small pure functions; they are easy to unit-test.
- Filenames: Vue components `PascalCase.vue`, composables `useThing.ts`, everything else `kebab-case.ts`.
- Comments explain *why*, not *what*. Match the density of the surrounding code.

**Server**
- **Explicit imports outside handlers.** Code in `server/services/**` and `server/utils/**` imports what it uses
  (`import { createError } from 'h3'`, `import { useDb } from '../../database/client'`) instead of relying on Nitro
  auto-imports, so it runs in plain Vitest. Route handlers in `server/api/**` may use auto-imports.
- **Route handlers** are thin: authenticate → validate → call a service → return.
  ```ts
  export default defineEventHandler(async (event) => {
    const caller = await requireUser(event)
    const body = await readValidatedBody(event, createRoomSchema.parse) // pass .parse, not .safeParse
    return createRoom(caller, body)
  })
  ```
- **Errors**: throw `apiError(code, status, details?)`. It wraps `createError` and puts a stable `data.code` from
  `shared/utils/error-codes/*` on the error. Never leak stack traces or internal messages.
- **Database**
  - DB access lives only in `server/services/**`.
  - Use the Drizzle core query builder with explicit transactions where invariants span tables.
  - Use atomic `UPDATE … WHERE … RETURNING` for counters and limits (for example invite `max_uses`).
- **Time and clocks**: services take an injectable `now()` so tests control time.
- **LiveKit**: go only through the `RoomService` adapter in `server/services/livekit/`.
  - Room metadata is written only by `publishRoomState(roomId)`.
  - Participant permissions are always computed as a whole object (LiveKit replaces them).

**Frontend**
- **Components**: `<script setup lang="ts">`. UI from `@/components/ui/*`, icons from `@lucide/vue`, toasts via
  `toast()` from `vue-sonner`.
- **Forms**: TanStack Form + shadcn `Field` + the shared zod schema.
- **Call state** lives in Pinia stores and composables.
  - Wrap LiveKit objects in `markRaw`/`shallowRef`; never make them deeply reactive.
  - New call features go under `app/lib/call/features/<feature>/` and `app/components/call/<feature>/`.
  - Registries pick them up via `import.meta.glob`. Don't edit the core call page to add a feature.

**UI copy** — English, short, sentence case, no exclamation marks. Errors say what happened and what to do.

## 7. Testing rules

- **Where tests go**
  - Unit tests are colocated `*.test.ts` in `app/lib/**`, `app/composables/**`, `shared/**`, `server/services/**`
    and `server/utils/**`.
  - **Never** put tests under `server/api|routes|middleware|plugins|tasks`: Nitro would register them as routes.
  - API tests go in `tests/api/<domain>/*.test.ts`. E2E specs go in `tests/e2e/<area>/*.spec.ts`, with fixtures in
    `tests/e2e/fixtures/` (combined with `mergeTests`).
- **Isolation**
  - API tests use unique data per test and never depend on order.
  - Rate-limit tests vary `X-Forwarded-For`; the app only trusts it because it is reachable solely from loopback
    behind Caddy.
- **LiveKit in E2E**
  - Mint LiveKit tokens in Playwright fixtures with `livekit-server-sdk` (`joinAs(role)`).
  - Test-only browser hooks exist only in `pnpm build:test` output (`BLINQ_TEST_HOOKS=1`, `window.__blinqTest`).
- **Every E2E run fails on**
  - a `securitypolicyviolation` event,
  - a console error,
  - a secret appearing in app or Caddy logs.
- **Timing assertions**: generous on PR (join <6 s), strict p95 in nightly (<3 s), report-only locally.

## 8. Known gotchas (verified)

**Nuxt, Nitro and tooling**
- **Nitro v2 does not await async plugins.** Migrations and bootstrap run in the pre-start CLI, not in plugins.
- **`process.env.NODE_ENV` is inlined at build time.** Use the build-time `BLINQ_TEST_HOOKS` flag for test-only
  code, never `NODE_ENV`.
- **Test-only env overrides.** The built server does not read `.env`. Nuxt runtimeConfig env overrides need the
  `NUXT_` prefix; this project reads `process.env` through `server/utils/env.ts` instead.
- **h3 bodies.** `readValidatedBody(event, schema.parse)` works; `safeParse` returns the wrapper. For raw streams
  (uploads, webhooks) nothing may read the body before you.
- **nuxt-security**
  - Its default Permissions-Policy blocks camera, mic and display-capture. The project config overrides it; don't
    reintroduce the default.
  - `requestSizeLimiter` only checks `Content-Length` on POST/PUT/DELETE. Chunked bodies must be counted in the
    handler (and Caddy limits them).
- **shadcn-vue**
  - Drawer now uses reka-ui's primitive; its `direction` prop is `swipe-direction`.
  - Use `Field`, not `Form`.
- **@node-rs/argon2**: `Algorithm` is a const enum, so pass `algorithm: 2` (argon2id). The native binary must match
  the runtime libc, so build and run on the same Debian base.
- **Drizzle 0.45**
  - Migrations live in `server/database/migrations` (with `meta/_journal.json`) and are shipped in the image.
  - There is no `citext`: emails are lowercased in code.
  - `casing: 'snake_case'` is set in both `drizzle.config.ts` and the client (`useDb()`): TypeScript fields are
    camelCase, columns are snake_case.
  - Primary keys default to PostgreSQL 18 `uuidv7()`.
- **Non-ASCII test data** (Cyrillic keyboard layouts, bidi characters) must be written as `\u` escapes, never as
  literal characters. `check-english` rejects literal Cyrillic, and editors may silently turn escapes into
  characters — re-run `pnpm check:english`.
- **Test harness pages** live in `app/dev/*` and are registered by a `pages:extend` hook only in dev and test
  builds. Never put harness pages under `app/pages/`.
- **Nitro binds all interfaces by default.** Production sets `NITRO_HOST=127.0.0.1`; never remove it.
- **Typed `$fetch` routes:** Nitro's route inference explodes on dynamic string paths. Use `useApi()` (loosely
  typed, the caller supplies the response type) instead of raw `$fetch` with template strings.
- **Postgres 18 image**: mount `/var/lib/postgresql` (not `/data`).
- **zod 4 and CSP.** zod 4 JIT-compiles object parsers with `Function()`, which the production CSP blocks.
  `app/plugins/00.0-zod-jitless.client.ts` turns the JIT off in the browser. Keep it; never add `'unsafe-eval'`.

**LiveKit**
- Use the `encryption` room option (media + data). `e2ee` is deprecated.
  - Load the worker via `import E2EEWorker from 'livekit-client/e2ee-worker?worker'`.
  - Under E2EE there is no AV1, no backup codec and no RED.
  - Safari <17.2 must not simulcast with E2EE (the SDK guard only checks the old option).
  - Unencrypted data packets are still delivered, so check `encryptionType`. RPC has no encryption info, so blinq
    registers no RPC methods.
  - livekit-client 2.22.3 sends encrypted data packets without `encryption_type`, so receivers saw NONE.
    `patches/livekit-client@2.22.3.patch` (pnpm `patchedDependencies`) sets it; `app/lib/livekit/sdk-patch.test.ts`
    fails when an upgrade drops the patch. Re-check the upstream fix on every livekit-client upgrade.
- `autoSubscribe: false` + SubscriptionManager. Only subscribe to publications with encryption ≠ NONE.
- Server-originated data arrives with no participant. So do packets from unknown or hidden participants, so
  "no sender" is **not** proof of server origin: treat `blinq.srv.v1` as a refetch hint only.
- **Server config**
  - Strict parsing: an unknown key stops the server.
  - `bind_addresses` covers HTTP only; TURN binds `0.0.0.0`.
  - TURN/TLS is always advertised on port 443 of `turn.domain`.
  - Firefox rejects loopback ICE candidates, so dev LiveKit advertises the LAN IP (`scripts/detect-ip.sh`).

**Browser APIs**
- Chrome bug 40094084: remote WebRTC audio is silent in WebAudio/MediaRecorder unless the track is also attached to
  a media element. Keep elements attached.
- `requestFrame()` exists on the canvas track in Chrome/Safari and on the stream in Firefox.
- `supportsAudioOutputSelection()` is false on Safari/iOS/Android; hide the speaker picker there.
- Hotkeys:
  - Letters match `e.key` when it is a Latin letter, otherwise `e.code` (`KeyM`, `KeyV`), so shortcuts work on
    Cyrillic layouts.
  - Space push-to-talk matches `e.code === 'Space'` and ignores inputs and IME composition.

**This dev machine**
- `$HOME` contains an unrelated Node project with its own `node_modules`. Undeclared imports may resolve from there
  and "work" locally. ESLint `import-x/no-extraneous-dependencies` and the clean Docker build catch this. Never rely
  on a package that isn't in `package.json`.
- Homebrew Postgres owns port 5432; the dev stack uses **55432**.

## 9. Workflow for sub-agents

1. **Verify your base.** Run `git merge-base --is-ancestor <waveBaseSha> HEAD`. If it fails, stop and report: your
   worktree was created from the wrong commit.
2. **Set up the worktree.** Run `node scripts/worktree-setup.mjs <agent-name> <port>`. It installs with the frozen
   lockfile, creates and migrates the `blinq_<agent-name>` database on the shared dev Postgres, vendors assets and
   writes your `PORT`, `PUBLIC_URL` and `DATABASE_URL` into the worktree's `.env`.
3. **Never manage the shared dev stack.** Don't run `docker compose down` or `up` with different settings. If it is
   down, report it.
4. **Implement.** Read your stage file and implement its tasks inside your owned paths. Tick checkboxes in your
   stage file as you complete them.
5. **Check.** Run `sh scripts/with-lock.sh pnpm lint`, `pnpm typecheck`, your unit/API tests and relevant E2E specs.
   All must pass.
6. **Commit.** Use Conventional Commits in English (`feat(rooms): add invite revocation`). Several focused commits
   are better than one giant one. Don't push.
7. **Report** (final message, ≤400 words):
   ```
   Branch/commit: <branch> @ <sha>
   Done: <tasks completed>
   DoD: <each DoD item → pass/fail/not-run + evidence>
   Files: <main files added/changed>
   Requests: <deps, frozen-file or contract changes needed, with exact diffs or descriptions>
   Decisions/questions: <(decision) items, open questions>
   ```

## 10. Definition of Done (general, applies to every stage)

- Stage tasks are checked off, and every DoD item is verified with its evidence.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm check:english` are green. Relevant API/E2E
  specs pass.
- No new console errors, CSP violations or secrets in logs.
- Docs are updated where behavior changed (stage file, `docs/API.md` via request, README if user-facing).

DoD tags:
- `[auto]` — verified by an automated test or command in CI.
- `[agent-manual]` — the agent verifies it by running something locally and reports the result.
- `[user]` — only the user can verify (real server/DNS, physical devices, pushing to GitHub).

## 11. Git

- Main branch `main`. The orchestrator commits each merged stage or wave locally. **Nobody pushes** until the user
  asks.
- Sub-agents work in isolated worktrees (`.claude/worktrees/*`, ignored by git and tools) on their own branch.
- Conventional Commits, English, imperative mood. Never commit `.env` or anything under `public/vendor/` except the
  committed model files.
