import { expect, test } from '../fixtures'
import { startRecording, stopRecording } from '../fixtures/recording'
import { callState } from '../fixtures/livekit'

// Pre-join on the real meeting page: the guest name (displayNameSchema), the recording notice of a meeting that is
// being recorded, and the room's mute-on-join rule.
test.describe('pre-join', () => {
  test('asks guests for a valid name before joining', async ({ flows }) => {
    await flows.loginAs('host', { name: 'Hana Host' })
    const room = await flows.createRoom({ name: 'Name check', waitingRoom: false })
    const guest = await flows.openAsGuest(await flows.inviteLink(room))
    const { page } = guest
    const name = page.getByLabel('Your name')
    await expect(name).toHaveValue('')

    await page.getByTestId('join-button').click()
    await expect(page.getByText('Enter a name')).toBeVisible()
    await name.fill('   ')
    await name.press('Enter')
    await expect(page.getByText('Enter a name')).toBeVisible()
    await expect(page.getByTestId('prejoin')).toBeVisible()

    // A bidi override is stripped by the shared normalization; the rest is a valid name.
    await name.fill('Gwen \u202EGuest')
    await page.getByTestId('join-button').click()
    await flows.waitForCall(guest)
    // The name the guest has in the call (the LiveKit name the server set) is the normalized one.
    await expect
      .poll(async () => (await callState(page))?.participants.find((p) => p.identity === guest.identity))
      .toMatchObject({ isLocal: true, name: 'Gwen Guest' })
  })

  test('shows the recording notice and joins muted when the room says so', async ({ flows }) => {
    test.setTimeout(90_000)
    const { host, room } = await flows.meeting({ name: 'Recorded meeting', muteOnJoin: true }, { hostName: 'Hana Host' })
    await startRecording(host.page, 'server')

    const guest = await flows.openAsGuest(await flows.inviteLink(room), { name: 'Gus Guest' })
    const { page } = guest
    await expect(page.getByTestId('prejoin-recording')).toContainText('This meeting is being recorded')
    const mic = page.getByRole('button', { name: 'Microphone', exact: true })
    const camera = page.getByRole('button', { name: 'Camera', exact: true })
    await expect(mic).toHaveAttribute('aria-pressed', 'false')
    await expect(mic).toHaveAttribute('aria-disabled', 'true')
    await expect(camera).toHaveAttribute('aria-pressed', 'false')
    await expect(camera).toHaveAttribute('aria-disabled', 'true')

    await flows.enterCall(guest)
    const seenByHost = async () => (await callState(host.page))?.participants.find((p) => p.identity === guest.identity)
    await expect.poll(async () => (await seenByHost())?.micEnabled).toBe(false)
    await expect.poll(async () => (await seenByHost())?.cameraEnabled).toBe(false)

    // Muting on join applies to the join only: the guest can unmute afterwards.
    await page.getByRole('button', { name: 'Microphone', exact: true }).click()
    await expect.poll(async () => (await seenByHost())?.micEnabled).toBe(true)
    await page.getByRole('button', { name: 'Camera', exact: true }).click()
    await expect.poll(async () => (await seenByHost())?.cameraEnabled).toBe(true)

    await stopRecording(host.page)
  })
})
