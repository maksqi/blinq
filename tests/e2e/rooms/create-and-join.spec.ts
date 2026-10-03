import { expect, test } from '../fixtures'
import { callState, waitForPhase, waitForRemoteFrames } from '../fixtures/livekit'
import { keyOfLink, leaveCalls, newWatchedContext, openToPrejoin, pressJoin, spendJoinBudget } from '../join/support'

// Stage 04: the dashboard creates rooms with a browser-made slug and key, the room page builds invite links from the
// key in this device's vault, and `/m/<slug>` takes host and guest into the same encrypted call. The base fixture
// fails these tests on console errors and CSP violations on the dashboard, the room page and the meeting page.
test.describe('create a room and meet', () => {
  test('a user creates a room, invites a guest from the room page, and both see each other', async ({
    page,
    context,
    browser,
    rooms,
    guards,
    secrets,
    browserName,
  }) => {
    // pending finding: F-014 toast covers the join button (the "Room created" toast sits over Join now at 1280x720 in
    // Firefox, and Playwright's hover keeps it from closing).
    test.fixme(browserName === 'firefox', 'pending finding: F-014 toast covers the join button')
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    await rooms.useIdentity(context, host)

    await page.goto('/dashboard')
    await expect(page.getByTestId('rooms-empty')).toBeVisible()
    await page.getByTestId('new-room').click()
    const dialog = page.getByTestId('create-room-dialog')
    await dialog.getByLabel('Name').fill('Design review')
    await dialog.getByRole('switch', { name: 'Waiting room' }).click()
    await spendJoinBudget(2)
    await dialog.getByTestId('create-room-submit').click()

    // In-app navigation: the key travels in this tab's storage, never in the URL.
    await expect(page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
    const slug = new URL(page.url()).pathname.slice(3)
    await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Joining as')).toContainText('Hana Host')
    await pressJoin(page)
    await waitForPhase(page, 'inCall')
    const hostIdentity = (await callState(page))!.identity!

    // The room page of the same browser builds an invite link with the key from the vault.
    const admin = await context.newPage()
    await admin.goto('/dashboard')
    const item = admin.getByTestId('room-item').filter({ hasText: 'Design review' })
    await expect(item).toHaveAttribute('data-live', 'true')
    await expect(item).toContainText(slug)
    await item.getByTestId('room-name').click()
    await expect(admin).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/)
    await expect(admin.getByTestId('room-key-status')).toHaveCount(0)
    await admin.getByLabel('Label (optional)').fill('Guests')
    await admin.getByTestId('invite-create').click()
    const link = await admin.getByTestId('invite-link').first().inputValue()
    expect(link).toMatch(new RegExp(`/m/${slug}#k=[\\w-]{43}&t=[\\w-]{43}$`))
    secrets.track(keyOfLink(link), 'room key (created in the browser)')
    await admin.close()

    const guestContext = await newWatchedContext(browser, guards)
    const guest = await guestContext.newPage()
    await openToPrejoin(guest, link)
    await expect(guest.getByTestId('prejoin')).toContainText('Design review')
    await pressJoin(guest, 'Gus Guest')
    await waitForPhase(guest, 'inCall')
    const guestIdentity = (await callState(guest))!.identity!

    await waitForRemoteFrames(guest, hostIdentity, 5)
    await waitForRemoteFrames(page, guestIdentity, 5)
    expect((await callState(guest))?.safetyCode).toBe((await callState(page))?.safetyCode)

    await leaveCalls(guest, page)
    await guestContext.close()
  })

  test('an instant meeting starts from the dashboard and its host link can be copied', async ({
    page,
    context,
    rooms,
    baseURL,
    browserName,
  }) => {
    const host = await rooms.createUser({ displayName: 'Ivy Instant' })
    await rooms.useIdentity(context, host)
    // Only Chromium lets a test read the clipboard.
    const readClipboard = browserName === 'chromium'
    if (readClipboard) {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin })
    }

    await page.goto('/dashboard')
    await spendJoinBudget(2)
    await page.getByTestId('instant-meeting').click()
    await expect(page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/)
    const slug = new URL(page.url()).pathname.slice(3)
    await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
    await pressJoin(page)
    await waitForPhase(page, 'inCall')

    const dashboard = await context.newPage()
    await dashboard.goto('/dashboard')
    const item = dashboard.getByTestId('room-item').filter({ hasText: slug })
    await expect(item).toContainText('Instant')
    await item.getByTestId('room-copy-link').click()
    if (readClipboard) {
      await expect(dashboard.getByText('Host link copied')).toBeVisible()
      const copied = await dashboard.evaluate(() => navigator.clipboard.readText())
      expect(copied).toMatch(new RegExp(`^${new URL(baseURL!).origin}/m/${slug}#k=[\\w-]{43}$`))
    }
    await dashboard.close()

    await leaveCalls(page)
  })
})
