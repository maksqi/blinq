/**
 * Global E2E guards (docs/TESTING.md §6.5). A test that uses `test` from this file (directly or through the merged
 * fixtures) fails when
 * - a `securitypolicyviolation` event fires in one of its pages,
 * - a console error or an uncaught page error appears, unless the test allows it (`allowConsoleErrors` option or
 *   `guards.allowConsoleError()`),
 * - a secret shows up in the app log or the e2e Caddy log while it runs: a tracked value (`secrets.track()`), an
 *   environment secret, or a generic secret shape (JWT, `access_token=`, `#k=`, session cookies, passwords).
 *
 * scripts/e2e.sh writes the logs to E2E_LOG_DIR (logs/e2e/app.log, logs/e2e/caddy.log) and sets E2E_REQUIRE_LOGS=1.
 * Other fixture files extend this `test` so that `mergeTests` keeps a single copy of the guards.
 *
 * Every watched context also waits for hydration after `page.goto()`, `reload()`, `goBack()` and `goForward()`
 * (`waitForHydration`): a click before hydration does nothing, and hydration resets fields filled before it.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { test as base, expect, type BrowserContext, type Page, type Response } from '@playwright/test'

export { expect }

export interface CspViolation {
  documentURI: string
  effectiveDirective: string
  violatedDirective: string
  blockedURI: string
  sourceFile: string
  lineNumber: number
  sample: string
  disposition: string
}

export interface PageProblem {
  kind: 'console' | 'pageerror'
  text: string
  /** Script location of a console message, or the page URL of an uncaught error. */
  url: string
}

/** Everything one watched browser context recorded. */
export interface ContextRecorder {
  readonly cspViolations: CspViolation[]
  readonly problems: PageProblem[]
}

export interface WatchOptions {
  /**
   * Navigations of the context's pages wait for hydration (`waitForHydration`). Default true; off for contexts with
   * JavaScript disabled, where nothing ever hydrates.
   */
  hydration?: boolean
}

export interface Guards {
  /** Applies the guards to a context the test creates itself (`browser.newContext()`, a second browser). */
  watch(context: BrowserContext, options?: WatchOptions): Promise<void>
  /** Allows console errors matching `pattern` (text or script URL) for the rest of the test. Deliberate errors only. */
  allowConsoleError(pattern: string | RegExp): void
}

export interface Secrets {
  /** Registers a value (room key, join proof, token, password) that must never appear in the app or Caddy log. */
  track(value: string, label?: string): void
  /** Fails right away if a tracked value or a secret-shaped string was logged since the test started. */
  expectNoLeaks(): Promise<void>
}

export interface Leak {
  file: string
  kind: string
  /** The log line with every secret replaced by <masked>, shortened. Never contains the secret itself. */
  excerpt: string
}

export type LogName = 'app.log' | 'caddy.log'

const LOG_NAMES: readonly LogName[] = ['app.log', 'caddy.log']
/** Environment secrets that scripts/e2e.sh passes to the app; they must never be logged either. */
const ENV_SECRETS = ['APP_SECRET', 'LIVEKIT_API_SECRET', 'RECORDING_ENCRYPTION_KEY', 'ADMIN_PASSWORD', 'SMTP_PASSWORD']
/** Shorter values would match unrelated log text. */
const MIN_SECRET_LENGTH = 8
/** Time for the last log lines of a test to reach the files (the Caddy log is copied by `docker compose logs -f`). */
const LOG_SETTLE_MS = 300
const CSP_BINDING = '__blinqE2eCspViolation'

/** Secret shapes that must never appear in a log line, whoever wrote it. */
export const SECRET_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: 'JWT (LiveKit, webhook or other token)', pattern: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/ },
  { kind: 'access_token parameter', pattern: /\baccess_token=(?!REDACTED\b)[^\s&"'\\]+/ },
  { kind: 'room key fragment (#k=)', pattern: /[#&]k=[\w-]{16,}/ },
  { kind: 'token fragment (#t=)', pattern: /[#&]t=[\w-]{16,}/ },
  { kind: 'link token fragment', pattern: /\/(?:invite|verify-email|reset-password)#[\w-]{16,}/ },
  { kind: 'session or guest cookie', pattern: /\b(?:__Host-)?blinq_(?:session|g_[\w-]+)=(?!REDACTED\b)[^\s;"',]+/ },
  { kind: 'bearer token', pattern: /\bBearer\s+(?!REDACTED\b)[\w.~+/-]{16,}/ },
  {
    kind: 'password field',
    pattern: /"(?:password|newPassword|currentPassword)"\s*:\s*"(?![^"]*redact)(?!\**")[^"]*"/i,
  },
]

const MASKS = SECRET_PATTERNS.map(({ pattern }) => new RegExp(pattern.source, `${pattern.flags}g`))

/** Undoes the JSON and URL escapes that could hide a secret shape in a log line. */
function normalize(line: string): string {
  return line
    .replace(/\\u0026/g, '&')
    .replace(/\\u003[dD]/g, '=')
    .replace(/\\u0023/g, '#')
    .replace(/%26/g, '&')
    .replace(/%3[dD]/g, '=')
    .replace(/%23/g, '#')
    .replace(/%2[fF]/g, '/')
}

/** The forms a tracked value can take in a (normalized) log line: raw, URL-encoded, JSON-escaped. Longest first. */
function variants(value: string): string[] {
  const forms = [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]
  return [...new Set([...forms, ...forms.map(normalize)])].sort((a, b) => b.length - a.length)
}

/** Finds secrets in log text. Exported for the guard self-tests. */
export function findLeaks(text: string, tracked: ReadonlyMap<string, string> = new Map(), file = 'text'): Leak[] {
  const trackedForms = [...tracked].flatMap(([value, label]) => variants(value).map((form) => ({ form, label })))
  const leaks = new Map<string, Leak>()
  for (const raw of text.split('\n')) {
    if (!raw) continue
    const line = normalize(raw)
    const kinds = SECRET_PATTERNS.filter(({ pattern }) => pattern.test(line)).map(({ kind }) => kind)
    for (const { form, label } of trackedForms) {
      if (line.includes(form)) kinds.push(`tracked ${label}`)
    }
    if (kinds.length === 0) continue
    // The excerpt is built from the normalized line, which every tracked form is also matched against.
    let excerpt = line
    for (const { form } of trackedForms) excerpt = excerpt.split(form).join('<masked>')
    for (const mask of MASKS) excerpt = excerpt.replace(mask, '<masked>')
    excerpt = excerpt.length > 240 ? `${excerpt.slice(0, 240)}...` : excerpt
    for (const kind of kinds) leaks.set(`${file}\n${kind}\n${excerpt}`, { file, kind, excerpt })
  }
  return [...leaks.values()]
}

/** Path of an E2E log file written by scripts/e2e.sh. */
export function e2eLogFile(name: LogName): string {
  return join(process.env.E2E_LOG_DIR ?? join(process.cwd(), 'logs', 'e2e'), name)
}

type Offsets = ReadonlyMap<LogName, number>

/** The app and Caddy logs, read incrementally from byte offsets. */
class E2eLogs {
  private readonly names: readonly LogName[]

  constructor(names: readonly LogName[]) {
    this.names = names
  }

  offsets(): Offsets {
    return new Map(this.names.map((name) => [name, fileSize(e2eLogFile(name))]))
  }

  leaksSince(start: Offsets, tracked: ReadonlyMap<string, string>): Leak[] {
    return this.names.flatMap((name) => findLeaks(readFrom(e2eLogFile(name), start.get(name) ?? 0), tracked, name))
  }
}

function fileSize(path: string): number {
  const fd = openSync(path, 'r')
  try {
    return fstatSync(fd).size
  } finally {
    closeSync(fd)
  }
}

function readFrom(path: string, offset: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = size < offset ? 0 : offset // truncated since: read it all
    const buffer = Buffer.alloc(size - start)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read)
      if (n === 0) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function openLogs(): E2eLogs {
  const missing = LOG_NAMES.filter((name) => !existsSync(e2eLogFile(name)))
  if (missing.length > 0) {
    const paths = missing.map(e2eLogFile).join(', ')
    if (process.env.E2E_REQUIRE_LOGS === '1') throw new Error(`E2E logs not found: ${paths}`)
    console.warn(`[e2e] ${paths} not found, so logs are not checked for secrets. Run E2E with sh scripts/e2e.sh.`)
  }
  return new E2eLogs(LOG_NAMES.filter((name) => !missing.includes(name)))
}

function envSecrets(): Map<string, string> {
  const secrets = new Map<string, string>()
  for (const name of ENV_SECRETS) {
    const value = process.env[name]
    if (value && value.length >= MIN_SECRET_LENGTH) secrets.set(value, name)
  }
  return secrets
}

function leakReport(leaks: readonly Leak[], scope: string): string {
  const lines = leaks.slice(0, 20).map((leak) => `  [${leak.file}] ${leak.kind}: ${leak.excerpt}`)
  const more = leaks.length > 20 ? [`  ... and ${leaks.length - 20} more`] : []
  return [`Secrets were written to the E2E logs during ${scope} (docs/SECURITY.md §8):`, ...lines, ...more].join('\n')
}

async function expectHarness(baseURL: string): Promise<void> {
  const url = new URL('/api/health', baseURL).toString()
  let problem: string | undefined
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    if ([502, 503, 504].includes(response.status)) problem = `HTTP ${response.status} (the app behind Caddy is down)`
  } catch (error) {
    problem =
      error instanceof Error ? `${error.message}${error.cause ? ` (${String(error.cause)})` : ''}` : String(error)
  }
  if (problem) {
    throw new Error(
      `The E2E harness does not answer at ${url}: ${problem}. Run E2E with sh scripts/e2e.sh (docs/TESTING.md §6.2).`,
    )
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs in every page of a watched context, before any page script. Must stay self-contained (serialized). */
function installCspListener(binding: string) {
  addEventListener(
    'securitypolicyviolation',
    (event) => {
      const report = (globalThis as unknown as Record<string, ((violation: unknown) => void) | undefined>)[binding]
      report?.({
        documentURI: event.documentURI,
        effectiveDirective: event.effectiveDirective,
        violatedDirective: event.violatedDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        lineNumber: event.lineNumber,
        sample: event.sample,
        disposition: event.disposition,
      })
    },
    true,
  )
}

/** Generous: the test build hydrates in well under a second, even on a busy runner. */
const HYDRATION_TIMEOUT_MS = 20_000
const hydrationWaiting = new WeakSet<Page>()

/**
 * Runs in the page: true when the document has no Nuxt app, or when Nuxt has finished hydrating it. Nuxt turns
 * `isHydrating` off when the root `<Suspense>` resolves, right before `app:suspense:resolve` (`deferHydration` in
 * nuxt/dist/app/nuxt.js), for client-only routes too and after an error during hydration. `__vue_app__` alone is set
 * earlier, before the async page components have hydrated.
 */
function nuxtSettled(): boolean {
  type NuxtRoot = Element & { __vue_app__?: { $nuxt?: { isHydrating?: boolean } } }
  const root = document.querySelector('#__nuxt') as NuxtRoot | null
  if (!root) return true
  return root.__vue_app__?.$nuxt?.isHydrating === false
}

/**
 * Waits until the Nuxt app on `page` has hydrated. Before that a server-rendered button has no handler (a click does
 * nothing) and mounting `v-model` resets every field filled in so far (F-069, F-070). Pages without a Nuxt app pass at
 * once. Watched pages wait by themselves after `goto`, `reload`, `goBack` and `goForward`; call this after a full
 * navigation the page starts itself (`window.location`).
 */
export async function waitForHydration(page: Page, timeout = HYDRATION_TIMEOUT_MS): Promise<void> {
  try {
    await page.waitForFunction(nuxtSettled, undefined, { polling: 50, timeout })
  } catch (error) {
    if (page.isClosed()) return
    // Without the fragment: it may hold a room key.
    const where = page.url().split('#')[0]
    throw new Error(`The Nuxt app on ${where} did not finish hydrating within ${timeout} ms`, { cause: error })
  }
}

type NavigationOptions = { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' } | undefined

async function hydrateAfter(page: Page, response: Response | null, options: NavigationOptions): Promise<void> {
  // `commit` asks for the document before any script ran; a non-HTML answer (JSON, a file) has no app.
  if (options?.waitUntil === 'commit') return
  if (response && !/^text\/html\b/i.test(response.headers()['content-type'] ?? '')) return
  await waitForHydration(page)
}

/** Makes `goto`, `reload`, `goBack` and `goForward` of `page` resolve only once the app has hydrated. */
function hydrateAfterNavigations(page: Page): void {
  if (hydrationWaiting.has(page)) return
  hydrationWaiting.add(page)
  const goto = page.goto.bind(page)
  const reload = page.reload.bind(page)
  const goBack = page.goBack.bind(page)
  const goForward = page.goForward.bind(page)
  page.goto = async (url, options) => {
    const response = await goto(url, options)
    await hydrateAfter(page, response, options)
    return response
  }
  page.reload = async (options) => {
    const response = await reload(options)
    await hydrateAfter(page, response, options)
    return response
  }
  page.goBack = async (options) => {
    const response = await goBack(options)
    await hydrateAfter(page, response, options)
    return response
  }
  page.goForward = async (options) => {
    const response = await goForward(options)
    await hydrateAfter(page, response, options)
    return response
  }
}

/**
 * Records CSP violations, console errors and uncaught errors of every page in `context`. The fixtures apply it to the
 * test's context automatically; `guards.watch()` applies it to contexts a test creates. Exported for self-tests.
 */
export async function watchContext(context: BrowserContext): Promise<ContextRecorder> {
  const recorder: ContextRecorder = { cspViolations: [], problems: [] }
  await context.exposeBinding(CSP_BINDING, (_source, violation: CspViolation) => {
    recorder.cspViolations.push(violation)
  })
  await context.addInitScript(installCspListener, CSP_BINDING)
  context.on('console', (message) => {
    if (message.type() !== 'error') return
    recorder.problems.push({
      kind: 'console',
      text: message.text(),
      url: message.location().url || (message.page()?.url() ?? ''),
    })
  })
  context.on('weberror', (webError) => {
    const error = webError.error()
    recorder.problems.push({
      kind: 'pageerror',
      text: `${error.name}: ${error.message}`,
      url: webError.page()?.url() ?? '',
    })
  })
  return recorder
}

function matches(problem: PageProblem, pattern: string | RegExp): boolean {
  const haystack = `${problem.text}\n${problem.url}`
  if (typeof pattern === 'string') return haystack.includes(pattern)
  pattern.lastIndex = 0
  return pattern.test(haystack)
}

function describeViolation(v: CspViolation): string {
  const where = v.sourceFile ? ` at ${v.sourceFile}:${v.lineNumber}` : ''
  const sample = v.sample ? ` (sample: ${v.sample})` : ''
  return `  ${v.effectiveDirective || v.violatedDirective} blocked ${v.blockedURI || 'inline code'} on ${v.documentURI}${where}${sample}`
}

interface WorkerState {
  logs: E2eLogs
  env: ReadonlyMap<string, string>
  /** Every value tracked by a test in this worker, for the final scan when the worker stops. */
  tracked: Map<string, string>
}

interface TestState {
  guards: Guards
  secrets: Secrets
}

/**
 * Benign framework messages allowed in every test. Nuxt fetches the build manifest in the background about a second
 * after load; when a navigation cancels that request, WebKit and Firefox log `[NUXT_E5002]`. blinq has no client-side
 * route rules or prerendered pages, so the manifest is never needed (Stage 10, F-063).
 */
const FRAMEWORK_NOISE: RegExp[] = [/^\[NUXT_E5002\](?:\n|$)/]

export const test = base.extend<
  { allowConsoleErrors: (string | RegExp)[]; guards: Guards; secrets: Secrets; _e2eTest: TestState },
  { _e2eWorker: WorkerState }
>({
  /** Console errors (text or script URL) a whole file or describe block expects: `test.use({ allowConsoleErrors })`. */
  allowConsoleErrors: [[], { option: true }],

  _e2eWorker: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires an object pattern here
    async ({}, use, workerInfo) => {
      await expectHarness(process.env.E2E_BASE_URL ?? workerInfo.project.use.baseURL ?? 'http://localhost:8080')
      const logs = openLogs()
      const start = logs.offsets()
      const state: WorkerState = { logs, env: envSecrets(), tracked: new Map() }
      await use(state)
      // WebSocket and SSE requests are logged when they close, after their test's own scan.
      await sleep(1_000)
      const leaks = logs.leaksSince(start, new Map([...state.env, ...state.tracked]))
      if (leaks.length > 0) throw new Error(leakReport(leaks, 'this worker'))
    },
    { scope: 'worker', auto: true },
  ],

  _e2eTest: [
    async ({ context, allowConsoleErrors, javaScriptEnabled, _e2eWorker }, use, testInfo) => {
      const allowed = [...allowConsoleErrors, ...FRAMEWORK_NOISE]
      const recorders: ContextRecorder[] = []
      const watched = new WeakSet<BrowserContext>()
      const tracked = new Map<string, string>()
      const start = _e2eWorker.logs.offsets()
      const leaks = () => _e2eWorker.logs.leaksSince(start, new Map([..._e2eWorker.env, ...tracked]))

      const guards: Guards = {
        async watch(target, options = {}) {
          if (watched.has(target)) return
          watched.add(target)
          if (options.hydration !== false) {
            target.on('page', hydrateAfterNavigations)
            target.pages().forEach(hydrateAfterNavigations)
          }
          recorders.push(await watchContext(target))
        },
        allowConsoleError(pattern) {
          allowed.push(pattern)
        },
      }
      const secrets: Secrets = {
        track(value, label = 'secret') {
          if (value.length < MIN_SECRET_LENGTH) {
            throw new Error(
              `secrets.track(${label}): values shorter than ${MIN_SECRET_LENGTH} characters match unrelated text`,
            )
          }
          tracked.set(value, label)
          _e2eWorker.tracked.set(value, label)
        },
        async expectNoLeaks() {
          await sleep(LOG_SETTLE_MS)
          const found = leaks()
          if (found.length > 0) throw new Error(leakReport(found, 'this test'))
        },
      }

      // The pre-hydration specs turn JavaScript off (auth/prehydration): their pages never hydrate.
      await guards.watch(context, { hydration: javaScriptEnabled !== false })
      await use({ guards, secrets })
      await sleep(LOG_SETTLE_MS)

      const failures: string[] = []
      const violations = recorders.flatMap((recorder) => recorder.cspViolations)
      if (violations.length > 0) {
        await testInfo.attach('csp-violations.json', {
          body: JSON.stringify(violations, null, 2),
          contentType: 'application/json',
        })
        failures.push(
          ['Content-Security-Policy violations (docs/TESTING.md §6.5):', ...violations.map(describeViolation)].join(
            '\n',
          ),
        )
      }
      const problems = recorders
        .flatMap((recorder) => recorder.problems)
        .filter((problem) => !allowed.some((pattern) => matches(problem, pattern)))
      if (problems.length > 0) {
        failures.push(
          [
            'Console errors or uncaught page errors (allow deliberate ones with guards.allowConsoleError()):',
            ...problems.map((p) => `  [${p.kind}] ${p.text}${p.url ? ` (${p.url})` : ''}`),
          ].join('\n'),
        )
      }
      const found = leaks()
      if (found.length > 0) {
        await testInfo.attach('log-leaks.txt', { body: leakReport(found, 'this test'), contentType: 'text/plain' })
        failures.push(leakReport(found, 'this test'))
      }
      if (failures.length > 0) throw new Error(failures.join('\n\n'))
    },
    { auto: true },
  ],

  guards: async ({ _e2eTest }, use) => {
    await use(_e2eTest.guards)
  },

  secrets: async ({ _e2eTest }, use) => {
    await use(_e2eTest.secrets)
  },
})
