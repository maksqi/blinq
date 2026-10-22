import { writeFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { newWatchedContext, openToPrejoin } from '../join/support'

/**
 * Performance budget (Stage 10, docs/PERFORMANCE.md §7): compressed JavaScript a cold browser downloads to render a
 * page, summed from Resource Timing `encodedBodySize` over the page's `.js` resources. The e2e Caddy compresses like
 * production (zstd, gzip), so these are the bytes a real visitor transfers.
 *
 * - `/` and `/login`: initial JS ≤ 200 KB.
 * - `/m/<slug>` up to the pre-join screen of a guest with an invite link: ≤ 450 KB without MediaPipe, RNNoise and the
 *   E2EE worker. A fresh browser has blur off and browser noise suppression on, so MediaPipe and RNNoise do not load at
 *   all; the E2EE worker does (the room is created when pre-join mounts) and is reported but not counted.
 * - Speculative prefetches (`<link rel="prefetch">`, requests with `Sec-Purpose: prefetch`) are not needed to render
 *   the page and are reported but not counted (decision).
 * - KB means 1024 bytes here, like the quality review's KiB figures (decision).
 * - A new browser context has an empty HTTP cache, so every file is a network transfer. Chromium lists a preloaded file
 *   twice (the `link` preload and the `script` that runs it, served from the HTTP cache), so each file counts once.
 *
 * One engine is enough to measure bytes (Chromium; Firefox negotiates the same encodings).
 */
const KB = 1024
const BUDGET = { initial: 200 * KB, prejoin: 450 * KB }

/** Scripts that never count against the pre-join budget (loaded only for effects, or the frame-cryptor worker). */
const EXCLUDED = [
  { label: 'E2EE worker', pattern: /e2ee[.-]worker/ },
  { label: 'MediaPipe', pattern: /\/vendor\/mediapipe\/|mediapipe|tasks-vision/ },
  { label: 'RNNoise', pattern: /\/vendor\/rnnoise\/|rnnoise|noise-suppressor/ },
]

const isScript = (url: string) => /\.m?js$/.test(new URL(url).pathname)

interface ScriptResource {
  path: string
  encoded: number
  decoded: number
  initiator: string
  /** ms since navigation start. */
  start: number
  encoding: string
  /** Every request for this file was a speculative prefetch. */
  prefetch: boolean
}

interface Measurement {
  page: string
  counted: ScriptResource[]
  excluded: Array<ScriptResource & { reason: string }>
  /** The budget metric: counted scripts. */
  totalBytes: number
  /** Everything, prefetches included (for the record). */
  allBytes: number
  /** Counted scripts that started before the load event ended (for the record). */
  beforeLoadBytes: number
  loadEventEnd: number
  html: number
}

interface RequestLog {
  purposes: Map<string, string[]>
  encodings: Map<string, string>
}

/** Records, per script path, whether its requests were prefetches and which content-encoding came back. */
function trackScripts(page: Page): RequestLog {
  const log: RequestLog = { purposes: new Map(), encodings: new Map() }
  page.on('request', (request) => {
    if (!isScript(request.url())) return
    const path = new URL(request.url()).pathname
    void request.allHeaders().then((headers) => {
      log.purposes.set(path, [...(log.purposes.get(path) ?? []), headers['sec-purpose'] ?? headers.purpose ?? ''])
    })
  })
  page.on('response', (response) => {
    if (!isScript(response.url())) return
    const path = new URL(response.url()).pathname
    void response.headerValue('content-encoding').then((value) => log.encodings.set(path, value ?? 'identity'))
  })
  return log
}

async function measure(page: Page, label: string, log: RequestLog): Promise<Measurement> {
  // Late lazy chunks (hydration, idle work) belong to the page as well.
  await page.waitForLoadState('networkidle')
  const { entries, html, loadEventEnd } = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return {
      entries: performance
        .getEntriesByType('resource')
        .map((entry) => entry as PerformanceResourceTiming)
        .map((entry) => ({
          url: entry.name,
          encoded: entry.encodedBodySize,
          decoded: entry.decodedBodySize,
          initiator: entry.initiatorType,
          start: Math.round(entry.startTime),
        })),
      html: navigation?.encodedBodySize ?? 0,
      loadEventEnd: Math.round(navigation?.loadEventEnd ?? 0),
    }
  })
  const byPath = new Map<string, ScriptResource>()
  for (const { url, ...entry } of entries.filter((entry) => isScript(entry.url))) {
    const path = new URL(url).pathname
    const seen = byPath.get(path)
    if (seen) {
      // Entries come in start order: keep the first start and the largest size of the same file.
      seen.encoded = Math.max(seen.encoded, entry.encoded)
      seen.decoded = Math.max(seen.decoded, entry.decoded)
      continue
    }
    const purposes = log.purposes.get(path) ?? []
    byPath.set(path, {
      path,
      ...entry,
      encoding: log.encodings.get(path) ?? 'unknown',
      prefetch: purposes.length > 0 && purposes.every((purpose) => purpose.includes('prefetch')),
    })
  }
  const scripts = [...byPath.values()]
  const counted: ScriptResource[] = []
  const excluded: Measurement['excluded'] = []
  for (const script of scripts) {
    const reason = script.prefetch ? 'prefetch' : EXCLUDED.find(({ pattern }) => pattern.test(script.path))?.label
    if (reason) excluded.push({ ...script, reason })
    else counted.push(script)
  }
  // A resource with no transfer size would mean a cached or opaque response, which would hide bytes.
  for (const script of counted) expect(script.encoded, `${script.path} has a transfer size`).toBeGreaterThan(0)
  const sum = (list: ScriptResource[]) => list.reduce((total, script) => total + script.encoded, 0)
  return {
    page: label,
    counted,
    excluded,
    totalBytes: sum(counted),
    allBytes: sum(scripts),
    beforeLoadBytes: sum(counted.filter((script) => script.start < loadEventEnd)),
    loadEventEnd,
    html,
  }
}

const kib = (bytes: number) => Math.round((bytes / KB) * 10) / 10

async function report(measurement: Measurement, budget: number): Promise<void> {
  const info = test.info()
  const encodings = [...new Set(measurement.counted.map((script) => script.encoding))].sort()
  const largest = [...measurement.counted]
    .sort((a, b) => b.encoded - a.encoded)
    .slice(0, 5)
    .map((script) => `${script.path} ${kib(script.encoded)}`)
  const excluded = new Map<string, number>()
  for (const script of measurement.excluded)
    excluded.set(script.reason, (excluded.get(script.reason) ?? 0) + script.encoded)
  const summary =
    `${measurement.page}: ${kib(measurement.totalBytes)} KiB compressed JS in ${measurement.counted.length} files ` +
    `(budget ${kib(budget)} KiB; ${encodings.join('/')}; started before load ${kib(measurement.beforeLoadBytes)} KiB; ` +
    `with everything ${kib(measurement.allBytes)} KiB; HTML ${kib(measurement.html)} KiB)` +
    (excluded.size
      ? `; not counted: ${[...excluded].map(([why, bytes]) => `${why} ${kib(bytes)} KiB`).join(', ')}`
      : '') +
    `; largest (KiB): ${largest.join(', ')}`
  console.log(`perf budget ${summary}`)
  info.annotations.push({ type: 'js-budget', description: summary })
  const details = JSON.stringify({ budgetBytes: budget, ...measurement }, null, 2)
  await writeFile(info.outputPath('js-budget.json'), details)
  await info.attach('js-budget.json', { body: details, contentType: 'application/json' })
}

function enforce(measurement: Measurement, budget: number): void {
  expect(measurement.totalBytes, `${measurement.page}: compressed JS within ${kib(budget)} KiB`).toBeLessThanOrEqual(
    budget,
  )
}

test.describe('performance budget', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'bytes are measured once, in Chromium')
  })

  for (const path of ['/', '/login']) {
    test(`initial JS of ${path}`, async ({ browser, guards }) => {
      const context = await newWatchedContext(browser, guards)
      const page = await context.newPage()
      const log = trackScripts(page)
      await page.goto(path)
      await expect(page.locator('main').first()).toBeVisible()
      const measurement = await measure(page, path, log)
      await report(measurement, BUDGET.initial)
      await context.close()
      enforce(measurement, BUDGET.initial)
    })
  }

  test('call route JS up to the pre-join screen', async ({ browser, guards, rooms }) => {
    const host = await rooms.createUser({ displayName: 'Hana Host' })
    const room = await rooms.createRoom(host, { name: 'Budget room', waitingRoom: false })
    const link = rooms.inviteLink(room, await rooms.createInvite(room, host))

    const context = await newWatchedContext(browser, guards)
    const page = await context.newPage()
    const log = trackScripts(page)
    await openToPrejoin(page, link)
    await expect(page.getByTestId('prejoin-preview')).toBeVisible({ timeout: 20_000 })
    const measurement = await measure(page, '/m/<slug>', log)
    await report(measurement, BUDGET.prejoin)
    await context.close()
    enforce(measurement, BUDGET.prejoin)
  })
})
