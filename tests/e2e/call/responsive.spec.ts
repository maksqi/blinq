import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { waitForRemoteFrames } from '../fixtures/livekit'

// DoD: no horizontal overflow and the control bar stays in the viewport at 375, 768 and 1440 px (also in the
// mobile-chromium project through the @responsive tag). The host uses the test's own page on the real meeting page,
// so the project's device emulation applies.
const WIDTHS = [375, 768, 1440]

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test.describe('responsive call UI', { tag: '@responsive' }, () => {
  for (const width of WIDTHS) {
    test(`pre-join and call fit at ${width}px`, async ({ flows, page }) => {
      const viewport = { width, height: width < 700 ? 740 : 900 }
      const host = await flows.loginAs('host', { name: 'Hana Host', page, viewport })
      const room = await flows.createRoom({ name: 'Responsive', waitingRoom: false })
      await flows.open(host, room.link)

      // Pre-join: everything reachable, nothing overflows.
      await expect(page.getByTestId('prejoin-preview')).toBeVisible()
      expect(await horizontalOverflow(page), `pre-join at ${width}px`).toBeLessThanOrEqual(0)
      await page.getByTestId('join-button').scrollIntoViewIfNeeded()
      await expect(page.getByTestId('join-button')).toBeInViewport()
      await flows.enterCall(host)

      const peer = await flows.joinAsGuest(room, { name: 'Pete Peer' })
      await waitForRemoteFrames(page, peer.identity, 3)

      // In the call: the control bar and its key buttons are fully visible, the grid fits.
      expect(await horizontalOverflow(page), `call at ${width}px`).toBeLessThanOrEqual(0)
      const bar = page.getByTestId('control-bar')
      await expect(bar).toBeInViewport({ ratio: 1 })
      for (const control of ['Microphone', 'Camera', 'More options', 'Leave call']) {
        await expect(page.getByRole('button', { name: control, exact: true })).toBeInViewport({ ratio: 1 })
      }
      await expect(page.getByTestId('e2ee-badge')).toBeInViewport()
      const tiles = page.getByTestId('participant-tile')
      await expect(tiles).toHaveCount(2)
      for (const tile of await tiles.all()) await expect(tile).toBeInViewport({ ratio: 0.9 })

      // Menus and dialogs fit as well.
      await page.getByRole('button', { name: 'More options' }).click()
      await expect(page.getByRole('menu')).toBeInViewport({ ratio: 1 })
      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(page.getByTestId('call-settings')).toBeVisible()
      expect(await horizontalOverflow(page), `settings at ${width}px`).toBeLessThanOrEqual(0)
      await page.keyboard.press('Escape')
    })
  }
})
