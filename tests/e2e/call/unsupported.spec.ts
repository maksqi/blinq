import { expect, test } from '../fixtures'
import { spendJoinBudget } from '../join/support'

// A browser without encoded transforms (no E2EE) gets an explanation on the real meeting page and never connects: there
// is no unencrypted fallback (docs/SECURITY.md §3.2). The APIs are removed before any page script runs, so this runs in
// every project, WebKit included (@ui; Linux WebKit lacks them anyway).
test.describe('browser without E2EE support', { tag: '@ui' }, () => {
  test('sees the unsupported-browser screen and never opens a signaling connection', async ({ page, rooms }) => {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>
      delete w.RTCRtpScriptTransform
      const sender = w.RTCRtpSender as { prototype?: Record<string, unknown> } | undefined
      if (sender?.prototype) delete sender.prototype.createEncodedStreams
      const receiver = w.RTCRtpReceiver as { prototype?: Record<string, unknown> } | undefined
      if (receiver?.prototype) delete receiver.prototype.createEncodedStreams
    })
    const sockets: string[] = []
    page.on('websocket', (socket) => sockets.push(new URL(socket.url()).pathname))
    const joinRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/join/')) joinRequests.push(request.url())
    })

    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Old browser', waitingRoom: false })
    await spendJoinBudget(2)
    await page.goto(rooms.inviteLink(room, await rooms.createInvite(room, host)))

    const screen = page.getByTestId('join-error')
    await expect(screen).toHaveAttribute('data-code', 'UNSUPPORTED_BROWSER', { timeout: 20_000 })
    await expect(screen).toContainText("This browser can't join encrypted calls")
    await expect(page.getByTestId('join-button')).toHaveCount(0)
    await expect(page.getByTestId('prejoin')).toHaveCount(0)
    await page.waitForTimeout(1_000)
    expect(sockets.filter((path) => path.startsWith('/rtc'))).toEqual([])
    // The browser check runs before the link reaches the server.
    expect(joinRequests).toEqual([])
  })
})
