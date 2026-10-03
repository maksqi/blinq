/**
 * The whole product in one journey, every step through the UI (Stage 10):
 * first admin sign-in → forced password change → the admin emails an account invite (Mailpit) → the invited person
 * registers and creates a room → a guest joins through the waiting room and is admitted → the host mutes the guest →
 * chat both ways → recording start and stop → playback on the recordings page → the admin finds it all in the audit log.
 *
 * The first admin is the bootstrap admin of the e2e database (scripts/e2e.sh runs `cli bootstrap` with ADMIN_EMAIL /
 * ADMIN_PASSWORD). Like auth/first-admin, the operator CLI puts it back into its first-login state before and after
 * (decision), so neither spec depends on the order; everything else (invitee, room, guest) is unique per run.
 */
import { randomBytes } from 'node:crypto'
import type { Page } from '@playwright/test'
import {
  BOOTSTRAP_ADMIN,
  resetBootstrapAdmin,
  strongPassword,
  tokenLink,
  uniqueEmail,
  waitForMail,
} from '../auth/support'
import { actionsMenu, micButton, openActions, openPanel, toastWith, viewOf } from '../collab/helpers'
import { expect, test } from '../fixtures'
import { keyOfLink, spendJoinBudget } from '../join/support'
import { startRecording, stopRecording } from '../fixtures/recording'

test.describe.configure({ timeout: 240_000 })

function chatMessages(page: Page) {
  return page.getByTestId('chat-panel').getByTestId('chat-message')
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text)
  await page.getByTestId('chat-send').click()
}

test.describe('full journey', () => {
  test.beforeEach(() => resetBootstrapAdmin())
  test.afterEach(() => resetBootstrapAdmin())

  test('admin → invited user → room → guest via the waiting room → moderation, chat, recording → audit', async ({
    page,
    flows,
    secrets,
    browserName,
  }) => {
    // pending finding: F-014 toast covers the join button (the "Room created" toast sits over Join now at 1280x720 in
    // Firefox, and Playwright's hover keeps it from closing).
    test.fixme(browserName === 'firefox', 'pending finding: F-014 toast covers the join button')
    const suffix = randomBytes(3).toString('hex')
    const userName = `Uma Journey ${suffix}`
    const roomName = `Journey room ${suffix}`
    const userEmail = uniqueEmail('journey')

    // 1. The first admin signs in and has to choose a new password first.
    const adminPassword = strongPassword('admin')
    secrets.track(adminPassword, 'new admin password')
    await page.goto('/login')
    await page.getByLabel('Email').fill(BOOTSTRAP_ADMIN.email)
    await page.getByLabel('Password', { exact: true }).fill(BOOTSTRAP_ADMIN.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/change-password$/)
    await page.getByLabel('Current password').fill(BOOTSTRAP_ADMIN.password)
    await page.getByLabel('New password', { exact: true }).fill(adminPassword)
    await page.getByLabel('Repeat new password').fill(adminPassword)
    await page.getByRole('button', { name: 'Save and continue' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByTestId('user-menu')).toBeVisible()

    // 2. The admin invites a user by email.
    await page.goto('/admin/invites')
    await page.getByTestId('create-invite').click()
    const inviteDialog = page.getByTestId('create-invite-dialog')
    await inviteDialog.getByLabel('Email (optional)').fill(userEmail)
    await inviteDialog.getByLabel('Email the invite link').check()
    await inviteDialog.getByTestId('create-invite-submit').click()
    await expect(inviteDialog.getByTestId('invite-link')).toBeVisible()
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: `Invite emailed to ${userEmail}` })).toBeVisible()
    await inviteDialog.getByRole('button', { name: 'Done' }).click()
    const mail = await waitForMail(userEmail, /You are invited to join/)
    const invite = tokenLink(mail, '/invite')
    secrets.track(invite.token, 'account invite token')

    // 3. The user registers from the email and creates a room on the dashboard (waiting room on by default).
    const user = await flows.newActor({ name: userName })
    const userPassword = strongPassword('user')
    secrets.track(userPassword, 'user password')
    await user.page.goto(invite.url)
    await expect(user.page.getByRole('heading', { name: 'Accept your invite' })).toBeVisible()
    await expect(user.page.getByLabel('Email')).toHaveValue(userEmail)
    await user.page.getByLabel('Your name').fill(userName)
    await user.page.getByLabel('Password', { exact: true }).fill(userPassword)
    await user.page.getByRole('button', { name: 'Create account' }).click()
    await expect(user.page).toHaveURL(/\/dashboard$/)

    await user.page.getByTestId('new-room').click()
    const roomDialog = user.page.getByTestId('create-room-dialog')
    await roomDialog.getByLabel('Name').fill(roomName)
    await expect(roomDialog.getByRole('switch', { name: 'Waiting room' })).toHaveAttribute('aria-checked', 'true')
    await spendJoinBudget(2)
    await roomDialog.getByTestId('create-room-submit').click()
    await expect(user.page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
    const slug = new URL(user.page.url()).pathname.slice(3)
    await expect(user.page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
    await expect(user.page.getByText('Joining as')).toContainText(userName)
    const host = await flows.enterCall(user)

    // The room page of the same browser builds a guest invite link with the key from this device's vault.
    const roomPage = await user.context.newPage()
    await roomPage.goto('/dashboard')
    const item = roomPage.getByTestId('room-item').filter({ hasText: roomName })
    await expect(item).toHaveAttribute('data-live', 'true')
    await item.getByTestId('room-name').click()
    await roomPage.getByTestId('invite-create').click()
    const link = await roomPage.getByTestId('invite-link').first().inputValue()
    expect(link).toMatch(new RegExp(`/m/${slug}#k=[\\w-]{43}&t=[\\w-]{43}$`))
    secrets.track(keyOfLink(link), 'room key (created in the browser)')
    await roomPage.close()

    // 4. A guest asks to join and the host admits them from the waiting-room panel.
    const guest = await flows.openAsGuest(link, { name: 'Gus Guest' })
    await expect(guest.page.getByTestId('prejoin')).toContainText(roomName)
    await flows.askToJoin(guest)
    await expect(guest.page.getByTestId('waiting-room')).toContainText(roomName)
    await flows.admit('Gus Guest', { by: host })
    await flows.waitForCall(guest)
    await expect.poll(async () => (await viewOf(host.page, guest.identity!))?.name).toBe('Gus Guest')
    await expect.poll(async () => (await viewOf(guest.page, host.identity))?.role).toBe('host')

    // 5. Host action: the host mutes the guest's microphone.
    await expect.poll(async () => (await viewOf(host.page, guest.identity!))?.micEnabled).toBe(true)
    await openActions(host.page, guest.identity!)
    await actionsMenu(host.page).locator('[data-action="mute-microphone"]').click()
    await expect.poll(async () => (await viewOf(host.page, guest.identity!))?.micEnabled).toBe(false)
    await expect(toastWith(guest.page, 'The host muted your microphone')).toBeVisible()
    await expect(micButton(guest.page)).toHaveAttribute('aria-pressed', 'false')

    // 6. Chat both ways.
    await openPanel(host.page, 'chat')
    await openPanel(guest.page, 'chat')
    await sendChat(host.page, `Welcome ${suffix}`)
    await expect(chatMessages(guest.page).filter({ hasText: `Welcome ${suffix}` })).toHaveCount(1)
    await sendChat(guest.page, `Thanks ${suffix}`)
    await expect(chatMessages(host.page).filter({ hasText: `Thanks ${suffix}` })).toHaveCount(1)

    // 7. The host records a few seconds of the call; everyone sees the indicator.
    const recordingId = await startRecording(host.page, 'server')
    await expect(guest.page.getByTestId('recording-indicator')).toBeVisible()
    await host.page.waitForTimeout(4_000)
    await stopRecording(host.page)
    await expect(guest.page.getByTestId('recording-indicator')).toHaveCount(0)
    await expect
      .poll(
        async () => {
          const res = await host.page.request.get(`/api/recordings/${recordingId}`)
          const status = res.ok() ? ((await res.json()) as { recording: { status: string } }).recording.status : 'none'
          if (status === 'failed') throw new Error('the recording failed processing')
          return status
        },
        { timeout: 90_000, intervals: [500, 1_000, 2_000], message: 'the recording is ready' },
      )
      .toBe('ready')
    await flows.leave(guest)
    await flows.leave(host)

    // 8. The host plays the recording from the recordings page.
    await host.page.goto('/recordings')
    const row = host.page.locator(`[data-recording-id="${recordingId}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText(roomName)
    await row.getByRole('link', { name: `Play the recording of ${roomName}` }).click()
    await expect(host.page).toHaveURL(new RegExp(`/recordings/${recordingId}$`))
    const player = host.page.getByTestId('recording-player')
    await expect(player).toBeVisible()
    await player.evaluate((element: HTMLVideoElement) => {
      element.muted = true
      return element.play()
    })
    await expect
      .poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2)
    await expect
      .poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 20_000 })
      .toBeGreaterThan(0)

    // 9. The admin's audit log has the journey: the user's own entries, then both sides of the account invite.
    const entry = (action: string) => page.locator(`[data-testid="audit-row"][data-action="${action}"]`)
    await page.goto('/admin/audit')
    await page.getByRole('button', { name: userName, exact: true }).first().click()
    await expect(page.getByTestId('actor-filter')).toContainText(userName)
    for (const action of ['auth.invite_accepted', 'call.mute', 'recording.started', 'recording.stopped']) {
      await expect(entry(action), `audit entry ${action}`).toHaveCount(1)
    }
    // The target column (the last code cell) holds the invite id.
    const inviteId = (await entry('auth.invite_accepted').locator('td code').last().textContent())?.trim()
    expect(inviteId).toMatch(/^[0-9a-f-]{36}$/)
    await page.getByRole('button', { name: 'Show entries by everyone' }).click()
    await expect(page.getByTestId('actor-filter')).toHaveCount(0)
    await page.getByLabel('Search by target').fill(inviteId!)
    await expect(entry('admin.invite_created')).toHaveCount(1)
    await expect(entry('auth.invite_accepted')).toHaveCount(1)
  })
})
