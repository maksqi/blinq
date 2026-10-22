import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { inboundVideo, waitForPhase, waitForRemoteFrames, type JoinedPeer } from '../fixtures/livekit'
import {
  BLUR_TIMEOUT,
  chooseBlur,
  closeSettings,
  mediaState,
  openSettings,
  startFrameRecorder,
  stopFrameRecorder,
  toggleBlurFromMenu,
  waitForBlur,
  type BlurLevel,
} from '../fixtures/media'

// Stage 07 DoD: switching blur never republishes or drops the camera. The processor is attached once (pre-join) and
// afterwards only switches modes; peers keep the same publication and keep decoding frames.

/** Peer-side camera publication sid of `publisher` (the one whose frames the peer decodes). */
async function receivedSid(viewer: Page, publisher: JoinedPeer): Promise<string | undefined> {
  return (await inboundVideo(viewer, publisher.identity))[0]?.trackSid
}

test.describe('background blur', () => {
  test.setTimeout(240_000)

  test('switches without republishing or dropping the camera', async ({ joinAs }) => {
    const host = await joinAs('host', { name: 'Hana Host', join: false })
    const { page } = host

    // On in pre-join, before the camera is published.
    await chooseBlur(page, 'strong')
    await waitForBlur(page, 'strong')
    await page.getByTestId('join-button').click()
    await waitForPhase(page, 'inCall')
    const peer = await joinAs('participant', { name: 'Pete Peer', room: host.room })
    await waitForRemoteFrames(peer.page, host.identity, 10)

    const cameraSid = (await mediaState(page))?.cameraTrackSid
    expect(cameraSid).toMatch(/^TR_/)
    expect(await receivedSid(peer.page, host)).toBe(cameraSid)

    // Off, on, off three times (More menu and settings levels), while the peer's video element logs every frame.
    await startFrameRecorder(peer.page, host.identity)
    const switches: Array<{ level: BlurLevel; via: 'menu' | 'settings' }> = [
      { level: 'off', via: 'menu' },
      { level: 'strong', via: 'menu' },
      { level: 'off', via: 'menu' },
      { level: 'light', via: 'settings' },
      { level: 'off', via: 'settings' },
      { level: 'strong', via: 'settings' },
      { level: 'off', via: 'menu' },
    ]
    for (const { level, via } of switches) {
      if (via === 'menu') {
        await toggleBlurFromMenu(page)
      } else {
        await openSettings(page)
        await chooseBlur(page, level)
        await closeSettings(page)
      }
      await waitForBlur(page, level)
      await waitForRemoteFrames(peer.page, host.identity, 5)
      expect((await mediaState(page))?.cameraTrackSid, `local sid after blur ${level}`).toBe(cameraSid)
      expect(await receivedSid(peer.page, host), `peer sid after blur ${level}`).toBe(cameraSid)
    }
    const frames = await stopFrameRecorder(peer.page)
    expect(frames.frames, 'frames the peer presented while blur switched').toBeGreaterThan(20)
    expect(frames.maxGapMs, 'longest gap between frames on the peer').toBeLessThanOrEqual(1_000)

    // Blur survives camera off/on (call-core re-applies the processor to the restarted track).
    await toggleBlurFromMenu(page)
    await waitForBlur(page, 'strong')
    const camera = page.getByRole('button', { name: 'Camera', exact: true })
    await camera.click()
    await expect(camera).toHaveAttribute('aria-pressed', 'false')
    await camera.click()
    // Turning the camera on restarts the blur pipeline before the button reports it. With software WebGL (SwiftShader,
    // llvmpipe in the Docker runner) that took 1-13 s in Firefox and about 7 s in Chromium: the blur timeout applies.
    await expect(camera).toHaveAttribute('aria-pressed', 'true', { timeout: BLUR_TIMEOUT })
    await waitForBlur(page, 'strong')
    await waitForRemoteFrames(peer.page, host.identity, 10)

    // …and a device switch: the fake media has one camera, so restart the track the way setDeviceId() does.
    const before = (await mediaState(page))?.blurFrames ?? 0
    await page.evaluate(async () => {
      const hooks = (window as unknown as { __blinqTest: { state: { mediaFx: { restartCamera(): Promise<void> } } } })
        .__blinqTest
      await hooks.state.mediaFx.restartCamera()
    })
    await waitForBlur(page, 'strong')
    await expect.poll(async () => (await mediaState(page))?.blurFrames ?? 0).toBeGreaterThan(before + 10)
    await waitForRemoteFrames(peer.page, host.identity, 10)

    expect((await mediaState(page))?.cameraTrackSid).toBe(cameraSid)
    expect(await receivedSid(peer.page, host)).toBe(cameraSid)
  })
})
