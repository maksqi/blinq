/**
 * Stage 10 accessibility: axe (WCAG 2.x A/AA) on every page type outside the call, in the light and the dark theme,
 * with menus, sheets and dialogs open. A serious or critical violation fails the test (soft, so one run lists every
 * state). The call screens are in axe-call.spec.ts (they need media and E2EE).
 *
 * The theme is stored the way the theme menu stores it (`blinq-color-mode` in localStorage), so every engine renders
 * the chosen theme from the first paint. UI-only, so also in `webkit-ui`.
 */
import type { Page } from '@playwright/test'
import type { Secrets } from '../fixtures/base'
import type { E2eUser, RoomsFixture } from '../fixtures/join'
import { apiAs } from '../join/support'
import {
  accountInviteToken,
  emailVerificationToken,
  expect,
  expectAccessible,
  expectTheme,
  PENDING,
  requirePasswordChange,
  seedRecordings,
  test,
  THEMES,
  unknownToken,
  useTheme,
} from './support'

/** Console errors of the error pages themselves: the document answers 403 or 404 on purpose. */
const ERROR_PAGE_CONSOLE = /Failed to load resource: the server responded with a status of 40[34]/
/** pending finding: the 403 page logs [NUXT_E1005] on load (admin middleware aborts the navigation during SSR). */
const FORBIDDEN_PAGE_CONSOLE = /\[NUXT_E1005\]/

async function signIn(page: Page, rooms: RoomsFixture, role: 'user' | 'admin' = 'user', displayName?: string) {
  const user = await rooms.createUser({
    role,
    displayName: displayName ?? (role === 'admin' ? 'Ada Admin' : 'Uma User'),
  })
  await rooms.useIdentity(page.context(), user)
  return user
}

const ADMIN_PAGES = [
  { path: '/admin', ready: 'stat-users', name: 'admin overview' },
  { path: '/admin/users', ready: 'users-table', name: 'admin users' },
  { path: '/admin/invites', ready: 'invites-table', name: 'admin invites' },
  { path: '/admin/rooms', ready: 'rooms-table', name: 'admin rooms' },
  { path: '/admin/recordings', ready: 'admin-recordings-search', name: 'admin recordings' },
  { path: '/admin/settings', ready: 'settings-form', name: 'admin settings' },
  { path: '/admin/audit', ready: 'audit-table', name: 'admin audit log' },
] as const

for (const theme of THEMES) {
  test.describe(`axe in the ${theme} theme`, { tag: '@ui' }, () => {
    test.beforeEach(async ({ context }) => {
      await useTheme(context, theme)
    })

    // ---- Public pages -------------------------------------------------------------------------------------------

    test(`home and the theme menu (${theme})`, async ({ page }) => {
      await page.goto('/')
      await expect(page.getByTestId('join-link-form')).toBeVisible()
      await expectTheme(page, theme)
      await expectAccessible(page, `home (${theme})`)

      await page.getByRole('banner').getByRole('button', { name: 'Change theme' }).click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, `theme menu (${theme})`, { include: ['[role="menu"]'] })
      await page.keyboard.press('Escape')
    })

    test(`sign-in page (${theme})`, async ({ page }) => {
      await page.goto('/login')
      await expect(page.getByTestId('login-form')).toBeVisible()
      await expectTheme(page, theme)
      await expectAccessible(page, `login (${theme})`)
    })

    test(`registration closed and open (${theme})`, async ({ page, rooms }) => {
      await page.goto('/register')
      await expect(page.getByTestId('auth-status-error').or(page.getByTestId('register-form'))).toBeVisible()
      await expectAccessible(page, `register, invite only (${theme})`)

      // Open registration for a moment to see the form; the default (invite only) comes back in any case.
      const admin = await rooms.createUser({ role: 'admin' })
      try {
        expect((await apiAs(admin, 'PUT', '/api/admin/settings', { 'registration.mode': 'open' })).status).toBe(200)
        await page.reload()
        await expect(page.getByTestId('register-form')).toBeVisible()
        await expectAccessible(page, `register form (${theme})`)
      } finally {
        const restored = await apiAs(admin, 'PUT', '/api/admin/settings', { 'registration.mode': 'invite_only' })
        expect(restored.status).toBe(200)
      }
    })

    test(`account invite (${theme})`, async ({ page, e2eDb, secrets }) => {
      const token = await accountInviteToken(e2eDb, secrets)
      await page.goto(`/invite#${token}`)
      await expect(page.getByTestId('invite-form')).toBeVisible()
      await expectAccessible(page, `accept invite (${theme})`)
    })

    test(`email confirmation (${theme})`, async ({ page, rooms, e2eDb, secrets }) => {
      const user = await rooms.createUser()
      const token = await emailVerificationToken(e2eDb, user, secrets)
      await page.goto(`/verify-email#${token}`)
      await expect(page.getByTestId('auth-status-success')).toBeVisible()
      await expectAccessible(page, `verify email (${theme})`)
    })

    test(`forgot and reset password (${theme})`, async ({ page }) => {
      await page.goto('/forgot-password')
      await expect(page.getByTestId('forgot-password-form')).toBeVisible()
      await expectAccessible(page, `forgot password (${theme})`)

      // The form shows without asking the server; the token is only checked on submit.
      await page.goto(`/reset-password#${unknownToken()}`)
      await expect(page.getByTestId('reset-password-form')).toBeVisible()
      await expectAccessible(page, `reset password (${theme})`)
    })

    test(`forced password change (${theme})`, async ({ page, rooms, e2eDb }) => {
      const user = await signIn(page, rooms)
      await requirePasswordChange(e2eDb, user)
      await page.goto('/dashboard')
      await expect(page).toHaveURL(/\/change-password$/)
      await expect(page.getByTestId('change-password-form')).toBeVisible()
      await expectAccessible(page, `change password, forced (${theme})`)
    })

    test(`error pages 404 and 403 (${theme})`, async ({ page, rooms, guards }) => {
      guards.allowConsoleError(ERROR_PAGE_CONSOLE)
      guards.allowConsoleError(FORBIDDEN_PAGE_CONSOLE) // pending finding: see FORBIDDEN_PAGE_CONSOLE
      await page.goto('/this-page-does-not-exist')
      await expect(page.getByText('Error 404')).toBeVisible()
      await expectTheme(page, theme)
      await expectAccessible(page, `404 (${theme})`)

      await signIn(page, rooms)
      await page.goto('/admin')
      await expect(page.getByText('Error 403')).toBeVisible()
      await expectAccessible(page, `403 (${theme})`)
    })

    // ---- Signed-in pages ----------------------------------------------------------------------------------------

    test(`dashboard, new-room dialog and account menu (${theme})`, async ({ page, rooms }) => {
      const user = await signIn(page, rooms)
      const live = await rooms.createRoom(user, { name: 'Weekly sync', waitingRoom: true })
      await rooms.createRoom(user, { name: 'Design review' })
      await rooms.join(live, user) // the meeting is live: the list shows its live marker
      await page.goto('/dashboard')
      await expect(page.getByTestId('room-item')).toHaveCount(2)
      await expectAccessible(page, `dashboard (${theme})`)

      await page.getByTestId('new-room').click()
      await expect(page.getByTestId('create-room-dialog')).toBeVisible()
      await expectAccessible(page, `new-room dialog (${theme})`, { include: ['[data-testid="create-room-dialog"]'] })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('create-room-dialog')).toBeHidden()

      await page.getByTestId('user-menu').click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, `account menu (${theme})`, { include: ['[role="menu"]'] })
      await page.keyboard.press('Escape')
    })

    test(`mobile navigation sheet (${theme})`, async ({ page, rooms }) => {
      await page.setViewportSize({ width: 375, height: 740 })
      await signIn(page, rooms)
      await page.goto('/dashboard')
      await page.getByTestId('mobile-nav-trigger').click()
      await expect(page.getByTestId('mobile-nav')).toBeVisible()
      await expectAccessible(page, `mobile navigation (${theme})`, { include: ['[data-testid="mobile-nav"]'] })
      await page.keyboard.press('Escape')
    })

    test(`room page and its confirmations (${theme})`, async ({ page, rooms }) => {
      const owner = await signIn(page, rooms)
      const room = await rooms.createRoom(owner, { name: 'Board room', waitingRoom: true, password: 'open-sesame' })
      await rooms.createInvite(room, owner)
      await page.goto(`/rooms/${room.id}`)
      await expect(page.getByRole('heading', { name: 'Board room' })).toBeVisible()
      await expect(page.getByTestId('invite-manager')).toBeVisible()
      await expectAccessible(page, `room page (${theme})`)

      await page.getByTestId('rotate-key-open').click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expectAccessible(page, `rotate-key confirmation (${theme})`, { include: ['[role="alertdialog"]'] })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('alertdialog')).toBeHidden()

      await page.getByTestId('delete-room-open').click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expectAccessible(page, `delete-room confirmation (${theme})`, {
        include: ['[role="alertdialog"]'],
        // pending finding: the destructive "Delete room" button is 4.42:1 in the dark theme.
        pending: theme === 'dark' ? { 'color-contrast': PENDING.destructiveContrast } : {},
      })
      await page.keyboard.press('Escape')
    })

    test(`recordings list and detail (${theme})`, async ({ page, rooms, e2eDb }) => {
      const owner = await signIn(page, rooms)
      const room = await rooms.createRoom(owner, { name: 'Town hall' })
      const { processingId } = await seedRecordings(e2eDb, owner, room)
      await page.goto('/recordings')
      await expect(page.getByTestId('recordings-table')).toBeVisible()
      await expect(page.getByText('Town hall').first()).toBeVisible()
      await expectAccessible(page, `recordings list (${theme})`)

      await page.goto(`/recordings/${processingId}`)
      await expect(page.getByText('Processing the recording')).toBeVisible()
      await expectAccessible(page, `recording detail, processing (${theme})`)
    })

    test(`account settings and sessions (${theme})`, async ({ page, rooms }) => {
      await signIn(page, rooms)
      await page.goto('/settings')
      await expect(page.getByTestId('profile-form')).toBeVisible()
      await expectAccessible(page, `settings (${theme})`)

      await page.goto('/settings/sessions')
      await expect(page.getByTestId('session-item').first()).toBeVisible()
      // pending finding: the session list (role="list") has items without role="listitem".
      await expectAccessible(page, `sessions (${theme})`, {
        pending: { 'aria-required-children': PENDING.sessionsList },
      })
    })

    // ---- Admin --------------------------------------------------------------------------------------------------

    test(`admin pages (${theme})`, async ({ page, rooms, secrets }) => {
      const admin = await signIn(page, rooms, 'admin')
      await seedAdminData(rooms, admin, secrets)
      for (const target of ADMIN_PAGES) {
        await page.goto(target.path)
        await expect(page.getByTestId(target.ready).first()).toBeVisible()
        await page.waitForLoadState('networkidle')
        await expectAccessible(page, `${target.name} (${theme})`)
      }
    })

    test(`admin dialogs and the user sheet (${theme})`, async ({ page, rooms, secrets }) => {
      const admin = await signIn(page, rooms, 'admin')
      await seedAdminData(rooms, admin, secrets)

      await page.goto('/admin/users')
      await page.getByTestId('create-user').click()
      await expect(page.getByTestId('create-user-dialog')).toBeVisible()
      await expectAccessible(page, `create-user dialog (${theme})`, { include: ['[data-testid="create-user-dialog"]'] })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('create-user-dialog')).toBeHidden()

      await page.getByTestId('manage-user').first().click()
      await expect(page.getByTestId('user-sheet')).toBeVisible()
      await expectAccessible(page, `user sheet (${theme})`, { include: ['[data-testid="user-sheet"]'] })
      await page.keyboard.press('Escape')

      await page.goto('/admin/invites')
      await page.getByTestId('create-invite').click()
      await expect(page.getByTestId('create-invite-dialog')).toBeVisible()
      await expectAccessible(page, `create-invite dialog (${theme})`, {
        include: ['[data-testid="create-invite-dialog"]'],
      })
      await page.keyboard.press('Escape')
    })
  })
}

/** Something in every admin list: a room (also an audit entry), a second user and an account invite. */
async function seedAdminData(rooms: RoomsFixture, admin: E2eUser, secrets: Secrets): Promise<void> {
  await rooms.createRoom(admin, { name: 'Admin room' })
  await rooms.createUser({ displayName: 'Lee Listed' })
  const invite = await apiAs(admin, 'POST', '/api/admin/invites', { email: `a11y-${Date.now()}@example.test` })
  expect(invite.status).toBe(201)
  secrets.track(String(invite.body.token), 'account invite token')
}
