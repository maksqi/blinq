import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { callState, waitForPhase, waitForRemoteFrames } from '../fixtures/livekit'
import { chooseBlur, chooseNoise, mediaState, waitForBlur, waitForNoise } from '../fixtures/media'
import { closeE2eDb, createUser as createPasswordUser } from '../auth/support'
import { leaveCalls, newWatchedContext, openToPrejoin, pressJoin, spendJoinBudget } from '../join/support'

// Stage 10 DoD (docs/SECURITY.md §5 and §9): across the real product flows the browser talks to the app's own origin
// only. Signaling (WebSocket) goes through the same origin in E2E; ICE and media are not HTTP. The flow: home, sign-in,
// dashboard, a room created in the browser, the pre-join screen with background blur and RNNoise, the call with an
// invited guest, the room page, the recordings and settings pages. Everything both browsers request (Playwright
// request and WebSocket events, plus resource timing for what those miss) must be same-origin, `blob:` or `data:`.
// tests/e2e/media/no-external-requests.spec.ts proves the effect assets come from /vendor/.

interface Recorder {
  urls: Set<string>
  watch(context: BrowserContext): void
  timings(page: Page): Promise<void>
}

function recorder(): Recorder {
  const urls = new Set<string>()
  return {
    urls,
    watch(context) {
      context.on('request', (request) => urls.add(request.url()))
      const onPage = (page: Page) => page.on('websocket', (socket) => urls.add(socket.url()))
      context.on('page', onPage)
      context.pages().forEach(onPage)
    },
    async timings(page) {
      if (page.isClosed()) return
      const names = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name)).catch(() => [])
      names.forEach((name) => urls.add(name))
    },
  }
}

function foreign(urls: Iterable<string>, origin: URL): string[] {
  return [...urls].filter((raw) => {
    const url = new URL(raw)
    if (url.protocol === 'blob:' || url.protocol === 'data:') return false
    return !(url.protocol.replace(/^ws/, 'http') === origin.protocol && url.host === origin.host)
  })
}

/** No `<link rel=preconnect|dns-prefetch|prefetch|preload>` or `<script src>` points to another origin. */
async function expectNoForeignHints(page: Page): Promise<void> {
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[href], script[src], img[src], source[src], iframe[src]')].map(
      (element) => (element as HTMLLinkElement).href || (element as HTMLScriptElement).src,
    ),
  )
  const origin = new URL(page.url()).origin
  expect(hrefs.filter((href) => /^https?:/.test(href) && new URL(href).origin !== origin), `foreign references on ${page.url()}`).toEqual([])
}

test.describe('no requests to other hosts', () => {
  test.setTimeout(180_000)
  test.afterAll(closeE2eDb)

  test('home, sign-in, dashboard, pre-join with effects, the call, room, recordings and settings pages', async ({
    page,
    context,
    browser,
    baseURL,
    guards,
    secrets,
  }) => {
    const origin = new URL(baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080')
    const seen = recorder()
    await context.addInitScript(() => performance.setResourceTimingBufferSize(5_000))
    seen.watch(context)

    // Home and sign-in.
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expectNoForeignHints(page)
    await seen.timings(page)
    const account = await createPasswordUser({ displayName: 'Hana Host' })
    secrets.track(account.password, 'password')
    await page.goto('/login')
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password', { exact: true }).fill(account.password)
    await seen.timings(page)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    await page.waitForLoadState('networkidle')
    await expectNoForeignHints(page)
    await seen.timings(page)

    // A room made in this browser, then the pre-join screen with strong blur and RNNoise.
    await page.getByTestId('new-room').click()
    const dialog = page.getByTestId('create-room-dialog')
    await dialog.getByLabel('Name').fill('Self-hosted only')
    await dialog.getByRole('switch', { name: 'Waiting room' }).click()
    await spendJoinBudget(2)
    await dialog.getByTestId('create-room-submit').click()
    await expect(page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
    await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
    await chooseBlur(page, 'strong')
    await waitForBlur(page, 'strong')
    const noise = (await mediaState(page))?.rnnoiseSupport.ok ? 'rnnoise' : 'browser'
    if (noise !== 'rnnoise') test.info().annotations.push({ type: 'note', description: 'RNNoise is not supported here; browser noise suppression used' })
    await chooseNoise(page, noise)
    await waitForNoise(page, noise)
    await expectNoForeignHints(page)
    await pressJoin(page)
    await waitForPhase(page, 'inCall')
    const hostIdentity = (await callState(page))!.identity!

    // The room page builds an invite link from the key in this browser; a guest joins with it.
    const roomPage = await context.newPage()
    await roomPage.goto('/dashboard')
    await roomPage.getByTestId('room-item').filter({ hasText: 'Self-hosted only' }).getByTestId('room-name').click()
    await expect(roomPage).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/)
    await roomPage.getByTestId('invite-create').click()
    const link = await roomPage.getByTestId('invite-link').first().inputValue()
    secrets.track(new URLSearchParams(new URL(link).hash.slice(1)).get('k')!, 'room key')
    await expectNoForeignHints(roomPage)
    await seen.timings(roomPage)

    const guestContext = await newWatchedContext(browser, guards)
    await guestContext.addInitScript(() => performance.setResourceTimingBufferSize(5_000))
    seen.watch(guestContext)
    const guest = await guestContext.newPage()
    await openToPrejoin(guest, link)
    await pressJoin(guest, 'Gus Guest')
    await waitForPhase(guest, 'inCall')
    const guestIdentity = (await callState(guest))!.identity!
    await waitForRemoteFrames(guest, hostIdentity, 10)
    await waitForRemoteFrames(page, guestIdentity, 10)
    await page.waitForTimeout(2_000)
    for (const viewer of [page, guest]) {
      await expectNoForeignHints(viewer)
      await seen.timings(viewer)
    }

    // Recordings and settings pages of the signed-in host.
    for (const path of ['/recordings', '/settings', '/settings/sessions']) {
      await roomPage.goto(path)
      await roomPage.waitForLoadState('networkidle')
      await expectNoForeignHints(roomPage)
      await seen.timings(roomPage)
    }

    await leaveCalls(guest, page)
    await guestContext.close()

    const urls = [...seen.urls]
    expect(urls.some((url) => url.startsWith('ws')), 'the LiveKit signaling WebSocket was seen').toBe(true)
    expect(urls.some((url) => url.includes('/vendor/')), 'effect assets were seen').toBe(true)
    expect(foreign(urls, origin), 'requests to other origins').toEqual([])
  })
})
