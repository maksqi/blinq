import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { joinMetrics } from '../fixtures/flows'
import { waitForRemoteFrames } from '../fixtures/livekit'
import { pressJoin, spendJoinBudget } from '../join/support'

// Join time = blinq:join:click → blinq:join:first-remote-frame through the real flow (Join on `/m/<slug>`, the join
// request, connect), with the host already publishing (docs/TESTING.md §6.7).
// Local: printed and attached only. PR gate (CI): < 6 s. Nightly (E2E_NIGHTLY=1): one discarded warm-up, then 10 warm
// joins of the same guest in the same live room (page reloaded each time); p50 < 1.5 s and p95 < 3 s, both by nearest
// rank (for 10 samples: the 5th and the slowest join).
const CLICK = 'blinq:join:click'
const FRAME = 'blinq:join:first-remote-frame'
const nightly = process.env.E2E_NIGHTLY === '1'
const WARM_JOINS = 10

function nearestRank(sorted: number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!
}

async function measure(page: Page, guestName: string): Promise<number> {
  await expect(page.getByTestId('prejoin-preview')).toBeVisible({ timeout: 20_000 })
  await pressJoin(page, guestName)
  await expect
    .poll(async () => (await joinMetrics(page))[FRAME] ?? 0, { timeout: 20_000, message: 'first remote frame' })
    .toBeGreaterThan(0)
  const marks = await joinMetrics(page)
  const click = marks[CLICK]
  const frame = marks[FRAME]
  expect(click).toBeGreaterThan(0)
  expect(frame).toBeGreaterThan(click!)
  return frame! - click!
}

test.describe('join time', () => {
  test('click to first remote frame', async ({ flows, guards }, testInfo) => {
    test.setTimeout(nightly ? 300_000 : 60_000)
    // Rejoining with the same identity ten times in a row races the SFU: the SDK may log a track that arrives before
    // the (new) participant is known. Only the nightly loop does that.
    if (nightly) guards.allowConsoleError(/Tried to add a track for a participant, that's not present/)
    const { host, room } = await flows.meeting({ name: 'Join time' }, { hostName: 'Hana Host' })
    const guest = await flows.openAsGuest(await flows.inviteLink(room), { name: 'Gus Guest' })

    const samples: number[] = []
    samples.push(await measure(guest.page, guest.name))
    await flows.waitForCall(guest)
    await waitForRemoteFrames(host.page, guest.identity!, 5)

    if (nightly) {
      samples.length = 0 // the first join was the warm-up
      for (let i = 0; i < WARM_JOINS; i++) {
        // Leave gracefully, then reload: the tab keeps the key and the invite, so the page comes back to pre-join.
        await flows.leave(guest)
        await expect(guest.page.getByTestId('call-end-screen')).toHaveAttribute('data-phase', 'left')
        await spendJoinBudget(2)
        await guest.page.reload()
        samples.push(await measure(guest.page, guest.name))
        await flows.waitForCall(guest)
      }
    }

    const sorted = [...samples].sort((a, b) => a - b)
    const p50 = nearestRank(sorted, 0.5)
    const p95 = nearestRank(sorted, 0.95)
    const summary =
      `join time ${samples.map((ms) => `${Math.round(ms)} ms`).join(', ')} ` +
      `(p50 ${Math.round(p50)} ms, p95 ${Math.round(p95)} ms)`
    console.log(summary)
    testInfo.annotations.push({ type: 'join-time', description: summary })
    await testInfo.attach('join-time.json', {
      body: JSON.stringify({ samples, p50, p95 }, null, 2),
      contentType: 'application/json',
    })

    if (nightly) {
      expect(p50, 'join time p50').toBeLessThan(1_500)
      expect(p95, 'join time p95').toBeLessThan(3_000)
    } else if (process.env.CI) {
      expect(samples[0], 'join time on the PR gate').toBeLessThan(6_000)
    }
  })
})
