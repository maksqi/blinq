import { callState, inboundAudio, inboundVideo, subscriptions } from '../fixtures/livekit'
import { expect, test } from './support'

// DoD: an unencrypted publisher is blocked (docs/SECURITY.md §3.2). The host is in the call on the real meeting page.
// The product UI cannot publish without encryption, so Mallory holds a real grant and runs the harness with e2ee=off
// (test builds only), then publishes an extra canvas track through the publishUnencryptedTrack hook.
test.describe('unencrypted media', () => {
  test('is never subscribed or played, and the UI warns about it', async ({ flows, intruders }) => {
    const { host, room } = await flows.meeting({}, { hostName: 'Hana Host' })
    const mallory = await intruders.open(room, host.account, { name: 'Mallory Plain', e2ee: 'off', camera: false })
    await mallory.page.evaluate(async () => {
      const hooks = (window as unknown as { __blinqTest: { publishUnencryptedTrack?: () => Promise<void> } })
        .__blinqTest
      if (!hooks.publishUnencryptedTrack) throw new Error('publishUnencryptedTrack is missing')
      await hooks.publishUnencryptedTrack()
    })

    // The host sees Mallory's publications (mic and the canvas track) and blocks every one of them.
    await expect
      .poll(async () => (await subscriptions(host.page, mallory.identity)).map((s) => s.source).sort(), {
        message: "Mallory's publications reach the host's policy",
      })
      .toEqual(['camera', 'microphone'])
    for (const entry of await subscriptions(host.page, mallory.identity)) {
      expect(entry).toMatchObject({ subscribed: false, enabled: false, blocked: true })
    }

    const tile = host.page.locator(`[data-testid="participant-tile"][data-identity="${mallory.identity}"]`)
    await expect(tile).toHaveAttribute('data-blocked', 'true')
    await expect(tile.getByTestId('tile-blocked')).toBeVisible()
    await expect(tile.locator('video')).toHaveCount(0)
    await expect(host.page.getByTestId('unencrypted-warning')).toBeVisible()
    await expect(host.page.getByTestId('e2ee-badge')).toHaveAttribute('data-state', 'blocked')
    expect((await callState(host.page))?.blocked).toEqual([mallory.identity])

    // Nothing of Mallory's ever arrives, while the host still gets nothing unencrypted from anyone else.
    await host.page.waitForTimeout(3_000)
    expect(await inboundVideo(host.page, mallory.identity)).toEqual([])
    expect(await inboundAudio(host.page, mallory.identity)).toEqual([])
    const audioElements = await host.page.evaluate(
      (identity) => document.querySelectorAll(`[data-blinq-audio] audio[data-identity="${identity}"]`).length,
      mallory.identity,
    )
    expect(audioElements).toBe(0)

    // The unencrypted client itself shows that it is not encrypted.
    await expect(mallory.page.getByTestId('e2ee-badge')).toHaveAttribute('data-state', 'off')
  })
})
