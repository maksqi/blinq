import { expect, test } from '../fixtures'
import { otherEngine, type InCall } from '../fixtures/flows'
import { callState, inboundAudio, waitForRemoteFrames } from '../fixtures/livekit'

// DoD: a Chromium ↔ Firefox call works with E2EE (docs/stages/05-call-core.md). Both people join through the real
// meeting page `/m/<slug>`: the host from the dashboard's host link, the guest from an invite link in the other engine.
test.describe('end-to-end encrypted call', () => {
  test('Chromium and Firefox see and hear each other, encrypted', async ({ flows, browserName }) => {
    const { host, room } = await flows.meeting({ name: 'Encrypted sync' }, { hostName: 'Hana Host' })
    const guest = await flows.joinAsGuest(room, { name: 'Gus Guest', browser: otherEngine(browserName) })

    const pairs: Array<[InCall, InCall]> = [
      [host, guest],
      [guest, host],
    ]
    for (const [viewer, publisher] of pairs) {
      // Video: frames decrypted and decoded.
      await waitForRemoteFrames(viewer.page, publisher.identity, 15)
      // Audio: decoded samples carry energy (the fake devices play a tone).
      await expect
        .poll(async () => (await inboundAudio(viewer.page, publisher.identity))[0]?.totalAudioEnergy ?? 0, {
          timeout: 20_000,
          message: `${viewer.name} hears ${publisher.name}`,
        })
        .toBeGreaterThan(0)

      const state = await callState(viewer.page)
      expect(state?.e2eeEnabled).toBe(true)
      expect(state?.blocked).toEqual([])
      const remote = state?.participants.find((p) => p.identity === publisher.identity)
      expect(remote?.mediaEncrypted).toBe(true)
      await expect(viewer.page.getByTestId('e2ee-badge')).toHaveAttribute('data-state', 'encrypted')
      await expect(
        viewer.page.locator(`[data-testid="participant-tile"][data-identity="${publisher.identity}"] video`),
      ).toBeVisible()
    }

    // Everyone derived the same safety code from the same key and epoch.
    const hostCode = (await callState(host.page))?.safetyCode
    expect(hostCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/)
    expect((await callState(guest.page))?.safetyCode).toBe(hostCode)
    await host.page.getByTestId('e2ee-badge').click()
    await expect(host.page.getByTestId('safety-code')).toHaveText(hostCode!)
  })
})
