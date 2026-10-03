/**
 * Stage 10 responsive polish: every page type at 375, 768 and 1440 px has no horizontal overflow, keeps its controls
 * inside the viewport and reaches its primary action; on phones (375 px) touch targets are at least 44 px.
 *
 * Covered elsewhere and not repeated here: the home, sign-in and 404 layout (shell/responsive), the admin pages except
 * recordings (admin/responsive), the harness pre-join and call (call/responsive) and the call panels (collab/
 * responsive). This file adds the remaining page types and the 44 px touch-target check for every page type.
 * `@responsive` also runs in `mobile-chromium`; the pages without media also run in `webkit-ui` (`@ui`).
 */
import type { Locator, Page } from '@playwright/test'
import {
  accountInviteToken,
  controlsOutsideViewport,
  emailVerificationToken,
  expect,
  expectFits,
  horizontalOverflow,
  notePending,
  overflowingElements,
  PENDING,
  requirePasswordChange,
  seedRecordings,
  settleAnimations,
  smallTargets,
  test,
  unknownToken,
} from '../a11y/support'
import { micButton } from '../collab/helpers'
import { waitForPhase } from '../fixtures/livekit'
import { leaveCalls, newWatchedContext, openToPrejoin, pressJoin, waitingRequestId } from '../join/support'

const WIDTHS = [375, 768, 1440] as const
/** WCAG 2.5.5 (AAA) and the platform guidelines: 44 CSS px for touch. */
const TOUCH_MIN = 44
const ERROR_PAGE_CONSOLE = /Failed to load resource: the server responded with a status of 40[34]/
/** pending finding: the 403 page logs [NUXT_E1005] on load (admin middleware aborts the navigation during SSR). */
const FORBIDDEN_PAGE_CONSOLE = /\[NUXT_E1005\]/

function viewportFor(width: number) {
  return { width, height: width < 700 ? 740 : 900 }
}

interface PendingChecks {
  /** The page overflows because of a known defect: record it instead of failing. */
  overflow?: string
  /** Touch targets under 44 px are a known defect: record them instead of failing. */
  touch?: string
}

/**
 * Layout checks for one page state: fits the width, the primary action is reachable, touch targets on phones.
 * pending finding: every page except the call control bar still has touch targets under 44 px on phones, so the
 * touch check defaults to `PENDING.touchTargets` (recorded as an annotation with the offending controls).
 */
async function checkPage(
  page: Page,
  label: string,
  width: number,
  primary: Locator,
  pending: PendingChecks = { touch: PENDING.touchTargets },
): Promise<void> {
  const name = `${label} at ${width}px`
  await expect(primary, `${name}: primary control`).toBeVisible()
  if (pending.overflow) {
    // An overflowing page also widens the layout viewport of phones, which moves fixed dialogs past the screen edge.
    await settleAnimations(page)
    notePending(pending.overflow, {
      label: name,
      overflow: await horizontalOverflow(page),
      elements: await overflowingElements(page),
      outside: await controlsOutsideViewport(page),
    })
  } else {
    await expectFits(page, name)
  }
  await primary.scrollIntoViewIfNeeded()
  await expect.soft(primary, `${name}: primary control in the viewport`).toBeInViewport()
  if (width < 700) {
    const small = await smallTargets(page, TOUCH_MIN)
    if (pending.touch) {
      if (small.length > 0) notePending(pending.touch, { label: name, small })
    } else {
      expect.soft(small, `${name}: touch targets under ${TOUCH_MIN} px`).toEqual([])
    }
  }
}

for (const width of WIDTHS) {
  test.describe(`pages at ${width}px`, { tag: ['@responsive', '@ui'] }, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewportFor(width))
    })

    test(`sign-up, invite, email and password pages at ${width}px`, async ({ page, rooms, e2eDb, secrets }) => {
      await page.goto('/register')
      await checkPage(page, 'register (closed)', width, page.getByRole('main').getByRole('link', { name: 'Sign in' }))

      await page.goto(`/invite#${await accountInviteToken(e2eDb, secrets)}`)
      await checkPage(page, 'accept invite', width, page.getByTestId('invite-form').locator('button[type="submit"]'))

      const user = await rooms.createUser()
      await page.goto(`/verify-email#${await emailVerificationToken(e2eDb, user, secrets)}`)
      await expect(page.getByTestId('auth-status-success')).toBeVisible()
      await checkPage(page, 'verify email', width, page.getByRole('main').getByRole('link', { name: 'Sign in' }))

      await page.goto('/forgot-password')
      await checkPage(
        page,
        'forgot password',
        width,
        page.getByTestId('forgot-password-form').locator('button[type="submit"]'),
      )

      await page.goto(`/reset-password#${unknownToken()}`)
      await checkPage(
        page,
        'reset password',
        width,
        page.getByTestId('reset-password-form').locator('button[type="submit"]'),
      )
    })

    test(`signed-in pages at ${width}px`, async ({ page, rooms, e2eDb, guards }) => {
      const user = await rooms.createUser({ displayName: 'Rae Responsive With A Rather Long Display Name' })
      const room = await rooms.createRoom(user, {
        name: 'A room with a long name to test wrapping on narrow screens',
        waitingRoom: true,
      })
      await rooms.createRoom(user, { name: 'Second room' })
      await rooms.createInvite(room, user)
      const { processingId } = await seedRecordings(e2eDb, user, room)
      await rooms.useIdentity(page.context(), user)

      await page.goto('/dashboard')
      await expect(page.getByTestId('room-item')).toHaveCount(2)
      // pending finding: the long room name pushes the dashboard 118 px past a 375 px screen.
      const dashboard = width < 700 ? { overflow: PENDING.dashboardOverflow, touch: PENDING.touchTargets } : undefined
      await checkPage(page, 'dashboard', width, page.getByTestId('instant-meeting'), dashboard)
      await page.getByTestId('new-room').click()
      const dialog = page.getByTestId('create-room-dialog')
      await expect(dialog).toBeVisible()
      await checkPage(page, 'new-room dialog', width, dialog.getByTestId('create-room-submit'), dashboard)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      if (width < 768) {
        await page.getByTestId('mobile-nav-trigger').click()
        const nav = page.getByTestId('mobile-nav')
        await expect(nav).toBeVisible()
        await checkPage(page, 'mobile navigation', width, nav.getByRole('link', { name: 'Recordings' }), dashboard)
        await page.keyboard.press('Escape')
        await expect(nav).toBeHidden()
      }

      await page.goto(`/rooms/${room.id}`)
      await expect(page.getByTestId('invite-manager')).toBeVisible()
      await checkPage(page, 'room page', width, page.getByTestId('room-settings-save'))

      await page.goto('/recordings')
      await expect(page.getByText('Rae Responsive').or(page.getByTestId('recordings-table')).first()).toBeVisible()
      await checkPage(page, 'recordings', width, page.getByTestId('delete-recording').first())

      await page.goto(`/recordings/${processingId}`)
      await expect(page.getByText('Processing the recording')).toBeVisible()
      await checkPage(page, 'recording detail', width, page.getByTestId('delete-recording'))

      await page.goto('/settings')
      await checkPage(page, 'settings', width, page.getByTestId('profile-form').locator('button[type="submit"]'))

      await page.goto('/settings/sessions')
      await expect(page.getByTestId('session-item').first()).toBeVisible()
      await checkPage(page, 'sessions', width, page.getByTestId('session-item').first())

      guards.allowConsoleError(ERROR_PAGE_CONSOLE)
      guards.allowConsoleError(FORBIDDEN_PAGE_CONSOLE) // pending finding: see FORBIDDEN_PAGE_CONSOLE
      await page.goto('/admin')
      await expect(page.getByText('Error 403')).toBeVisible()
      await checkPage(page, '403', width, page.getByRole('button', { name: 'Go to dashboard' }))
    })

    test(`forced password change and admin recordings at ${width}px`, async ({ page, rooms, e2eDb }) => {
      const pending = await rooms.createUser()
      await requirePasswordChange(e2eDb, pending)
      await rooms.useIdentity(page.context(), pending)
      await page.goto('/change-password')
      await checkPage(
        page,
        'change password (forced)',
        width,
        page.getByTestId('change-password-form').locator('button[type="submit"]'),
      )

      await page.context().clearCookies()
      const admin = await rooms.createUser({ role: 'admin', displayName: 'Responsive Admin' })
      const room = await rooms.createRoom(admin, { name: 'Recorded room with a long name for narrow tables' })
      await seedRecordings(e2eDb, admin, room)
      await rooms.useIdentity(page.context(), admin)
      await page.goto('/admin/recordings')
      await expect(page.getByTestId('admin-recordings-search')).toBeVisible()
      await page.waitForLoadState('networkidle')
      await checkPage(page, 'admin recordings', width, page.getByTestId('admin-recordings-search'))
    })
  })
}

// Touch targets on phones for the page types whose layout other specs already cover.
test.describe('touch targets on phones', { tag: ['@responsive', '@ui'] }, () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(viewportFor(375))
  })

  test('home, sign-in and 404 at 375px', async ({ page, guards }) => {
    await page.goto('/')
    await checkPage(page, 'home', 375, page.getByTestId('join-link-form').getByRole('button', { name: 'Join' }))
    await page.goto('/login')
    await checkPage(page, 'login', 375, page.getByTestId('login-form').locator('button[type="submit"]'))
    guards.allowConsoleError(ERROR_PAGE_CONSOLE)
    await page.goto('/this-page-does-not-exist')
    await checkPage(page, '404', 375, page.getByRole('button', { name: 'Go home' }))
  })

  test('admin pages at 375px', async ({ page, rooms }) => {
    const admin = await rooms.createUser({ role: 'admin' })
    await rooms.createRoom(admin, { name: 'Admin room' })
    await rooms.useIdentity(page.context(), admin)
    for (const target of [
      { path: '/admin', ready: 'stat-users' },
      { path: '/admin/users', ready: 'create-user' },
      { path: '/admin/invites', ready: 'create-invite' },
      { path: '/admin/rooms', ready: 'refresh-rooms' },
      { path: '/admin/settings', ready: 'save-settings' },
      { path: '/admin/audit', ready: 'filter-action' },
    ]) {
      await page.goto(target.path)
      await page.waitForLoadState('networkidle')
      await checkPage(page, target.path, 375, page.getByTestId(target.ready).first())
    }
  })
})

// The real `/m/<slug>` join screens (the harness pre-join is in call/responsive); media, so no `@ui`.
for (const width of WIDTHS) {
  test.describe(`meeting join screens at ${width}px`, { tag: '@responsive' }, () => {
    test(`pre-join, password, waiting room and missing key at ${width}px`, async ({
      page,
      context,
      browser,
      rooms,
      guards,
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize(viewportFor(width))
      const host = await rooms.createUser({ displayName: 'Hana Host' })
      const room = await rooms.createRoom(host, { name: 'Office hours with a long meeting name', waitingRoom: true })
      await rooms.useIdentity(context, host)

      await openToPrejoin(page, room.link)
      await checkPage(page, 'pre-join (host)', width, page.getByTestId('join-button'))

      await rooms.join(room, host)
      const link = rooms.inviteLink(room, await rooms.createInvite(room, host))
      const guestContext = await newWatchedContext(browser, guards)
      const guest = await guestContext.newPage()
      await guest.setViewportSize(viewportFor(width))
      await openToPrejoin(guest, link)
      await checkPage(guest, 'pre-join (guest)', width, guest.getByLabel('Your name'))
      await waitingRequestId(guest, room.slug, () => pressJoin(guest, 'Wanda Waiting'))
      await checkPage(guest, 'waiting room', width, guest.getByTestId('waiting-cancel'))
      await guest.getByTestId('waiting-cancel').click()
      await expect(guest.getByTestId('prejoin')).toBeVisible()

      const locked = await rooms.createRoom(host, { name: 'Board room', password: 'open-sesame' })
      await openToPrejoin(guest, rooms.inviteLink(locked, await rooms.createInvite(locked, host)))
      await pressJoin(guest, 'Pat Password')
      await checkPage(guest, 'password prompt', width, guest.getByTestId('join-password-submit'))
      await guestContext.close()

      const strangerContext = await newWatchedContext(browser, guards)
      const stranger = await strangerContext.newPage()
      await stranger.setViewportSize(viewportFor(width))
      await stranger.goto(`/m/${room.slug}`)
      const problem = stranger.getByTestId('join-error')
      await expect(problem).toBeVisible({ timeout: 20_000 })
      await checkPage(stranger, 'join error (missing key)', width, problem.getByRole('heading').first())
      await strangerContext.close()
    })
  })
}

test.describe('call controls on phones', { tag: '@responsive' }, () => {
  test('control bar touch targets at 375px', async ({ page, context, rooms }) => {
    await page.setViewportSize(viewportFor(375))
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Phone call' })
    await rooms.useIdentity(context, host)
    await openToPrejoin(page, room.link)
    await page.getByTestId('join-button').click()
    await waitForPhase(page, 'inCall')
    try {
      await expect(micButton(page)).toBeVisible()
      const bar = page.getByTestId('control-bar')
      await expect(bar).toBeInViewport({ ratio: 1 })
      expect(await smallTargets(page, TOUCH_MIN, '[data-testid="control-bar"]'), 'control bar: under 44 px').toEqual([])
      // pending finding: outside the control bar, the E2EE badge and the tile options button are under 44 px.
      notePending(PENDING.callTopTargets, await smallTargets(page, TOUCH_MIN))
    } finally {
      await leaveCalls(page)
    }
  })
})
