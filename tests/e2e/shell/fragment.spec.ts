import { expect, test } from '@playwright/test'
import { spendJoinBudget } from '../join/support'
import {
  fragmentWrites,
  randomRoomKey,
  randomToken,
  recordFragmentWrites,
  routerLocation,
  waitForApp,
  watchPage,
} from './support'

// Pages opened here get made-up secrets; once their owners implement them, the API may answer 4xx.
const watchOptions = { ignoreResourceErrors: true }

test.describe('fragment capture', { tag: '@ui' }, () => {
  test('keeps the room key and invite token and strips them before the router or any middleware sees them', async ({
    page,
    baseURL,
  }) => {
    const watch = await watchPage(page, watchOptions)
    const key = randomRoomKey()
    const invite = randomToken('invite')
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await recordFragmentWrites(page)

    await page.goto(`/m/abc-defg-hjk?lang=en#k=${key}&t=${invite}`)
    await waitForApp(page)

    expect(await page.evaluate(() => location.hash)).toBe('')
    expect(page.url()).toBe(`${baseURL}/m/abc-defg-hjk?lang=en`)
    // vue-router's initial location (what route middleware received) and its history entry have no fragment.
    expect(await routerLocation(page)).toEqual({
      fullPath: '/m/abc-defg-hjk?lang=en',
      hash: '',
      historyState: '/m/abc-defg-hjk?lang=en',
    })
    expect(await fragmentWrites(page)).toEqual([
      ['blinq:fragment:/m/abc-defg-hjk', { kind: 'room', k: key, t: invite, invalidKey: false }],
    ])
    // Fragments never reach the server; nothing else leaks them either.
    expect(requests.filter((url) => url.includes(key) || url.includes(invite))).toEqual([])
    watch.expectClean()
  })

  // F-030: vue-router ignores letter case, so this URL opens the meeting page; the key must leave the address bar.
  test('strips the key from a mixed-case meeting path and keeps it for the page', async ({ page, baseURL }) => {
    const watch = await watchPage(page, watchOptions)
    const key = randomRoomKey()
    await recordFragmentWrites(page)
    await spendJoinBudget(1)
    await page.goto(`/M/Abc-Defg-Hjk#k=${key}`)
    await waitForApp(page)

    expect(await page.evaluate(() => location.hash)).toBe('')
    expect(page.url()).toBe(`${baseURL}/M/Abc-Defg-Hjk`)
    expect((await routerLocation(page)).hash).toBe('')
    expect(await fragmentWrites(page)).toEqual([
      ['blinq:fragment:/m/abc-defg-hjk', { kind: 'room', k: key, invalidKey: false }],
    ])
    // The meeting page took the key instead of asking for a link: it checked it with the server (the room does not
    // exist). A browser without encoded transforms (Linux WebKit in webkit-ui) stops at the unsupported-browser
    // screen before that, which is just as far from the missing-key screen (app/lib/livekit/support.ts).
    const e2ee = await page.evaluate(
      () =>
        typeof (window as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'undefined' ||
        (typeof RTCRtpSender !== 'undefined' && 'createEncodedStreams' in RTCRtpSender.prototype),
    )
    await expect(page.getByTestId('join-error')).toHaveAttribute(
      'data-code',
      e2ee ? 'ROOM_NOT_FOUND' : 'UNSUPPORTED_BROWSER',
    )
    watch.expectClean()
  })

  test('records a truncated key as invalid and still strips it', async ({ page }) => {
    const watch = await watchPage(page, watchOptions)
    await recordFragmentWrites(page)
    await page.goto(`/m/abc-defg-hjk#k=${randomRoomKey().slice(0, 20)}`)
    await waitForApp(page)

    expect(await page.evaluate(() => location.hash)).toBe('')
    expect(await fragmentWrites(page)).toEqual([['blinq:fragment:/m/abc-defg-hjk', { kind: 'room', invalidKey: true }]])
    watch.expectClean()
  })

  for (const path of ['/invite', '/verify-email', '/reset-password']) {
    test(`keeps the bare token of ${path}`, async ({ page }) => {
      const watch = await watchPage(page, watchOptions)
      const token = randomToken()
      await recordFragmentWrites(page)
      await page.goto(`${path}#${token}`)
      await waitForApp(page)

      expect(await page.evaluate(() => location.hash)).toBe('')
      expect((await routerLocation(page)).fullPath).toBe(path)
      expect(await fragmentWrites(page)).toEqual([[`blinq:fragment:${path}`, { kind: 'token', token }]])
      watch.expectClean()
    })
  }

  test('leaves ordinary anchors on other pages alone', async ({ page }) => {
    const watch = await watchPage(page)
    await recordFragmentWrites(page)
    await page.goto('/#features-title')
    await waitForApp(page)

    expect(await page.evaluate(() => location.hash)).toBe('#features-title')
    expect(await fragmentWrites(page)).toEqual([])
    watch.expectClean()
  })
})
