import type { WebSocketRoute } from '@playwright/test'
import { expect, test } from '../fixtures'
import type { InCall } from '../fixtures/flows'
import { callState, inboundAudio, receivers, waitForRemoteFrames } from '../fixtures/livekit'

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

/**
 * `viewer` sees and hears `publisher` through decrypting receivers. After a full reconnect every receiver is new, so
 * its audio energy starts at 0 again. F-067: livekit-client lost the reconnected side's TrackSubscribed events, so no
 * receiver transform was set up and no `<audio>` element was created; Chromium then decoded nothing, silently.
 */
async function expectDecryptedMedia(viewer: InCall, publisher: InCall) {
  await waitForRemoteFrames(viewer.page, publisher.identity, 10)
  await expect
    .poll(async () => (await inboundAudio(viewer.page, publisher.identity))[0]?.totalAudioEnergy ?? 0, {
      timeout: 20_000,
      message: `${viewer.name} hears ${publisher.name}`,
    })
    .toBeGreaterThan(0.01)
  await expect(
    viewer.page.locator(`[data-blinq-audio] audio[data-identity="${publisher.identity}"][data-source="microphone"]`),
  ).toHaveCount(1)
  // Every subscribed track of the publisher went through blinq's TrackSubscribed handler with a decrypting receiver.
  await expect
    .poll(
      async () =>
        (await receivers(viewer.page, publisher.identity)).map((r) => `${r.source}:${r.ready}:${r.transform}`).sort(),
      { timeout: 10_000, message: `${viewer.name}'s receivers of ${publisher.name}` },
    )
    .toEqual(['camera:true:true', 'microphone:true:true'])
  const state = await callState(viewer.page)
  expect(state?.e2eeEnabled).toBe(true)
  expect(state?.blocked).toEqual([])
  expect(state?.undecryptable).toEqual([])
  await expect(viewer.page.getByTestId('e2ee-badge')).toHaveAttribute('data-state', 'encrypted')
}

test.describe('reconnect', () => {
  for (const scenario of ['signal drop', 'server-requested reconnect'] as Scenario[]) {
    test(`the banner appears and clears (${scenario})`, async ({ flows, guards }, testInfo) => {
      // A full reconnect: the old session's participant_left marks the row `left`, and the new session's
      // participant_joined takes it back instead of enforcing a removal (F-039). The reconnected client sets up a
      // decrypting receiver for every track again (F-067).
      // A full reconnect tears the old peer connections down; the SDK logs their data channels closing.
      if (scenario === 'server-requested reconnect') {
        guards.allowConsoleError(
          /DataChannel error on \w+: User-Initiated Abort|data channel '\w+' closed unexpectedly/,
        )
      }
      const sockets: WebSocketRoute[] = []
      const account = await flows.loginAs('host', { name: 'Hana Host' })
      await account.page.routeWebSocket(/\/rtc/, (socket) => {
        socket.connectToServer()
        sockets.push(socket)
      })
      const room = await flows.createRoom({ name: 'Reconnect', waitingRoom: false })
      await flows.open(account, room.link)
      const host = await flows.enterCall(account)
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
      // Media flows again, decrypted, in both directions.
      await expectDecryptedMedia(host, peer)
      await expectDecryptedMedia(peer, host)
    })
  }
})
