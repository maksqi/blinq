import type { CDPSession, Page } from '@playwright/test'
import { test as collabTest, type CallPeer } from '../collab/helpers'
import { expect } from '../fixtures'
import { waitForPhase, waitForRemoteFrames } from '../fixtures/livekit'
import { pressJoin, spendJoinBudget } from '../join/support'
import { dashboardWithRoom, joinLink } from './support'

// F-037 (quality review): joining and leaving a meeting in one tab must not grow the heap. Each cycle is the real
// flow, /dashboard -> Join -> /m/<slug> pre-join -> Join -> in the call with a live peer -> Leave -> back, all
// client-side navigation in the same document. Before the fixes every cycle kept the whole call alive (about 1.3 MB):
// livekit-client's devicechange listener held every Room, and @tanstack/vue-form's devtools listeners held each
// RenameDialog and with it the CallSession. Chromium only (CDP heap usage after a forced GC).

const CYCLES = 16
/**
 * Cycles before the first measurement: lazy chunks, the E2EE worker, caches, optimized code and the resource-timing
 * buffer (250 entries, full after about 6 cycles) settle first. In the Docker runner the heap still grows by about
 * 300 KB per cycle for the first 8 cycles, then by 50-90 KB (22-cycle probe: 12.3 MB after cycle 1, 14.9 after cycle 8,
 * 15.6 after cycle 19), so measuring from cycle 2 failed the limit without a leak.
 */
const WARM_UP = 9
/** Average growth allowed per measured cycle (decision): a leaked call costs well over 1 MB. */
const MAX_GROWTH_PER_CYCLE = 250 * 1024

async function usedHeap(cdp: CDPSession, page: Page): Promise<number> {
  // FinalizationRegistry callbacks and WeakRef targets need a few GC passes and turns of the event loop.
  for (let pass = 0; pass < 3; pass++) {
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(150)
  }
  const { usedSize } = await cdp.send('Runtime.getHeapUsage')
  return usedSize
}

async function leave(page: Page): Promise<void> {
  await page.locator('button[data-control="leave"]').click()
  await waitForPhase(page, 'left')
}

const test = collabTest

test.describe('resource hygiene', () => {
  test('the heap stays flat over join and leave cycles in one tab', async ({ page, context, rooms, collab }, info) => {
    test.skip(info.project.name !== 'chromium', 'CDP heap usage is Chromium only')
    test.setTimeout(420_000)

    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Heap check', waitingRoom: false })
    // The live peer publishes camera and microphone the whole time (the fixture's host user creates its invite).
    const peer = await collab.addUser(room, { user: host } as unknown as CallPeer, { name: 'Pia Peer' })
    await rooms.useIdentity(context, host)
    await dashboardWithRoom(page, host, room)

    const cdp = await context.newCDPSession(page)
    await cdp.send('HeapProfiler.enable')
    const samples: number[] = []

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      await spendJoinBudget(2)
      await joinLink(page, room).click()
      await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
      await pressJoin(page)
      await waitForPhase(page, 'inCall')
      await waitForRemoteFrames(page, peer.identity, 5)
      await leave(page)
      // Back to the dashboard inside the same document (no reload frees anything).
      await page.evaluate(() => history.back())
      await expect(page).toHaveURL(/\/dashboard$/)
      await expect(joinLink(page, room)).toBeVisible()
      if (cycle + 1 >= WARM_UP) samples.push(await usedHeap(cdp, page))
    }

    const growth = samples.at(-1)! - samples[0]!
    const perCycle = growth / (samples.length - 1)
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)
    info.annotations.push({
      type: 'heap',
      description: `${samples.map(mb).join(' -> ')} MB; ${(perCycle / 1024).toFixed(0)} KB per cycle`,
    })
    console.log(`heap after each cycle (MB): ${samples.map(mb).join(', ')}; per cycle ${(perCycle / 1024).toFixed(0)} KB`)
    expect(perCycle, 'average heap growth per join/leave cycle').toBeLessThan(MAX_GROWTH_PER_CYCLE)
  })
})
