/**
 * Stage 10 accessibility: axe (WCAG 2.x A/AA) on the meeting page `/m/<slug>` (the real flow): pre-join, password
 * prompt, waiting room, join error, the in-call grid, the chat, people and waiting-room panels, the call's menus and
 * dialogs, and the end screen. Serious or critical violations fail (soft, so one run lists every state).
 *
 * The meeting page forces the dark theme (`definePageMeta({ colorMode: 'dark' })`), so it is scanned once, with a
 * stored light preference to prove that the preference cannot turn it light (decision). Needs media and E2EE:
 * Chromium and Firefox only (no `@ui`).
 */
import { closePanel, openHostControls, openPanel, settle } from '../collab/helpers'
import { waitForPhase } from '../fixtures/livekit'
import {
  leaveCalls,
  newWatchedContext,
  openToPrejoin,
  pressJoin,
  spendJoinBudget,
  waitingRequestId,
} from '../join/support'
import {
  addPeer,
  expect,
  expectAccessible,
  expectTheme,
  PENDING,
  removePeer,
  test,
  useTheme,
  type Peer,
} from './support'


test.describe('axe on the meeting page', () => {
  test('join screens: pre-join, password, waiting room, missing key', async ({
    page,
    context,
    browser,
    rooms,
    guards,
  }) => {
    test.setTimeout(120_000)
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Office hours', waitingRoom: true })
    await rooms.useIdentity(context, host)
    await useTheme(context, 'light')

    // Pre-join of the host (signed in, link with the key).
    await openToPrejoin(page, room.link)
    await expectTheme(page, 'dark')
    await expect(page.getByTestId('prejoin-preview')).toBeVisible()
    await expectAccessible(page, 'pre-join (host)')

    // Waiting room of a guest (the host's own join started the meeting).
    await rooms.join(room, host)
    const link = rooms.inviteLink(room, await rooms.createInvite(room, host))
    const guestContext = await newWatchedContext(browser, guards)
    const guest = await guestContext.newPage()
    await openToPrejoin(guest, link)
    await expectAccessible(guest, 'pre-join (guest, name field)')
    await waitingRequestId(guest, room.slug, () => pressJoin(guest, 'Wanda Waiting'))
    await expect(guest.getByTestId('waiting-room')).toBeVisible()
    await expectAccessible(guest, 'waiting room')
    await guest.getByTestId('waiting-cancel').click()
    await expect(guest.getByTestId('prejoin')).toBeVisible()

    // Password prompt.
    const locked = await rooms.createRoom(host, { name: 'Board room', password: 'open-sesame' })
    const lockedLink = rooms.inviteLink(locked, await rooms.createInvite(locked, host))
    await openToPrejoin(guest, lockedLink)
    await pressJoin(guest, 'Pat Password') // the info answer says a password is needed: no request yet
    await expect(guest.getByTestId('join-password')).toBeVisible()
    await expectAccessible(guest, 'password prompt')

    await guestContext.close()

    // A link without its key, in a tab that never saw it.
    const strangerContext = await newWatchedContext(browser, guards)
    const stranger = await strangerContext.newPage()
    await spendJoinBudget(1)
    await stranger.goto(`/m/${room.slug}`)
    await expect(stranger.getByTestId('join-error')).toBeVisible({ timeout: 20_000 })
    await expectAccessible(stranger, 'join error (missing key)')
    await strangerContext.close()
  })

  test('in the call: grid, panels, menus and dialogs, end screen', async ({
    page,
    context,
    browser,
    rooms,
    guards,
  }) => {
    test.setTimeout(150_000)
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Weekly sync', waitingRoom: true })
    await rooms.useIdentity(context, host)
    let peer: Peer | undefined
    try {
      await openToPrejoin(page, room.link)
      await pressJoin(page)
      await waitForPhase(page, 'inCall')
      peer = await addPeer(rooms, guards, browser, room, host, 'Pete Peer')
      await expect(page.getByTestId('participant-tile')).toHaveCount(2)
      await expect(page.getByTestId('participant-tile').locator('video')).toHaveCount(2)
      await expectAccessible(page, 'in-call grid')

      // A guest knocks: the host gets a toast, and the waiting-room panel lists the request.
      await rooms.join(room, { guest: 'Wanda Waiting' }, { inviteToken: await rooms.createInvite(room, host) })
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'is waiting to join' })).toBeVisible()
      await expectAccessible(page, 'in-call grid with a lobby toast')
      await openPanel(page, 'lobby')
      await expect(page.getByTestId('lobby-entry')).toHaveCount(1)
      await expectAccessible(page, 'waiting-room panel')
      await closePanel(page, 'lobby')

      // Chat with a message from the peer.
      await openPanel(peer.page, 'chat')
      await peer.page.getByTestId('chat-input').fill('Hello from Pete')
      await peer.page.getByTestId('chat-send').click()
      await openPanel(page, 'chat')
      await expect(page.getByTestId('chat-message')).toHaveCount(1)
      // pending finding: chat messages are <li> inside <ol role="log"> (no list parent left for axe).
      await expectAccessible(page, 'chat panel', { pending: { listitem: PENDING.chatList } })
      await closePanel(page, 'chat')

      await openPanel(page, 'participants')
      await expect(page.getByTestId('participant-row')).toHaveCount(2)
      await expectAccessible(page, 'people panel')
      await closePanel(page, 'participants')

      // Menus and dialogs.
      await page.getByRole('button', { name: 'More options' }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, 'more-options menu', { include: ['[role="menu"]'] })
      await page.getByRole('menuitem', { name: 'Settings' }).click()
      await expect(page.getByTestId('call-settings')).toBeVisible()
      await expectAccessible(page, 'device settings dialog', { include: ['[data-testid="call-settings"]'] })
      await page.keyboard.press('Escape')
      await settle(page)

      await openHostControls(page)
      // pending finding: the destructive buttons (mute all, end meeting) are 4.42:1 in the dark theme.
      await expectAccessible(page, 'host controls', {
        include: ['[data-testid="host-controls"]'],
        pending: { 'color-contrast': PENDING.destructiveContrast },
      })
      await page.getByTestId('host-end-meeting').click()
      await expect(page.getByTestId('end-meeting-dialog')).toBeVisible()
      await expectAccessible(page, 'end-meeting confirmation', { include: ['[data-testid="end-meeting-dialog"]'] })
      await page.keyboard.press('Escape')
      await settle(page)

      await page.getByTestId('e2ee-badge').click()
      await expect(page.getByTestId('safety-code')).toBeVisible()
      await expectAccessible(page, 'encryption popover', { include: ['[data-slot="popover-content"]'] })
      await page.keyboard.press('Escape')
      await settle(page)

      await page.getByTestId('record-button').click()
      await expect(page.getByTestId('start-recording-dialog')).toBeVisible()
      await expectAccessible(page, 'start-recording dialog', { include: ['[data-testid="start-recording-dialog"]'] })
      await page.keyboard.press('Escape')
      await settle(page)

      await page.keyboard.press('Shift+Slash')
      await expect(page.getByTestId('hotkey-help')).toBeVisible()
      await expectAccessible(page, 'keyboard shortcuts dialog', { include: ['[data-testid="hotkey-help"]'] })
      await page.keyboard.press('Escape')
      await settle(page)

      await removePeer(peer)
      peer = undefined
      await page.getByRole('button', { name: 'Leave call' }).click()
      await expect(page.getByTestId('call-end-screen')).toBeVisible()
      await expectAccessible(page, 'end screen')
    } finally {
      await removePeer(peer)
      await leaveCalls(page)
    }
  })
})
