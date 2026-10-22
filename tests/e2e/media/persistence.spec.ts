import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import {
  chooseBlur,
  chooseNoise,
  mediaState,
  NOISE_OPTION,
  waitForBlur,
  waitForMedia,
  waitForNoise,
  type BlurLevel,
  type NoiseMode,
} from '../fixtures/media'

// Stage 07 DoD: effect choices are remembered per device (blur per camera, noise suppression and gain per microphone,
// localStorage `blinq:media:v1`) and applied in pre-join after a reload, before joining.
const PREFS_KEY = 'blinq:media:v1'

/** The pre-join "Microphone volume" slider (0–200 %, step 5). */
async function setGainPercent(page: Page, percent: number): Promise<void> {
  const slider = page.getByTestId('prejoin-effects').getByRole('slider')
  await slider.focus()
  await page.keyboard.press('Home')
  for (let value = 0; value < percent; value += 5) await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('mic-gain-value')).toHaveText(`${percent}%`)
}

async function expectPrejoinShows(page: Page, blur: BlurLevel, noise: NoiseMode, gain: number): Promise<void> {
  const effects = page.getByTestId('prejoin-effects')
  await expect(effects.getByTestId(`blur-${blur}`)).toHaveAttribute('data-state', 'on')
  await expect(effects.getByTestId('noise-mode')).toHaveText(NOISE_OPTION[noise])
  await expect(effects.getByTestId('mic-gain-value')).toHaveText(`${gain}%`)
}

/** A full page load of the harness (the page strips its fragment, so a plain goto would not reload). */
async function reload(page: Page, url: string): Promise<void> {
  await page.goto('about:blank')
  await page.goto(url)
  await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
}

test.describe('media effect preferences', () => {
  test.setTimeout(180_000)

  test('survive a reload and are applied per device in pre-join', async ({ joinAs, page }) => {
    const host = await joinAs('host', { name: 'Hana Host', page, join: false })
    const devices = await waitForMedia(
      page,
      (state) => Boolean(state.cameraDeviceId && state.micDeviceId),
      'camera and microphone device ids',
    )

    await chooseBlur(page, 'light')
    await waitForBlur(page, 'light')
    await chooseNoise(page, 'off')
    await waitForNoise(page, 'off')
    await setGainPercent(page, 150)
    await waitForMedia(page, (state) => state.gain === 1.5, 'gain 150%')

    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), PREFS_KEY)
    expect(saved.cameras).toEqual([{ id: devices.cameraDeviceId, blur: 'light' }])
    expect(saved.mics).toEqual([{ id: devices.micDeviceId, noise: 'off', gain: 1.5 }])

    // Reload: the same camera and microphone open with the same effects, before anyone joins.
    await reload(page, host.url)
    await waitForBlur(page, 'light')
    const restored = await waitForMedia(
      page,
      (state) => state.noise === 'off' && state.gain === 1.5 && !state.noiseBusy,
      'noise off and gain 150% after the reload',
    )
    expect(restored.micProcessing.noiseSuppression).toBe(false)
    await expectPrejoinShows(page, 'light', 'off', 150)

    // Per device: the browser-wide default (the latest choice, e.g. made with other devices) differs, and choices of
    // other devices exist, yet these devices get their own entries.
    const ids = await waitForMedia(page, (state) => Boolean(state.cameraDeviceId && state.micDeviceId), 'device ids')
    await page.evaluate(({ key, prefs }) => localStorage.setItem(key, JSON.stringify(prefs)), {
      key: PREFS_KEY,
      prefs: {
        defaults: { blur: 'strong', noise: 'browser', gain: 0.5, lastBlur: 'strong' },
        cameras: [
          { id: 'another-camera', blur: 'off' },
          { id: ids.cameraDeviceId, blur: 'light' },
        ],
        mics: [
          { id: ids.micDeviceId, noise: 'off', gain: 1.5 },
          { id: 'another-microphone', noise: 'rnnoise', gain: 2 },
        ],
      },
    })
    await reload(page, host.url)
    const now = await waitForMedia(page, (state) => Boolean(state.cameraDeviceId && state.micDeviceId), 'device ids')
    // Microphone ids are stable across loads in both engines (Chromium's default microphone is "default").
    expect(now.micDeviceId).toBe(ids.micDeviceId)
    await waitForMedia(
      page,
      (state) => state.noise === 'off' && state.gain === 1.5 && !state.noiseBusy,
      'own mic entry',
    )
    // Chromium gives the fake camera a new id on every page load in Playwright contexts (even with a permission
    // grant), so its entry cannot match there and the browser-wide default applies. Firefox keeps the id.
    const sameCamera = now.cameraDeviceId === ids.cameraDeviceId
    if (!sameCamera) {
      test.info().annotations.push({ type: 'devices', description: 'camera id changed across loads: default applies' })
    }
    await waitForBlur(page, sameCamera ? 'light' : 'strong')
    await expectPrejoinShows(page, sameCamera ? 'light' : 'strong', 'off', 150)

    // Without entries for these devices, the default applies.
    await page.evaluate(
      ({ key }) =>
        localStorage.setItem(
          key,
          JSON.stringify({ defaults: { blur: 'strong', noise: 'browser', gain: 0.5, lastBlur: 'strong' } }),
        ),
      { key: PREFS_KEY },
    )
    await reload(page, host.url)
    await waitForBlur(page, 'strong')
    await waitForMedia(page, (state) => state.noise === 'browser' && state.gain === 0.5 && !state.noiseBusy, 'default')
    await expectPrejoinShows(page, 'strong', 'browser', 50)
    expect((await mediaState(page))?.micProcessing.noiseSuppression).toBe(true)
  })
})
