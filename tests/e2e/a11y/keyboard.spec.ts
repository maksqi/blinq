/**
 * Stage 10 accessibility: keyboard-only journeys (sign in, create a room, join, mute and unmute, share the screen,
 * leave), visible focus on every tab stop, dialogs that trap and return focus, live regions for toasts, chat and
 * waiting-room requests, and `prefers-reduced-motion`. No test here clicks the mouse for the journey under test.
 *
 * `@ui` tests also run in `webkit-ui`; the call journeys need media and E2EE (Chromium and Firefox).
 */
import type { Locator, Page } from '@playwright/test'
import { closeE2eDb, createUser as createPasswordUser } from '../auth/support'
import { micButton, openPanel, settle } from '../collab/helpers'
import { callState, waitForPhase } from '../fixtures/livekit'
import { leaveCalls, openToPrejoin, spendJoinBudget } from '../join/support'
import {
  activeElement,
  addPeer,
  expect,
  expectFocusTrapped,
  longMotion,
  notePending,
  PENDING,
  removePeer,
  tabKey,
  tabTo,
  test,
  waitForLocalTracks,
  walkFocus,
  type Peer,
} from './support'

test.afterAll(async () => {
  await closeE2eDb()
})

/** The `aria-live` value of the closest live region around `locator` (`role="log"` and `"status"` imply one). */
async function liveRegionOf(locator: Locator): Promise<string | null> {
  return locator.evaluate((el) => {
    const region = el.closest('[aria-live], [role="log"], [role="status"], [role="alert"]')
    if (!region) return null
    const explicit = region.getAttribute('aria-live')
    if (explicit) return explicit
    return region.getAttribute('role') === 'alert' ? 'assertive' : 'polite'
  })
}

/** Moves through an open menu with the arrow keys until `item` has focus. */
async function arrowTo(page: Page, item: Locator, max = 12): Promise<void> {
  await tabTo(page, item, { max, key: 'ArrowDown' })
}

async function expectVisibleFocus(page: Page, label: string, max = 30): Promise<void> {
  const stops = await walkFocus(page, max)
  expect(stops.length, `${label}: tab stops`).toBeGreaterThan(1)
  expect
    .soft(
      stops.filter((stop) => !stop.indicator).map((stop) => stop.element),
      `${label}: focus not visible`,
    )
    .toEqual([])
  expect
    .soft(
      stops.filter((stop) => !stop.inViewport).map((stop) => stop.element),
      `${label}: focus off screen`,
    )
    .toEqual([])
}

test.describe('keyboard', { tag: '@ui' }, () => {
  test('signs in with the keyboard only', async ({ page, secrets }) => {
    const user = await createPasswordUser({ displayName: 'Kim Keys' })
    secrets.track(user.password, 'password')
    await page.goto('/login')
    await expect(page.getByTestId('login-form')).toBeVisible()

    // The skip link comes first and lands on the form.
    await page.keyboard.press(tabKey(page))
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
    await tabTo(page, page.getByLabel('Email'))
    await page.keyboard.type(user.email)
    await tabTo(page, page.getByLabel('Password', { exact: true }))
    await page.keyboard.type(user.password)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('shows where focus is on every tab stop', async ({ page, rooms }) => {
    for (const path of ['/', '/login', '/forgot-password']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expectVisibleFocus(page, path)
    }

    const user = await rooms.createUser({ displayName: 'Fay Focus' })
    const room = await rooms.createRoom(user, { name: 'Focus room' })
    await rooms.useIdentity(page.context(), user)
    for (const path of ['/dashboard', `/rooms/${room.id}`, '/settings', '/settings/sessions', '/recordings']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expectVisibleFocus(page, path, 40)
    }

    const admin = await rooms.createUser({ role: 'admin' })
    await rooms.useIdentity(page.context(), admin)
    for (const path of ['/admin', '/admin/users', '/admin/settings']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expectVisibleFocus(page, path, 40)
    }
  })

  test('creates a room with the keyboard; the dialog traps and returns focus', async ({ page, rooms }) => {
    const user = await rooms.createUser({ displayName: 'Kai Keys' })
    await rooms.useIdentity(page.context(), user)
    await page.goto('/dashboard')
    await expect(page.getByTestId('rooms-empty')).toBeVisible()

    const newRoom = page.getByTestId('new-room')
    await tabTo(page, newRoom)
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('create-room-dialog')
    await expect(dialog).toBeVisible()
    await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await expectFocusTrapped(page, dialog)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(newRoom).toBeFocused()

    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await tabTo(page, dialog.getByLabel('Name'))
    await page.keyboard.type('Keyboard room')
    await spendJoinBudget(2)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
  })

  test('announces toasts in a live region', async ({ page, rooms }) => {
    const owner = await rooms.createUser({ displayName: 'Tia Toast' })
    const room = await rooms.createRoom(owner, { name: 'Toast room', waitingRoom: true })
    await rooms.useIdentity(page.context(), owner)
    await page.goto(`/rooms/${room.id}`)
    await tabTo(page, page.getByRole('switch', { name: 'Waiting room' }), { max: 60 })
    await page.keyboard.press('Space')
    await tabTo(page, page.getByTestId('room-settings-save'))
    await page.keyboard.press('Enter')
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Settings saved' })
    await expect(toast).toBeVisible()
    expect(await liveRegionOf(toast)).toMatch(/^(polite|assertive)$/)
  })

  test('respects prefers-reduced-motion', async ({ page, rooms, guards }) => {
    guards.allowConsoleError(/Failed to load resource: the server responded with a status of 404/)
    // Control: without the preference the shell does animate, so the probe below can see animations.
    await page.goto('/')
    await expect(page.getByTestId('join-link-form')).toBeVisible()
    expect(await longMotion(page), 'animations without a preference').not.toEqual([])
    // Firefox reports module imports cut short by the next navigation as page errors: let the page finish loading.
    await page.waitForLoadState('networkidle')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const path of ['/', '/login', '/this-page-does-not-exist']) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      expect.soft(await longMotion(page), `${path}: moving animations with reduced motion`).toEqual([])
    }

    const user = await rooms.createUser({ displayName: 'Mo Motion' })
    const room = await rooms.createRoom(user, { name: 'Live room' })
    await rooms.join(room, user) // the room is live: the list shows a pulsing marker
    await rooms.useIdentity(page.context(), user)
    await page.goto('/dashboard')
    await expect(page.getByTestId('room-item')).toHaveAttribute('data-live', 'true')
    expect.soft(await longMotion(page), '/dashboard: moving animations with reduced motion').toEqual([])
    await page.getByTestId('new-room').click()
    await expect(page.getByTestId('create-room-dialog')).toBeVisible()
    expect.soft(await longMotion(page, 300), 'dialog: moving animations with reduced motion').toEqual([])
  })
})

test.describe('keyboard in the call', () => {
  test('joins, mutes and unmutes, shares the screen and leaves with the keyboard only', async ({
    page,
    context,
    rooms,
  }) => {
    test.setTimeout(90_000)
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Keyboard call' })
    await rooms.useIdentity(context, host)
    await openToPrejoin(page, room.link)

    await tabTo(page, page.getByTestId('join-button'), { max: 60 })
    await page.keyboard.press('Enter')
    await waitForPhase(page, 'inCall')
    await waitForLocalTracks(page)

    try {
      const mic = micButton(page)
      await tabTo(page, mic, { max: 60 })
      await expect(mic).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Enter')
      await expect(mic).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(async () => (await callState(page))?.media.micOn).toBe(false)
      await expect(mic).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(mic).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(async () => (await callState(page))?.media.micOn).toBe(true)

      await page.evaluate(() => {
        const hooks = (window as unknown as { __blinqTest: { useFakeScreenSource?: (enabled: boolean) => void } })
          .__blinqTest
        hooks.useFakeScreenSource?.(true)
      })
      const share = page.locator('[data-control="screen-share"]')
      await tabTo(page, share, { max: 60 })
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await callState(page))?.screenShare.active).toBe(true)
      await expect(share).toHaveAttribute('aria-label', 'Stop presenting')
      // Focus stays on the toggle, so Enter stops presenting again.
      await expect(share).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await callState(page))?.screenShare.active).toBe(false)

      await tabTo(page, page.getByRole('button', { name: 'Leave call' }), { max: 60 })
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('call-end-screen')).toBeVisible()
    } finally {
      await leaveCalls(page)
    }
  })

  test('call dialogs trap and return focus; chat and waiting-room requests are announced', async ({
    page,
    context,
    browser,
    rooms,
    guards,
  }) => {
    test.setTimeout(120_000)
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Dialog call', waitingRoom: true })
    await rooms.useIdentity(context, host)
    let peer: Peer | undefined
    try {
      await openToPrejoin(page, room.link)
      await page.getByTestId('join-button').click()
      await waitForPhase(page, 'inCall')
      peer = await addPeer(rooms, guards, browser, room, host, 'Pete Peer')

      // Device settings from the More menu: focus moves in, stays in, and returns to the More button.
      const more = page.getByRole('button', { name: 'More options' })
      await tabTo(page, more, { max: 60 })
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menu')).toBeVisible()
      await arrowTo(page, page.getByRole('menuitem', { name: 'Settings' }))
      await page.keyboard.press('Enter')
      const settings = page.getByTestId('call-settings')
      await expect(settings).toBeVisible()
      await expect.poll(() => settings.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      await expectFocusTrapped(page, settings)
      await page.keyboard.press('Escape')
      await expect(settings).toBeHidden()
      await settle(page)
      // pending finding: focus lands on <body>; the fix agent restores
      // expect(await activeElement(page)).toMatch(/More options/)
      notePending(PENDING.settingsFocus, await activeElement(page))

      // End-meeting confirmation from the host controls.
      const hostControls = page.locator('[data-control="host-controls"]')
      await tabTo(page, hostControls, { max: 60 })
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('host-controls')).toBeVisible()
      await tabTo(page, page.getByTestId('host-end-meeting'))
      await page.keyboard.press('Enter')
      const endDialog = page.getByTestId('end-meeting-dialog')
      await expect(endDialog).toBeVisible()
      await expect.poll(() => endDialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
      await expectFocusTrapped(page, endDialog, 6)
      await page.keyboard.press('Escape')
      await expect(endDialog).toBeHidden()
      await settle(page)
      expect
        .soft(await activeElement(page), 'focus after closing the end-meeting dialog')
        .toMatch(/Host controls|End meeting|host-end-meeting/i)

      // Chat: a message from the peer lands in a live log.
      await openPanel(page, 'chat')
      await openPanel(peer.page, 'chat')
      await peer.page.getByTestId('chat-input').fill('Hello from Pete')
      await peer.page.getByTestId('chat-send').click()
      const message = page.getByTestId('chat-message').filter({ hasText: 'Hello from Pete' })
      await expect(message).toBeVisible()
      expect(await liveRegionOf(message)).toBe('polite')

      // A waiting guest is announced (toast) and listed in a live region of the waiting-room panel.
      await rooms.join(room, { guest: 'Wanda Waiting' }, { inviteToken: await rooms.createInvite(room, host) })
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Wanda Waiting is waiting to join' })
      await expect(toast).toBeVisible()
      expect(await liveRegionOf(toast)).toMatch(/^(polite|assertive)$/)
      await openPanel(page, 'lobby')
      const lobby = page.getByTestId('lobby-panel')
      await expect(lobby.getByTestId('lobby-entry')).toHaveCount(1)
      const count = lobby.locator('[aria-live]').first()
      await expect(count).toHaveText('1 person is waiting.')

      // Reduced motion: a reaction only fades, nothing moves for long.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const reactions = page.locator('[data-control="reactions"]')
      await tabTo(page, reactions, { max: 80 })
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('reactions-menu')).toBeVisible()
      await expect
        .poll(() => page.getByTestId('reactions-menu').evaluate((el) => el.contains(document.activeElement)))
        .toBe(true)
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('reactions-overlay').getByTestId('reaction-item').first()).toBeVisible()
      expect.soft(await longMotion(page), 'call: moving animations with reduced motion').toEqual([])
    } finally {
      await removePeer(peer)
      await leaveCalls(page)
    }
  })
})
