import type { Page } from '@playwright/test'
import {
  actionsMenu,
  closePanel,
  dismiss,
  expect,
  horizontalOverflow,
  openActions,
  openHostControls,
  openPanel,
  test,
} from './helpers'

// Stage 06 DoD: panels, menus and dialogs fit at 375, 768 and 1440 px without horizontal overflow (also in the
// mobile-chromium project through the @responsive tag).

const WIDTHS = [375, 768, 1440]
/**
 * Entirely inside the viewport, give or take floating-point rounding: a menu flush with the viewport edge measured a
 * ratio of 0.9999998 (mobile-chromium in the Docker runner). 0.999 of a 300 px menu is 0.3 px.
 */
const FULLY = { ratio: 0.999 }

async function fits(page: Page, what: string) {
  expect(await horizontalOverflow(page), `${what}: horizontal overflow`).toBeLessThanOrEqual(0)
}

/** Control-bar buttons another control covers (their center point hits something else). */
async function coveredControls(page: Page): Promise<string[]> {
  return page.getByTestId('control-bar').evaluate((bar) => {
    const covered: string[] = []
    for (const button of bar.querySelectorAll<HTMLElement>('button')) {
      const box = button.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      // Buttons scrolled out of a horizontally scrolling group are reachable by scrolling: skip them.
      const scroller = button.parentElement?.closest<HTMLElement>('[class*="overflow-x-auto"]')
      const clip = scroller?.getBoundingClientRect()
      if (clip && (box.left < clip.left - 1 || box.right > clip.right + 1)) continue
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (hit && !button.contains(hit)) covered.push(button.getAttribute('aria-label') ?? button.textContent ?? '?')
    }
    return covered
  })
}

test.describe('collaboration UI fits', { tag: '@responsive' }, () => {
  for (const width of WIDTHS) {
    test(`panels, menus and dialogs at ${width}px`, async ({ collab, rooms, page }) => {
      test.setTimeout(90_000)
      const viewport = { width, height: width < 700 ? 740 : 900 }
      const {
        room,
        host: hostUser,
        call: host,
      } = await collab.meeting({ waitingRoom: true }, { camera: false, page, viewport })
      const ana = await collab.addUser(room, host, { name: 'Ana Lima With A Rather Long Display Name', camera: false })
      await rooms.join(room, { guest: 'Wanda Waiting' }, { inviteToken: await rooms.createInvite(room, hostUser) })
      await expect(page.getByTestId('control-bar')).toBeInViewport(FULLY)
      await fits(page, 'call')
      // Scrolled into view, every control is reachable (none sits on top of another).
      await page.locator('[data-control="host-controls"]').scrollIntoViewIfNeeded()
      expect(await coveredControls(page), 'control-bar buttons covered by other controls').toEqual([])

      // People panel and the moderation menu.
      await openPanel(page, 'participants')
      await fits(page, 'people panel')
      await openActions(page, ana.identity)
      await expect(actionsMenu(page)).toBeInViewport(FULLY)
      await fits(page, 'moderation menu')
      await actionsMenu(page).locator('[data-action="remove"]').click()
      await expect(page.getByTestId('remove-dialog')).toBeInViewport(FULLY)
      await fits(page, 'remove dialog')
      await dismiss(page)
      await closePanel(page, 'participants')

      // Waiting room panel.
      await openPanel(page, 'lobby')
      await expect(page.getByTestId('lobby-entry')).toHaveCount(1)
      await expect(page.getByTestId('lobby-admit')).toBeInViewport()
      await fits(page, 'waiting room panel')
      await closePanel(page, 'lobby')

      // Chat panel with a long message.
      await openPanel(page, 'chat')
      await page.getByTestId('chat-input').fill(`${'long'.repeat(120)} https://example.com/${'path/'.repeat(40)}`)
      await page.getByTestId('chat-send').click()
      await expect(page.getByTestId('chat-message')).toHaveCount(1)
      await expect(page.getByTestId('chat-send')).toBeInViewport()
      await fits(page, 'chat panel')
      await closePanel(page, 'chat')

      // Host controls and their dialogs.
      await openHostControls(page)
      await expect(page.getByTestId('host-controls')).toBeInViewport(FULLY)
      await fits(page, 'host controls')
      await page.getByTestId('host-mute-all').click()
      await expect(page.getByTestId('mute-all-dialog')).toBeInViewport(FULLY)
      await fits(page, 'mute all dialog')
      await dismiss(page)
      await openHostControls(page)
      await page.getByTestId('host-end-meeting').click()
      await expect(page.getByTestId('end-meeting-dialog')).toBeInViewport(FULLY)
      await fits(page, 'end meeting dialog')
      await dismiss(page)

      // Reactions.
      const reactions = page.locator('[data-control="reactions"]')
      await reactions.scrollIntoViewIfNeeded()
      await reactions.click()
      await expect(page.getByTestId('reactions-menu')).toBeInViewport(FULLY)
      await fits(page, 'reactions')
      await dismiss(page)

      // The ask-to-unmute prompt on the participant's side.
      await ana.page.setViewportSize(viewport)
      await ana.page.locator('[data-control="microphone"] button').first().click()
      await openActions(page, ana.identity)
      await actionsMenu(page).locator('[data-action="ask-unmute"]').click()
      await expect(ana.page.getByTestId('ask-unmute-dialog')).toBeInViewport(FULLY)
      await fits(ana.page, 'ask-to-unmute prompt')
    })
  }
})
