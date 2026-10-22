import { writeFile } from 'node:fs/promises'
import type { CDPSession, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { callState, inboundVideo, subscriptions, waitForPhase } from '../fixtures/livekit'
import { leaveCalls, newWatchedContext, openToPrejoin, pressJoin } from '../join/support'

/**
 * Network degradation (Stage 10 DoD, docs/PERFORMANCE.md §3.4): a Chromium receiver on the real `/m/<slug>` flow gets
 * a bad network for 60 s through CDP network emulation with the WebRTC fields (5 % packet loss, 150 ms latency,
 * 500 kbit/s each way), applied to its HTTP, its signaling WebSocket and its peer connections.
 *
 * Chromium (153) wraps a WebRTC socket in the emulation only when the socket is created while an emulation rule is
 * active; conditions set later never reach an existing connection, while a wrapped socket follows every later change.
 * So the receiver starts under a neutral rule (100 Mbit/s, no delay, no loss: nothing to throttle at this load) before
 * it connects, and the test switches that rule to the impaired values and back. A global rule (empty `urlPattern`) of
 * `Network.emulateNetworkConditionsByRule` is the documented way to cover peer-to-peer traffic.
 *
 * - Before: the receiver's tile is large (1920×1080, two people), so it receives the camera's top simulcast layer.
 * - Within 20 s of the impairment the received layer or bitrate drops.
 * - For the whole 60 s nothing disconnects: no terminal phase (`left`, `ended`, `removed`, `error`) and no end screen.
 *   A reconnect is reported, not failed.
 * - Within 30 s of lifting the impairment the top layer is back and decoding.
 * - The SFU adapts instead of letting the picture freeze: over the last 30 s of the impairment the receiver decodes a
 *   median of at least 3 frames per second (a lower spatial or temporal layer that fits the link).
 *
 * CDP emulation exists only in Chromium; Firefox and SFU-side impairment use `tc netem` on Linux (TESTING.md §6.9).
 */
const BASELINE_MS = 5_000
const DEGRADED_MS = 60_000
const DROP_WITHIN_MS = 20_000
const RECOVER_WITHIN_MS = 30_000
const SAMPLE_MS = 1_000
/** Bitrate is read over this window. */
const RATE_WINDOW_MS = 3_000

const DEGRADED = {
  offline: false,
  latency: 150,
  // Bytes per second: 500 kbit/s.
  downloadThroughput: 500_000 / 8,
  uploadThroughput: 500_000 / 8,
  packetLoss: 5,
  // A finite queue like a real bottleneck (about 1.6 s at 500 kbit/s): 0 would buffer without limit (decision).
  packetQueueLength: 100,
  packetReordering: false,
}
/** Active but never limiting at this load, so the receiver's sockets are created inside the emulation. */
const NEUTRAL = {
  ...DEGRADED,
  latency: 0,
  downloadThroughput: 100_000_000 / 8,
  uploadThroughput: 100_000_000 / 8,
  packetLoss: 0,
}
const TERMINAL_PHASES = ['left', 'ended', 'removed', 'error']
/** Median decoded frames per second over the last 30 s of the impairment. */
const MIN_ADAPTED_FPS = 3


interface Sample {
  at: number
  phase: string
  frameWidth: number
  bytesReceived: number
  framesDecoded: number
  endScreen: boolean
}

async function sample(page: Page, identity: string): Promise<Sample> {
  const [video] = await inboundVideo(page, identity)
  const state = await callState(page)
  return {
    at: Date.now(),
    phase: state?.phase ?? 'unknown',
    frameWidth: video?.frameWidth ?? 0,
    bytesReceived: video?.bytesReceived ?? 0,
    framesDecoded: video?.framesDecoded ?? 0,
    endScreen: await page.getByTestId('call-end-screen').isVisible(),
  }
}

/** Received kbit/s and decoded frames per second over the window that ends at `samples[index]`. */
function rates(samples: Sample[], index: number): { kbps: number; fps: number } {
  const last = samples[index]!
  const first = samples.find((s) => s.at >= last.at - RATE_WINDOW_MS) ?? last
  if (last.at === first.at) return { kbps: 0, fps: 0 }
  const ms = last.at - first.at
  return {
    kbps: ((last.bytesReceived - first.bytesReceived) * 8) / ms,
    fps: ((last.framesDecoded - first.framesDecoded) * 1000) / ms,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** A global rule (empty pattern) applies to every request and to peer-to-peer (WebRTC) traffic. */
async function emulate(session: CDPSession, conditions: typeof DEGRADED): Promise<void> {
  const { offline, ...rule } = conditions
  await session.send('Network.emulateNetworkConditionsByRule', {
    matchedNetworkConditions: [{ urlPattern: '', offline, ...rule }],
  })
}

test(
  'a receiver on a bad network degrades, stays connected and recovers',
  { tag: '@nightly' },
  async ({ browser, browserName, rooms, guards }, testInfo) => {
    test.skip(browserName !== 'chromium', 'CDP network emulation exists only in Chromium (Firefox: tc netem)')
    test.setTimeout(300_000)

    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Bad network', waitingRoom: false })
    const link = rooms.inviteLink(room, await rooms.createInvite(room, host))

    // The publisher: the host on the real flow, on a normal network.
    const hostContext = await newWatchedContext(browser, guards)
    await rooms.useIdentity(hostContext, host)
    const hostPage = await hostContext.newPage()
    await openToPrejoin(hostPage, room.link)
    await pressJoin(hostPage)
    await waitForPhase(hostPage, 'inCall')
    const hostIdentity = (await callState(hostPage))!.identity!

    // The receiver: a guest with a large window, so the host's tile asks for the top layer.
    const receiverContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    await guards.watch(receiverContext)
    const receiver = await receiverContext.newPage()
    const cdp = await receiverContext.newCDPSession(receiver)
    await cdp.send('Network.enable')
    await emulate(cdp, NEUTRAL)
    await openToPrejoin(receiver, link)
    await pressJoin(receiver, 'Rita Receiver')
    await waitForPhase(receiver, 'inCall')

    const requested = async () =>
      (await subscriptions(receiver, hostIdentity)).find((entry) => entry.source === 'camera')
    await expect.poll(async () => (await requested())?.width ?? 0, { message: 'a large tile' }).toBeGreaterThan(640)
    await expect
      .poll(async () => (await inboundVideo(receiver, hostIdentity))[0]?.frameWidth ?? 0, {
        timeout: 30_000,
        message: 'the top layer (720p camera) arrives',
      })
      .toBeGreaterThan(640)

    const samples: Sample[] = []
    const baselineEnd = Date.now() + BASELINE_MS
    while (Date.now() < baselineEnd) {
      samples.push(await sample(receiver, hostIdentity))
      await receiver.waitForTimeout(SAMPLE_MS)
    }
    const baseline = { width: samples[samples.length - 1]!.frameWidth, ...rates(samples, samples.length - 1) }

    const start = Date.now()
    await emulate(cdp, DEGRADED)
    let dropAt: number | null = null
    try {
      while (Date.now() - start < DEGRADED_MS) {
        const current = await sample(receiver, hostIdentity)
        samples.push(current)
        const t = current.at - start
        const lower = current.frameWidth > 0 && current.frameWidth < baseline.width
        const slower = t >= RATE_WINDOW_MS && rates(samples, samples.length - 1).kbps < baseline.kbps * 0.7
        if (dropAt === null && (lower || slower)) dropAt = t
        expect(TERMINAL_PHASES, `no disconnect at ${t} ms (phase ${current.phase})`).not.toContain(current.phase)
        expect(current.endScreen, `no end screen at ${t} ms`).toBe(false)
        await receiver.waitForTimeout(SAMPLE_MS)
      }
    } finally {
      await emulate(cdp, NEUTRAL)
    }
    const cleared = Date.now()
    const degraded = samples.filter((s) => s.at >= start && s.at < cleared)

    // Recovery: the top layer is back and decoding within 30 s.
    let recoveredAt: number | null = null
    while (Date.now() - cleared < RECOVER_WITHIN_MS + 5_000) {
      await receiver.waitForTimeout(SAMPLE_MS)
      const current = await sample(receiver, hostIdentity)
      samples.push(current)
      expect(TERMINAL_PHASES).not.toContain(current.phase)
      const decoding = current.at - cleared >= RATE_WINDOW_MS && rates(samples, samples.length - 1).fps >= 5
      if (current.frameWidth >= baseline.width && decoding) {
        recoveredAt = current.at - cleared
        break
      }
    }

    const phases = (await callState(receiver))?.phaseHistory ?? []
    const widths = degraded.map((s) => s.frameWidth).filter((w) => w > 0)
    const windows = degraded
      .filter((s) => s.at - start >= RATE_WINDOW_MS)
      .map((s) => rates(samples, samples.indexOf(s)))
    const last30 = degraded.filter((s) => s.at >= cleared - 30_000).map((s) => rates(samples, samples.indexOf(s)))
    const result = {
      baseline: { width: baseline.width, kbps: Math.round(baseline.kbps), fps: Math.round(baseline.fps) },
      dropAfterMs: dropAt,
      degraded: {
        minWidth: widths.length ? Math.min(...widths) : 0,
        lastWidth: degraded[degraded.length - 1]!.frameWidth,
        medianKbps: Math.round(median(windows.map((w) => w.kbps))),
        medianFps: Math.round(median(windows.map((w) => w.fps)) * 10) / 10,
        medianFpsLast30s: Math.round(median(last30.map((w) => w.fps)) * 10) / 10,
      },
      recoveredAfterMs: recoveredAt,
      reconnected: phases.includes('reconnecting'),
      phaseHistory: phases,
    }
    const summary = JSON.stringify(result)
    console.log(`network degradation ${summary}`)
    testInfo.annotations.push({ type: 'degradation', description: summary })
    const details = JSON.stringify(
      { conditions: DEGRADED, result, samples: samples.map(({ at, ...rest }) => ({ t: at - start, ...rest })) },
      null,
      2,
    )
    await writeFile(testInfo.outputPath('degradation-samples.json'), details)
    await testInfo.attach('degradation-samples.json', { body: details, contentType: 'application/json' })

    expect(dropAt, `the layer or bitrate drops within ${DROP_WITHIN_MS / 1000} s`).not.toBeNull()
    expect(dropAt!).toBeLessThanOrEqual(DROP_WITHIN_MS)
    expect(recoveredAt, `the top layer returns within ${RECOVER_WITHIN_MS / 1000} s`).not.toBeNull()
    expect(recoveredAt!).toBeLessThanOrEqual(RECOVER_WITHIN_MS)

    await leaveCalls(receiver, hostPage)
    await receiverContext.close()
    await hostContext.close()

    // F-065: the freeze measured on the macOS host (median 0 fps) does not happen in the Docker runner or on Linux.
    expect(result.degraded.medianFpsLast30s, 'the SFU adapts and the video keeps moving').toBeGreaterThanOrEqual(
      MIN_ADAPTED_FPS,
    )
  },
)
