import { randomBytes } from 'node:crypto'
import { expect, test } from '../fixtures'
import { joinState } from '../fixtures/flows'
import { spendJoinBudget } from '../join/support'

// The dashboard as a UI (@ui: also in the webkit-ui project). No media and no call: the meeting page a new room opens
// shows pre-join, or the unsupported-browser screen in an engine without E2EE (Linux WebKit).
test.describe('dashboard', { tag: '@ui' }, () => {
  test('lists owned and co-hosted rooms with their state and the actions this device allows', async ({
    page,
    flows,
    rooms,
  }) => {
    const owner = await flows.loginAs('host', { name: 'Dana Dashboard', page })
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByTestId('rooms-empty')).toBeVisible()

    const own = await flows.createRoom({ name: 'Weekly sync', password: `pw-${randomBytes(4).toString('hex')}` })
    const partner = await rooms.createUser({ displayName: 'Otto Owner' })
    const shared = await rooms.createRoom(partner, { name: 'Partner room' })
    await rooms.addCohost(shared, partner, owner.account)
    // A meeting in the own room is live once the owner's join started it.
    await rooms.join(own, owner.account)
    await page.reload()

    const ownItem = page.getByTestId('room-item').filter({ hasText: 'Weekly sync' })
    await expect(ownItem).toHaveAttribute('data-slug', own.slug)
    await expect(ownItem).toHaveAttribute('data-live', 'true')
    await expect(ownItem).toContainText('Live')
    await expect(ownItem).toContainText('Password')
    // The room was made elsewhere (in Node), so this browser has no key: no host link, no join.
    await expect(ownItem).toContainText('Key not on this device')
    await expect(ownItem.getByTestId('room-copy-link')).toBeDisabled()
    await expect(ownItem.getByTestId('room-join')).toBeDisabled()

    const sharedItem = page.getByTestId('room-item').filter({ hasText: 'Partner room' })
    await expect(sharedItem).toHaveAttribute('data-live', 'false')
    await expect(sharedItem).toContainText('Co-host')
    await sharedItem.getByTestId('room-name').click()
    await expect(page).toHaveURL(new RegExp(`/rooms/${shared.id}$`))
    await expect(page.getByRole('heading', { name: 'Partner room' })).toBeVisible()
    await expect(page.getByText('Only the room owner can change these settings.')).toBeVisible()
  })

  test('the new-room dialog checks the name, creates the room and keeps its key on this device', async ({
    page,
    flows,
    browserName,
  }) => {
    await flows.loginAs('host', { name: 'Nina New', page })
    if (browserName === 'webkit') {
      // WebKit with E2EE (macOS) reaches pre-join, which opens the mock camera and microphone.
      await page
        .context()
        .grantPermissions(['camera', 'microphone'])
        .catch(() => undefined)
    }
    await page.goto('/dashboard')
    await page.getByTestId('new-room').click()
    const dialog = page.getByTestId('create-room-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-room-submit').click()
    await expect(dialog.getByText('Enter a room name')).toBeVisible()
    await expect(dialog.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true')

    await dialog.getByLabel('Name').fill('Design review')
    await dialog.getByRole('switch', { name: 'Allow guests' }).click()
    await spendJoinBudget(2)
    await dialog.getByTestId('create-room-submit').click()

    // The room opens right away; the key travels in this tab's storage, never in the URL.
    await expect(page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
    const slug = new URL(page.url()).pathname.slice(3)
    await expect
      .poll(async () => {
        const state = await joinState(page)
        return state?.phase === 'error' ? `error:${state.problem}` : state?.phase
      })
      .toMatch(/^(prejoin|error:UNSUPPORTED_BROWSER)$/)

    await page.goto('/dashboard')
    const item = page.getByTestId('room-item').filter({ hasText: 'Design review' })
    await expect(item).toHaveAttribute('data-slug', slug)
    await expect(item).not.toContainText('Key not on this device')
    await expect(item.getByTestId('room-copy-link')).toBeEnabled()
    await expect(item.getByTestId('room-join')).toBeVisible()
    await item.getByTestId('room-name').click()
    await expect(page.getByRole('heading', { name: 'Design review' })).toBeVisible()
    await expect(page.getByTestId('room-key-status')).toHaveCount(0)
    await expect(page.getByRole('switch', { name: 'Allow guests' })).toHaveAttribute('aria-checked', 'false')
  })
})
