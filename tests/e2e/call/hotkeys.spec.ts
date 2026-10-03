import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import type { InCall } from '../fixtures/flows'
import { callState } from '../fixtures/livekit'

// Hotkeys on the real meeting page: M (mic), V (camera), Space (push to talk while muted), ? (help). A Russian layout
// types U+044C on the M key and U+043C on the V key; the handler falls back to e.code for such letters. Written as \u
// escapes (check:english).
const CYRILLIC_ON_KEY_M = '\u044c'
const CYRILLIC_ON_KEY_V = '\u043c'

async function dispatchKey(page: Page, key: string, code: string) {
  await page.evaluate(
    ([k, c]) => {
      for (const type of ['keydown', 'keyup'] as const) {
        document.dispatchEvent(new KeyboardEvent(type, { key: k, code: c, bubbles: true, cancelable: true }))
      }
    },
    [key, code] as const,
  )
}

async function peerSees(peer: InCall, identity: string) {
  return (await callState(peer.page))?.participants.find((p) => p.identity === identity)
}

test.describe('call hotkeys', () => {
  test('M, V, Space and ? work, on a Cyrillic layout too, and never in text fields', async ({ flows }) => {
    const { host, room } = await flows.meeting({ name: 'Hotkeys' }, { hostName: 'Hana Host' })
    const peer = await flows.joinAsGuest(room, { name: 'Pete Peer' })
    const page = host.page
    const mic = page.getByRole('button', { name: 'Microphone', exact: true })
    const camera = page.getByRole('button', { name: 'Camera', exact: true })
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(camera).toHaveAttribute('aria-pressed', 'true')

    // M mutes, and the peer sees it.
    await page.keyboard.press('m')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await peerSees(peer, host.identity))?.micEnabled).toBe(false)

    // Space: push to talk while muted (auto-repeat included), released on keyup.
    await page.keyboard.down('Space')
    await page.keyboard.down('Space')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await peerSees(peer, host.identity))?.micEnabled).toBe(true)
    await page.keyboard.up('Space')
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => (await peerSees(peer, host.identity))?.micEnabled).toBe(false)

    // Push to talk also ends when the window loses focus.
    await page.keyboard.down('Space')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.up('Space')

    // Russian layout: the M key unmutes, the V key (which types a Cyrillic "m" look-alike) toggles the camera.
    await dispatchKey(page, CYRILLIC_ON_KEY_M, 'KeyM')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await dispatchKey(page, CYRILLIC_ON_KEY_V, 'KeyV')
    await expect(camera).toHaveAttribute('aria-pressed', 'false')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await peerSees(peer, host.identity))?.cameraEnabled).toBe(false)

    // V turns the camera back on.
    await page.keyboard.press('v')
    await expect(camera).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await peerSees(peer, host.identity))?.cameraEnabled).toBe(true)

    // Typing in a text field never toggles anything.
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'hotkey-probe'
      input.setAttribute('aria-label', 'Probe')
      document.body.append(input)
    })
    await page.locator('#hotkey-probe').focus()
    await page.keyboard.type('mv m')
    await expect(mic).toHaveAttribute('aria-pressed', 'true')
    await expect(camera).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('#hotkey-probe')).toHaveValue('mv m')
    await page.locator('#hotkey-probe').blur()
    await page.evaluate(() => document.getElementById('hotkey-probe')?.remove())

    // ? opens the shortcut help.
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByTestId('hotkey-help')).toBeVisible()
    await expect(page.getByTestId('hotkey-help')).toContainText('Hold to talk while muted')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('hotkey-help')).toBeHidden()
  })
})
