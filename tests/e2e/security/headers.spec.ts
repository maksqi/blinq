import type { APIResponse, Page, Response } from '@playwright/test'
import { expect, test } from '../fixtures'
import { HTTP_ERROR_CONSOLE, openToPrejoin } from '../join/support'

// Stage 10 DoD: CSP and the security headers on every page type, through the e2e Caddy (docs/SECURITY.md §5):
// SSR pages (home, login, dashboard, admin), the client-only call page, error pages (403, 404), `/_nuxt/*` assets, API
// JSON and a Caddy-generated answer. The base fixture fails every test on a `securitypolicyviolation` event, so each
// page also waits until the app has hydrated and the network is idle. No route renders a 500 page in normal operation,
// so the 500 copy of the error page is not reachable here (the API envelope for 5xx is covered by the API tests).

/** The CSP of docs/SECURITY.md §5 as directive → sources; the nonce is checked separately. */
const EXPECTED_CSP: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'", 'NONCE', "'strict-dynamic'", "'wasm-unsafe-eval'"],
  'worker-src': ["'self'", 'blob:'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'font-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'script-src-attr': ["'none'"],
}

const PERMISSIONS = ['camera', 'microphone', 'display-capture', 'fullscreen', 'speaker-selection', 'picture-in-picture', 'autoplay']

function parseCsp(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name.toLowerCase(), sources)
  }
  return directives
}

/** Checks the page CSP and returns its nonce. */
function expectPageCsp(header: string | undefined): string {
  expect(header, 'Content-Security-Policy').toBeTruthy()
  const csp = parseCsp(header!)
  expect([...csp.keys()].sort()).toEqual(Object.keys(EXPECTED_CSP).sort())
  let nonce = ''
  for (const [directive, expected] of Object.entries(EXPECTED_CSP)) {
    const actual = csp.get(directive)!
    expect(actual.length, `${directive}: ${actual.join(' ')}`).toBe(expected.length)
    expected.forEach((source, index) => {
      if (source !== 'NONCE') return expect(actual[index], directive).toBe(source)
      const match = actual[index]!.match(/^'nonce-([A-Za-z0-9+/_=-]{16,})'$/)
      expect(match, `${directive} nonce: ${actual[index]}`).toBeTruthy()
      nonce = match![1]!
    })
  }
  return nonce
}

/** The headers every HTML document carries (docs/SECURITY.md §5); HSTS comes from the production Caddy only. */
function expectDocumentHeaders(headers: Record<string, string>): void {
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-powered-by']).toBeUndefined()
  const permissions = headers['permissions-policy'] ?? ''
  for (const feature of PERMISSIONS) expect(permissions, feature).toContain(`${feature}=(self)`)
  expect(permissions).toContain('geolocation=()')
}

/** Every script tag of the served HTML carries the response's nonce, and no tag has an inline event handler. */
function expectNoncedHtml(html: string, nonce: string): void {
  const scripts = html.match(/<script\b[^>]*>/gi) ?? []
  expect(scripts.length).toBeGreaterThan(0)
  for (const tag of scripts) expect(tag, tag).toContain(`nonce="${nonce}"`)
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i)
}

async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((document.querySelector('#__nuxt') as { __vue_app__?: unknown } | null)?.__vue_app__))
  await page.waitForLoadState('networkidle')
}

async function checkDocument(page: Page, response: Response | null, status: number): Promise<string> {
  expect(response, 'navigation response').not.toBeNull()
  expect(response!.status()).toBe(status)
  const headers = response!.headers()
  expect(headers['content-type']).toMatch(/^text\/html/)
  const nonce = expectPageCsp(headers['content-security-policy'])
  expectDocumentHeaders(headers)
  expectNoncedHtml(await response!.text(), nonce)
  await hydrated(page)
  return nonce
}

test.describe('page headers', () => {
  test('home and login (anonymous SSR pages)', { tag: '@ui' }, async ({ page }) => {
    const first = await checkDocument(page, await page.goto('/'), 200)
    const second = await checkDocument(page, await page.goto('/'), 200)
    expect(second, 'a fresh nonce per response').not.toBe(first)
    await checkDocument(page, await page.goto('/login'), 200)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('dashboard (signed-in SSR page)', { tag: '@ui' }, async ({ page, context, rooms }) => {
    const user = await rooms.createUser({ displayName: 'Dana Dashboard' })
    await rooms.useIdentity(context, user)
    await checkDocument(page, await page.goto('/dashboard'), 200)
    await expect(page.getByTestId('new-room')).toBeVisible()
  })

  test('admin pages', { tag: '@ui' }, async ({ page, context, rooms }) => {
    const admin = await rooms.createUser({ role: 'admin', displayName: 'Ada Admin' })
    await rooms.useIdentity(context, admin)
    for (const path of ['/admin', '/admin/users', '/admin/settings']) await checkDocument(page, await page.goto(path), 200)
  })

  test('error pages: 403 for a signed-in non-admin, 404 for an unknown path', { tag: '@ui' }, async ({ page, context, rooms, guards }) => {
    guards.allowConsoleError(HTTP_ERROR_CONSOLE)
    // Nuxt reports the server-rendered error again while the error page hydrates (reported as a low finding).
    guards.allowConsoleError(/^\[NUXT_E1005\]/)
    const user = await rooms.createUser({ displayName: 'Uma User' })
    await rooms.useIdentity(context, user)
    await checkDocument(page, await page.goto('/admin'), 403)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await checkDocument(page, await page.goto(`/no-such-page-${Date.now()}`), 404)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('the client-only call page /m/<slug>', async ({ page, context, rooms }) => {
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { waitingRoom: false })
    await rooms.useIdentity(context, host)
    const documents: Response[] = []
    page.on('response', (response) => {
      if (response.request().isNavigationRequest() && new URL(response.url()).pathname === `/m/${room.slug}`) documents.push(response)
    })
    await openToPrejoin(page, room.link)
    expect(documents, 'document response of the call page').toHaveLength(1)
    const doc = documents[0]!
    expect(doc.status()).toBe(200)
    const nonce = expectPageCsp(doc.headers()['content-security-policy'])
    expectDocumentHeaders(doc.headers())
    const html = await doc.text()
    expectNoncedHtml(html, nonce)
    // Client-only: the room key and the room itself are never rendered on the server.
    expect(html).not.toContain(room.key)
    expect(html).not.toContain(room.name)
    await page.waitForLoadState('networkidle')
  })
})

test.describe('non-page responses', () => {
  test('/_nuxt assets are nosniff, immutable and of the right type', { tag: '@ui' }, async ({ page, request }) => {
    const response = await page.goto('/')
    const html = await response!.text()
    const scripts = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(\/_nuxt\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!)
    expect(scripts.length).toBeGreaterThan(0)
    for (const path of new Set(scripts)) {
      const asset = await request.get(path)
      expect(asset.status(), path).toBe(200)
      const headers = asset.headers()
      expect(headers['content-type'], path).toMatch(path.endsWith('.css') ? /^text\/css/ : /^(?:text|application)\/javascript/)
      expect(headers['x-content-type-options'], path).toBe('nosniff')
      expect(headers['cache-control'], path).toContain('immutable')
      expect(headers['x-powered-by']).toBeUndefined()
    }
  })

  test('API JSON through the proxy is no-store, nosniff and has a request id', { tag: '@ui' }, async ({ request }) => {
    const check = (res: APIResponse) => {
      const headers = res.headers()
      expect(headers['content-type']).toMatch(/^application\/json/)
      expect(headers['cache-control']).toBe('no-store')
      expect(headers['x-content-type-options']).toBe('nosniff')
      expect(headers['referrer-policy']).toBe('no-referrer')
      expect(headers['x-request-id']).toMatch(/^[A-Za-z0-9_-]{16}$/)
    }
    const config = await request.get('/api/config')
    expect(config.status()).toBe(200)
    check(config)
    const denied = await request.get('/api/auth/sessions')
    expect(denied.status()).toBe(401)
    check(denied)
    expect((await denied.json()).data.code).toBe('UNAUTHENTICATED')
  })

  test('the proxy answers /api/webhooks/* itself with 404 and never reaches the app', { tag: '@ui' }, async ({ request }) => {
    for (const path of ['/api/webhooks/livekit', '/api/webhooks', '/api/webhooks/other']) {
      const res = await request.post(path, { data: '{}', headers: { 'content-type': 'application/webhook+json' } })
      expect(res.status(), path).toBe(404)
      expect(res.headers()['x-request-id'], 'answered by Caddy, not the app').toBeUndefined()
      expect(await res.text()).toBe('')
    }
  })
})
