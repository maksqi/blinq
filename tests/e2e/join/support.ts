/**
 * Helpers for the rooms-ui specs (tests/e2e/rooms, tests/e2e/join): the real `/m/<slug>` flow in a browser.
 *
 * - Every browser request reaches the app through the e2e Caddy, so all of them share one client IP and the `join-ip`
 *   limiter (30 info/join requests per minute) is a budget for the whole run: `spendJoinBudget(n)` waits before a
 *   page would push the run over it (docs/TESTING.md §6.1).
 * - `apiAs()` calls the API directly as a fixture user, for actions the `rooms` fixture has no helper for.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
// From base.ts, not the merged fixtures: fixtures/flows.ts imports this module (no import cycle).
import { expect, type Guards } from '../fixtures/base'

/** Browser console errors of deliberate 4xx answers (negative tests only). */
export const HTTP_ERROR_CONSOLE = /Failed to load resource: the server responded with a status of 4\d\d/

const JOIN_IP_LIMIT = 30
const JOIN_IP_WINDOW_MS = 60_000
/** Headroom for requests this module does not see (a retry, a reload by the app). */
const JOIN_IP_HEADROOM = 6

/** Margin over the server's window, for clock and request latency. */
const JOIN_IP_MARGIN_MS = 1_500

/**
 * Bookings live in a file next to the E2E logs, because the limiter outlives a Playwright worker: every project
 * (chromium, firefox) and every worker restart after a failure starts a fresh worker.
 */
function budgetFile(): string {
  return join(process.env.E2E_LOG_DIR ?? join(process.cwd(), 'logs', 'e2e'), 'join-ip-budget.json')
}

function readBookings(): number[] {
  try {
    const value = JSON.parse(readFileSync(budgetFile(), 'utf8')) as unknown
    return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
  } catch {
    return []
  }
}

function writeBookings(bookings: number[]): void {
  mkdirSync(dirname(budgetFile()), { recursive: true })
  writeFileSync(budgetFile(), JSON.stringify(bookings))
}

/** Waits until `count` more join-ip requests fit into the per-minute budget of this run, then books them. */
export async function spendJoinBudget(count: number): Promise<void> {
  const allowed = JOIN_IP_LIMIT - JOIN_IP_HEADROOM
  for (;;) {
    const now = Date.now()
    const live = readBookings()
      .filter((at) => at > now - JOIN_IP_WINDOW_MS - JOIN_IP_MARGIN_MS && at <= now)
      .sort((a, b) => a - b)
    if (live.length + count <= allowed) {
      writeBookings([...live, ...Array.from({ length: count }, () => now)])
      return
    }
    // The booking that has to expire before `count` more fit.
    const wait = live[live.length + count - allowed - 1]! + JOIN_IP_WINDOW_MS + JOIN_IP_MARGIN_MS - now
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, wait)))
  }
}

function publicOrigin(): string {
  return new URL(process.env.PUBLIC_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin
}

function apiOrigin(): string {
  const port = process.env.E2E_APP_PORT
  return port ? `http://127.0.0.1:${port}` : publicOrigin()
}

/** A request to the app as the owner of `who.cookie` (a fixture user or join result). */
export async function apiAs(
  who: { cookie: { name: string; value: string }; ip: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-forwarded-for': who.ip,
    cookie: `${who.cookie.name}=${who.cookie.value}`,
  }
  if (method !== 'GET') headers.origin = publicOrigin()
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(new URL(path, apiOrigin()), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const json = text && (res.headers.get('content-type') ?? '').includes('json')
  return { status: res.status, body: json ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

/** A new browser context watched by the guards (console errors, CSP, logs). */
export async function newWatchedContext(browser: Browser, guards: Guards): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await guards.watch(context)
  return context
}

/** The phase of the `/m/<slug>` flow on `page`. */
export function joinFlow(page: Page) {
  return page.getByTestId('join-flow')
}

/**
 * Opens a meeting link and waits for the pre-join screen (books the info and the join request). The pre-join screen is
 * the readiness signal, not the `load` event: Firefox sometimes never fires `load` on a fully rendered pre-join.
 */
export async function openToPrejoin(page: Page, link: string, joinRequests = 2): Promise<void> {
  await spendJoinBudget(joinRequests)
  await page.goto(link, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
}

/** Types the guest name (guests only) and presses Join. */
export async function pressJoin(page: Page, guestName?: string): Promise<void> {
  if (guestName) await page.getByLabel('Your name').fill(guestName)
  await page.getByTestId('join-button').click()
}

/** The waiting-room request id from the join answer that `action` triggers. */
export async function waitingRequestId(page: Page, slug: string, action: () => Promise<void>): Promise<string> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/api/join/${slug}`,
    ),
    action(),
  ])
  expect(response.status()).toBe(202)
  const body = (await response.json()) as { status: string; requestId: string }
  expect(body.status).toBe('waiting')
  return body.requestId
}

/** The room key `k` of a meeting link. */
export function keyOfLink(link: string): string {
  const k = new URLSearchParams(new URL(link).hash.slice(1)).get('k')
  if (!k) throw new Error('the link has no key')
  return k
}

/** Leaves the call gracefully on every page (a torn-down live connection makes the SDK log errors). */
export async function leaveCalls(...pages: Array<Page | undefined>): Promise<void> {
  for (const page of pages) {
    if (!page || page.isClosed()) continue
    await page
      .evaluate(async () => {
        const hooks = (window as unknown as { __blinqTest?: { state: { join?: { leave?: () => Promise<void> } } } })
          .__blinqTest
        await hooks?.state.join?.leave?.()
      })
      .catch(() => undefined)
  }
}
