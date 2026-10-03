import { expect, test } from '../fixtures'
import { inboundVideo, subscriptions } from '../fixtures/livekit'

// DoD: a small tile receives width ≤ 320 (simulcast layer switching). adaptiveStream is off, so the subscription
// manager alone picks the layer from the rendered tile size. Both people are on the real meeting page.
test.describe('simulcast layers', () => {
  test('follow the tile size: large tile, then a small one', async ({ flows }) => {
    const { host: viewer, room } = await flows.meeting(
      { name: 'Layers' },
      { hostName: 'Vic Viewer', viewport: { width: 1280, height: 720 } },
    )
    const publisher = await flows.joinAsGuest(room, { name: 'Pat Publisher' })

    const camera = async () => (await inboundVideo(viewer.page, publisher.identity))[0]
    const requested = async () =>
      (await subscriptions(viewer.page, publisher.identity)).find((s) => s.source === 'camera')

    // Two tiles side by side at 1280 px: about 630 px wide, so a layer above the lowest one.
    await expect.poll(async () => (await requested())?.width ?? 0).toBeGreaterThan(320)
    await expect
      .poll(async () => (await camera())?.frameWidth ?? 0, {
        timeout: 30_000,
        message: 'large tile gets a larger layer',
      })
      .toBeGreaterThan(320)

    // Shrink the window: the tile becomes smaller than the lowest layer (320×180).
    await viewer.page.setViewportSize({ width: 560, height: 420 })
    await expect.poll(async () => (await requested())?.width ?? Infinity).toBeLessThanOrEqual(320)
    await expect
      .poll(async () => (await camera())?.frameWidth ?? Infinity, {
        timeout: 30_000,
        message: 'small tile gets the lowest layer',
      })
      .toBeLessThanOrEqual(320)
    const small = await camera()
    expect(small?.frameWidth).toBeGreaterThan(0)
    // Frames keep flowing on the new layer.
    const before = small?.framesDecoded ?? 0
    await expect.poll(async () => (await camera())?.framesDecoded ?? 0).toBeGreaterThan(before + 5)
  })
})
