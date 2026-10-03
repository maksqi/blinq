import type { WebSocketRoute } from '@playwright/test'
import { expect, test } from '../fixtures'
import { callState, waitForRemoteFrames } from '../fixtures/livekit'

// DoD: the reconnect banner appears on Reconnecting/SignalReconnecting and clears after Reconnected. On the real
// meeting page the host's signaling WebSocket (`/rtc…`) runs through a Playwright WebSocket route that forwards every
// frame between the page and LiveKit, so the test can disturb the signal connection the way the network or the SFU
// would:
// - `signal drop`: the socket closes; the SDK resumes the session over a new socket (media keeps flowing);
// - `server-requested reconnect`: the route delivers a LiveKit `leave` with action RECONNECT (what a draining SFU node
//   sends); the SDK does a full reconnect (new signal and peer connections, tracks published again).
type Scenario = 'signal drop' | 'server-requested reconnect'

/** SignalResponse { leave (8): LeaveRequest { can_reconnect (1): true, action (3): RECONNECT (2) } }, protobuf. */
const LEAVE_RECONNECT = Buffer.from([0x42, 0x04, 0x08, 0x01, 0x18, 0x02])

test.describe('reconnect', () => {
  for (const scenario of ['signal drop', 'server-requested reconnect'] as Scenario[]) {
    test(`the banner appears and clears (${scenario})`, async ({ flows, guards }, testInfo) => {
      // pending finding: a full reconnect is removed by webhook enforcement (the old session's participant_left already
      // marked the row `left`), so the person lands on "You're not connected" instead of back in the call.
      test.fixme(scenario === 'server-requested reconnect', 'pending finding: full reconnect removed by enforcement')
      // A full reconnect tears the old peer connections down; the SDK logs their data channels closing.
      if (scenario === 'server-requested reconnect') {
        guards.allowConsoleError(/DataChannel error on \w+: User-Initiated Abort|data channel '\w+' closed unexpectedly/)
      }
      const sockets: WebSocketRoute[] = []
      const host = await flows.loginAs('host', { name: 'Hana Host' })
      await host.page.routeWebSocket(/\/rtc/, (socket) => {
        socket.connectToServer()
        sockets.push(socket)
      })
      const room = await flows.createRoom({ name: 'Reconnect', waitingRoom: false })
      await flows.open(host, room.link)
      await flows.enterCall(host)
      const peer = await flows.joinAsGuest(room, { name: 'Pete Peer' })
      await waitForRemoteFrames(host.page, peer.identity, 5)
      const signal = sockets.at(-1)
      expect(signal, 'the signal connection runs through the route').toBeDefined()

      const started = Date.now()
      if (scenario === 'signal drop') await signal!.close({ code: 4000, reason: 'e2e: signal drop' })
      else signal!.send(LEAVE_RECONNECT)

      const banner = host.page.getByTestId('reconnect-banner')
      await expect(banner).toBeVisible()
      await expect(banner).toHaveAttribute('data-state', 'reconnected', { timeout: 30_000 })
      testInfo.annotations.push({ type: 'reconnect-ms', description: String(Date.now() - started) })
      await expect(banner).toBeHidden({ timeout: 10_000 })
      expect(sockets.length, 'a new signal connection').toBeGreaterThan(1)

      const state = await callState(host.page)
      expect(state?.phase).toBe('inCall')
      expect(state?.phaseHistory).toContain('reconnecting')
      expect(state?.e2eeEnabled).toBe(true)
      // Media flows again, still encrypted, in both directions.
      await waitForRemoteFrames(host.page, peer.identity, 10)
      await waitForRemoteFrames(peer.page, host.identity!, 10)
      expect((await callState(host.page))?.badge).toBe('encrypted')
    })
  }
})
