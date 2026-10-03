import { expect, test } from '../fixtures'
import { joinMetrics } from '../fixtures/flows'
import { callState, waitForRemoteFrames } from '../fixtures/livekit'
import { pressJoin } from './support'

// DoD: a guest joins via an invite within the join-time budget. Join time = Join click → first decoded remote frame
// through the real flow (POST /api/join, connect), with the host already publishing (docs/TESTING.md §6.7). Host and
// guest both use the real meeting page.
// Local: printed and attached. PR gate (CI): < 6 s. Nightly: < 3 s for this single sample (call/join-time takes the
// nightly percentiles).
const CLICK = 'blinq:join:click'
const FRAME = 'blinq:join:first-remote-frame'

test.describe('guest with an invite link', () => {
  test('joins through /m/<slug> and sees the host', async ({ flows, rooms }, testInfo) => {
    // The host is already in the call and publishing.
    const { host, room } = await flows.meeting({ name: 'Open house', waitingRoom: false }, { hostName: 'Hana Host' })

    const guest = await flows.openAsGuest(await flows.inviteLink(room), { name: 'Gus Guest' })
    await expect(guest.page.getByTestId('prejoin')).toContainText('Open house')
    await expect(guest.page.getByTestId('prejoin-preview')).toBeVisible({ timeout: 20_000 })
    await pressJoin(guest.page, 'Gus Guest')

    await expect
      .poll(async () => (await joinMetrics(guest.page))[FRAME] ?? 0, {
        timeout: 20_000,
        message: 'first remote frame',
      })
      .toBeGreaterThan(0)
    const marks = await joinMetrics(guest.page)
    const joinMs = marks[FRAME]! - marks[CLICK]!
    expect(joinMs).toBeGreaterThan(0)
    const summary = `guest invite join time ${Math.round(joinMs)} ms`
    console.log(summary)
    testInfo.annotations.push({ type: 'join-time', description: summary })
    await testInfo.attach('guest-invite-join-time.json', {
      body: JSON.stringify({ joinMs }, null, 2),
      contentType: 'application/json',
    })
    if (process.env.E2E_NIGHTLY === '1') expect(joinMs).toBeLessThan(3_000)
    else if (process.env.CI) expect(joinMs).toBeLessThan(6_000)

    await flows.waitForCall(guest)
    const guestState = await callState(guest.page)
    expect(guestState?.e2eeEnabled).toBe(true)
    await waitForRemoteFrames(host.page, guest.identity!, 5)
    // The guest reached the call as a participant of a real join row.
    const participants = await rooms.callApi(host.account, room, 'GET', '/participants')
    expect(participants.status).toBe(200)
    expect((participants.body as { items: Array<{ identity: string; kind: string }> }).items).toContainEqual(
      expect.objectContaining({ identity: guest.identity, kind: 'guest' }),
    )
  })
})
