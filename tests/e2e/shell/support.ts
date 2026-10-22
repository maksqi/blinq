import { randomBytes } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import { isFrameworkNoise } from '../fixtures/base'

/**
 * Shell spec helpers. They rely only on Playwright's `baseURL`, so the specs run against `pnpm dev` today and
 * against the shared E2E harness (tests/e2e/fixtures/base.ts) once it exists.
 */

export interface PageWatch {
  /** Console errors, uncaught exceptions and CSP violations seen so far. */
  readonly problems: string[]
  expectClean(): void
}

export interface WatchOptions {
  /**
   * Ignore "Failed to load resource" console messages. Only for pages opened with made-up secrets, where the page
   * owner may legitimately get a 4xx from the API.
   */
  ignoreResourceErrors?: boolean
}

/** Fails a test on console errors, uncaught exceptions and `securitypolicyviolation` events (docs/TESTING.md). */
export async function watchPage(page: Page, options: WatchOptions = {}): Promise<PageWatch> {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (options.ignoreResourceErrors && message.text().startsWith('Failed to load resource')) return
    if (isFrameworkNoise(message.text())) return
    problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    // The same benign framework messages the fixtures allow, e.g. WebKit's cancelled build-manifest fetch after a full
    // navigation (fixtures/base.ts).
    if (isFrameworkNoise(`${error.name}: ${error.message}`)) return
    problems.push(`pageerror: ${error.message}`)
  })
  await page.exposeFunction('__blinqShellCspViolation', (detail: string) => problems.push(`csp: ${detail}`))
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __blinqShellCspViolation?: (detail: string) => void }).__blinqShellCspViolation
      report?.(`${event.violatedDirective} ${event.blockedURI || 'inline'}`)
    })
  })
  return {
    problems,
    expectClean: () => expect(problems, 'console errors, page errors or CSP violations').toEqual([]),
  }
}

/** A random 32-byte room key, base64url without padding (43 characters), like `encodeRoomKey()`. */
export function randomRoomKey(): string {
  return randomBytes(32).toString('base64url')
}

/** A random opaque token in the fragment token alphabet. */
export function randomToken(prefix = 'token'): string {
  return `${prefix}-${randomBytes(18).toString('base64url')}`
}

/**
 * Emulates the OS color scheme for the rest of the test. Playwright's Firefox drops an emulated scheme when
 * `Cross-Origin-Opener-Policy: same-origin` moves the first navigation into a new browsing context group, so one
 * app page is loaded first; later same-origin navigations keep the emulation.
 */
export async function emulateColorScheme(page: Page, colorScheme: 'light' | 'dark'): Promise<void> {
  await page.goto('/')
  // Let the page settle: navigating away mid-load aborts module imports, which Firefox reports as page errors.
  await waitForApp(page)
  await page.emulateMedia({ colorScheme })
}

/** Waits until the Nuxt app is mounted (the router has finished its initial navigation). */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const root = document.querySelector('#__nuxt') as (Element & { __vue_app__?: unknown }) | null
    return Boolean(root?.__vue_app__)
  })
  await page.waitForLoadState('networkidle')
}

/** The route as vue-router sees it, which is also what every route middleware saw. */
export async function routerLocation(page: Page): Promise<{ fullPath: string; hash: string; historyState: unknown }> {
  return page.evaluate(() => {
    type RouterLike = { currentRoute: { value: { fullPath: string; hash: string } } }
    const root = document.querySelector('#__nuxt') as Element & {
      __vue_app__: { config: { globalProperties: { $router: RouterLike } } }
    }
    const route = root.__vue_app__.config.globalProperties.$router.currentRoute.value
    return { fullPath: route.fullPath, hash: route.hash, historyState: (history.state as { current?: unknown } | null)?.current }
  })
}

/** Records every sessionStorage write of a captured fragment, before any page gets a chance to `take()` it. */
export async function recordFragmentWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: Array<[string, string]> = []
    Object.defineProperty(window, '__fragmentWrites', { value: writes })
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage && key.startsWith('blinq:fragment:')) writes.push([key, value])
      return setItem.call(this, key, value)
    }
  })
}

export async function fragmentWrites(page: Page): Promise<Array<[string, unknown]>> {
  const writes = await page.evaluate(
    () => (window as unknown as { __fragmentWrites: Array<[string, string]> }).__fragmentWrites,
  )
  return writes.map(([key, value]) => [key, JSON.parse(value)])
}
