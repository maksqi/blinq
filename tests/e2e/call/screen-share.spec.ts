import { expect, test } from '../fixtures'
import { callState, inboundVideo } from '../fixtures/livekit'

// DoD: a 1920×1080 canvas test source is honored at the preset (default admin limits: h1080fps15, contentHint
// `detail`). The fake source replaces getDisplayMedia, so the test is deterministic. Both people are on the real
// meeting page, which takes the media limits from GET /api/config (the admin settings).
test.describe('screen share', () => {
  test('a 1920×1080 source reaches the viewer at 1920×1080 and stopping restores the layout', async ({
    flows,
    page,
  }) => {
    // The admin settings are at their defaults (admin specs restore what they change).
    const config = (await (await page.request.get('/api/config')).json()) as { media: Record<string, unknown> }
    expect(config.media).toMatchObject({ maxScreenShareResolution: '1080p', maxScreenShareFps: 15 })

    const { host: presenter, room } = await flows.meeting({ name: 'Screen share' }, { hostName: 'Presenter Pia' })
    const viewer = await flows.joinAsGuest(room, { name: 'Viewer Val', viewport: { width: 1600, height: 900 } })

    await presenter.page.evaluate(() => {
      const hooks = (window as unknown as { __blinqTest: { useFakeScreenSource?: (enabled: boolean) => void } })
        .__blinqTest
      hooks.useFakeScreenSource?.(true)
    })
    await presenter.page.getByRole('button', { name: 'Share screen' }).click()
    await expect(presenter.page.getByTestId('self-presenting')).toBeVisible()
    await expect.poll(async () => (await callState(presenter.page))?.screenShare.active).toBe(true)

    // The viewer switches to the presentation layout with the share on stage…
    const stage = viewer.page.locator(
      `[data-testid="participant-tile"][data-source="screen_share"][data-identity="${presenter.identity}"]`,
    )
    await expect(stage).toBeVisible()
    await expect(stage.locator('video')).toBeVisible()
    // …and receives the full 1920×1080 layer.
    await expect
      .poll(
        async () => {
          const [share] = await inboundVideo(viewer.page, presenter.identity, 'screen_share')
          return share ? `${share.frameWidth}x${share.frameHeight}` : 'none'
        },
        { timeout: 30_000, message: 'screen share resolution at the viewer' },
      )
      .toBe('1920x1080')

    // The publisher sends the preset: a 1920×1080 capture with the "detail" hint at 15 fps and 2.5 Mbps.
    const local = await presenter.page.evaluate(
      () => (window as unknown as { __blinqTest: { state: Record<string, unknown> } }).__blinqTest.state.localScreen,
    )
    expect(local).toEqual({
      preset: 'h1080fps15',
      contentHint: 'detail',
      width: 1920,
      height: 1080,
      maxBitrate: 2_500_000,
      maxFramerate: 15,
    })

    await presenter.page.locator('[data-control="screen-share"]').click()
    await expect(stage).toHaveCount(0)
    await expect(viewer.page.getByTestId('video-grid')).toBeVisible()
    await expect.poll(async () => (await callState(presenter.page))?.screenShare.active).toBe(false)
  })
})
