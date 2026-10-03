import { callState, inboundAudio, inboundVideo, randomRoomKey } from '../fixtures/livekit'
import { expect, test } from './support'

// DoD: a wrong-key peer gets no frames. The host is in the call on the real meeting page. The real join flow cannot
// produce a peer with another key (the join proof rejects it, see join/errors), so Eve holds a real grant but runs the
// harness with a different key, as a client of a compromised server would. Both peers encrypt (the SFU forwards the
// packets), but neither can decrypt the other's frames: framesDecoded stays 0 and no audio energy arrives.
test.describe('wrong meeting key', () => {
  test('decodes nothing in either direction and marks the tile', async ({ flows, intruders, guards }) => {
    // The SDK logs every failed decryption; these errors are the point of this test.
    for (const pattern of [/valid key missing/i, /missing key/i, /decryption failed/i, /InvalidKey|MissingKey/]) {
      guards.allowConsoleError(pattern)
    }
    const { host, room } = await flows.meeting({}, { hostName: 'Hana Host' })
    const eve = await intruders.open(room, host.account, { name: 'Eve Other', key: randomRoomKey() })

    for (const [viewer, publisher] of [
      [host, eve],
      [eve, host],
    ] as const) {
      // Encrypted packets arrive…
      await expect
        .poll(async () => (await inboundVideo(viewer.page, publisher.identity))[0]?.packetsReceived ?? 0, {
          timeout: 20_000,
          message: `${viewer.name} receives packets from ${publisher.name}`,
        })
        .toBeGreaterThan(20)
    }
    // …but none of them decrypts, for several seconds of media.
    await host.page.waitForTimeout(5_000)
    for (const [viewer, publisher] of [
      [host, eve],
      [eve, host],
    ] as const) {
      const [video] = await inboundVideo(viewer.page, publisher.identity)
      expect(video?.packetsReceived).toBeGreaterThan(100)
      expect(video?.framesDecoded).toBe(0)
      const [audio] = await inboundAudio(viewer.page, publisher.identity)
      expect(audio?.totalAudioEnergy ?? 0).toBe(0)
    }

    const tile = host.page.locator(`[data-testid="participant-tile"][data-identity="${eve.identity}"]`)
    await expect(tile).toHaveAttribute('data-undecryptable', 'true')
    await expect(host.page.getByTestId('e2ee-badge')).toHaveAttribute('data-state', 'warning')
    // Different keys give different safety codes, which is what people compare.
    expect((await callState(host.page))?.safetyCode).not.toBe((await callState(eve.page))?.safetyCode)
  })
})
