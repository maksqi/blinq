/**
 * Disabling an account takes it out of a live call within 1 s (Stage 03 DoD): the user is in a real meeting on the
 * dev LiveKit (call harness), an admin disables the account in the admin UI, and the user's call reaches `removed`.
 */
import { expect, test } from '../fixtures'
import { waitForPhase } from '../fixtures/livekit'

test.describe('disabling a user in a call', () => {
  test('removes them from the live call within 1 s', async ({ page, browser, baseURL, rooms, guards }) => {
    const user = await rooms.createUser({ displayName: 'Dana Disabled' })
    const room = await rooms.createRoom(user, { waitingRoom: false })
    const joined = await rooms.join(room, user)
    await rooms.useIdentity(page.context(), user)
    await page.goto(rooms.harnessPath(room, joined.grant!, user.displayName))
    await page.getByTestId('join-button').click()
    await waitForPhase(page, 'inCall')

    const admin = await rooms.createUser({ role: 'admin', displayName: 'Ada Admin' })
    const context = await browser.newContext({ baseURL })
    await guards.watch(context)
    try {
      await rooms.useIdentity(context, admin)
      const adminPage = await context.newPage()
      await adminPage.goto('/admin/users')
      await adminPage.getByLabel('Search users').fill(user.email)
      await adminPage.getByTestId('user-row').filter({ hasText: user.email }).getByTestId('manage-user').click()
      await adminPage.getByTestId('user-disabled').click()
      const confirm = adminPage.getByTestId('confirm-dialog')
      await expect(confirm).toContainText('Disable this account?')

      const removed = page.waitForFunction(
        () =>
          (window as unknown as { __blinqTest?: { state: { call?: { phase?: string } } } }).__blinqTest?.state.call
            ?.phase === 'removed',
        undefined,
        { polling: 25, timeout: 10_000 },
      )
      const started = Date.now()
      await confirm.getByTestId('confirm-action').click()
      await removed
      const elapsed = Date.now() - started
      test.info().annotations.push({ type: 'removal time', description: `${elapsed} ms` })
      expect(elapsed).toBeLessThan(1_000)

      await expect(adminPage.getByTestId('user-sheet')).toContainText('Disabled')
    } finally {
      await context.close()
    }
  })
})
