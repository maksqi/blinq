/**
 * Recording fixtures (owner: recording-client, Stage 08, docs/TESTING.md §6.8).
 *
 * Recording start needs a real `call_participants` row, so every peer joins through the DB-backed `rooms` fixture
 * (join.ts) and opens the call harness with its own session or guest cookie:
 *
 *   test('records', async ({ recordingCall }) => {
 *     const { room, host } = await recordingCall.open()                  // host user, room, host in the test's page
 *     const peer = await recordingCall.join(room, host, { name: 'Pat' })  // a user with an invite, own context
 *     const id = await startRecording(host.page, 'server')
 *     …
 *     await stopRecording(host.page)
 *     await waitForRecording(host.account, id, ['ready'])
 *   })
 *
 * Helpers: forced MIME (`forceRecordingMime` hook), start/stop through the UI, the `state.recording` hook, API reads
 * with the recorder's session, downloads, ffprobe / volumedetect / freezedetect, and chunk-failure injection.
 * Teardown leaves every call gracefully and closes the extra contexts.
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { expect } from './base'
import {
  test as roomsTest,
  type E2eGuest,
  type E2eRoom,
  type E2eUser,
  type JoinResult,
  type RoomSettingsInput,
} from './join'
import { waitForPhase } from './livekit'

export type RecordingMode = 'server' | 'local'

export interface RecordingHookState {
  recordingId: string | null
  mime: string | null
  chunksProduced: number
  chunksAcked: number
  retries: number
  phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'finishing'
  mode: RecordingMode | null
  error: string | null
  backlogBytes: number
  startedAt: number | null
}

export interface CallMember {
  name: string
  page: Page
  context: BrowserContext
  join: JoinResult
  identity: string
}

export interface HostMember extends CallMember {
  account: E2eUser
}

export interface OpenOptions {
  hostName?: string
  /** Room settings (default: no waiting room, guests allowed). */
  settings?: Partial<RoomSettingsInput>
  /** Extra harness fragment parameters, e.g. `{ mic: '0' }`. */
  params?: Record<string, string>
}

export interface JoinPeerOptions {
  /** A display name for a new user, or the guest name with `guest: true`. */
  name?: string
  guest?: boolean
  /** An existing user (for example a co-host added with `rooms.addCohost`). */
  user?: E2eUser
  /** Co-hosts and the owner join without an invite. */
  invite?: boolean
  browser?: Browser
  params?: Record<string, string>
}

export interface RecordingCallFixture {
  open(options?: OpenOptions): Promise<{ room: E2eRoom; host: HostMember }>
  join(room: E2eRoom, host: E2eUser, options?: JoinPeerOptions): Promise<CallMember & { account?: E2eUser }>
}

// ---- Browser-side helpers -------------------------------------------------------------------------------------------

export async function recordingState(page: Page): Promise<RecordingHookState | undefined> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __blinqTest?: { state: Record<string, unknown> } }).__blinqTest
    const value = hooks?.state.recording
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as RecordingHookState)
  })
}

/** `forceRecordingMime('video/webm' | 'video/mp4' | null)` through the test hook. */
export async function forceRecordingMime(page: Page, mime: string | null): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          typeof (window as unknown as { __blinqTest?: { forceRecordingMime?: unknown } }).__blinqTest
            ?.forceRecordingMime === 'function',
      ),
    )
    .toBe(true)
  await page.evaluate((value) => {
    ;(
      window as unknown as { __blinqTest: { forceRecordingMime: (mime: string | null) => void } }
    ).__blinqTest.forceRecordingMime(value)
  }, mime)
}

/** Whether MediaRecorder in this page can record any candidate of a family (`video/mp4`, `video/webm`). */
export async function canRecordFamily(page: Page, family: string): Promise<boolean> {
  return page.evaluate((prefix) => {
    const candidates = [
      'video/mp4;codecs=avc1.64001F,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
      'video/mp4;codecs=avc1.64001F,opus',
      'video/mp4;codecs=avc1,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    return candidates.some((mime) => mime.startsWith(prefix) && MediaRecorder.isTypeSupported(mime))
  }, family)
}

/** Clicks Record, picks the mode and waits until MediaRecorder runs. Returns the recording id. */
export async function startRecording(page: Page, mode: RecordingMode = 'server'): Promise<string> {
  await page.getByTestId('record-button').click()
  const dialog = page.getByTestId('start-recording-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId(`recording-mode-${mode}`).click()
  await dialog.getByTestId('start-recording').click()
  await expect
    .poll(async () => (await recordingState(page))?.phase, { message: 'recording starts', timeout: 15_000 })
    .toBe('recording')
  const state = await recordingState(page)
  expect(state?.recordingId).toBeTruthy()
  return state!.recordingId!
}

/** Clicks Stop and waits until the recorder is idle again (chunks uploaded and completed, or the file saved). */
export async function stopRecording(page: Page, timeout = 60_000): Promise<RecordingHookState> {
  await expect(page.getByTestId('record-button')).toHaveAttribute('data-state', 'recording')
  await page.getByTestId('record-button').click()
  return waitForRecorderIdle(page, timeout)
}

export async function waitForRecorderIdle(page: Page, timeout = 60_000): Promise<RecordingHookState> {
  await expect.poll(async () => (await recordingState(page))?.phase, { message: 'recorder idle', timeout }).toBe('idle')
  return (await recordingState(page))!
}

/** Leaves the harness call gracefully (tearing down a live connection makes Firefox log data-channel errors). */
export async function leaveCall(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const hooks = (window as unknown as { __blinqTest?: { state: { harness?: { leave?: () => Promise<void> } } } })
        .__blinqTest
      await hooks?.state.harness?.leave?.()
    })
    .catch(() => undefined)
}

export interface ChunkFailurePlan {
  /** Abort every n-th chunk attempt (network error). */
  abortEvery?: number
  /** Attempts (1-based) answered with 503 instead. */
  serviceUnavailable?: number[]
}

/** Injects failures into chunk uploads with `page.route`; returns live counters. */
export async function injectChunkFailures(
  page: Page,
  plan: ChunkFailurePlan,
): Promise<{ attempts: number; aborted: number; failed: number }> {
  const stats = { attempts: 0, aborted: 0, failed: 0 }
  await page.route('**/api/recordings/*/chunks/*', async (route) => {
    stats.attempts++
    const attempt = stats.attempts
    if (plan.serviceUnavailable?.includes(attempt)) {
      stats.failed++
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          statusCode: 503,
          statusMessage: 'Service unavailable',
          data: { code: 'SERVICE_UNAVAILABLE' },
        }),
      })
      return
    }
    if (plan.abortEvery && attempt % plan.abortEvery === 0) {
      stats.aborted++
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  return stats
}

/**
 * Background-tab emulation for the page's main thread (install before navigating). Playwright keeps every page
 * visible (focus emulation; headless windows never occlude), so a real background tab cannot be produced in CI. While
 * `setBackground(page, true)`: `document.visibilityState` is `hidden` (with `visibilitychange`), requestAnimationFrame
 * stops, and main-thread timers fire at most once per second, as Chrome throttles a hidden tab. Workers are untouched,
 * like in a real background tab.
 */
export async function emulateBackgroundTab(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Window & { __blinqBackground?: { set(hidden: boolean): void } }
    let hidden = false
    const pendingFrames: FrameRequestCallback[] = []
    const realRaf = window.requestAnimationFrame.bind(window)
    const realSetTimeout = window.setTimeout.bind(window)
    const realSetInterval = window.setInterval.bind(window)
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    })
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden })
    window.requestAnimationFrame = (callback) => {
      if (!hidden) return realRaf(callback)
      pendingFrames.push(callback)
      return 0
    }
    window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
      realSetTimeout(handler, hidden ? Math.max(Number(ms) || 0, 1000) : ms, ...args)) as typeof window.setTimeout
    window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      let last = 0
      return realSetInterval(
        (...callArgs: unknown[]) => {
          if (hidden) {
            const now = performance.now()
            if (now - last < 1000) return
            last = now
          }
          if (typeof handler === 'function') (handler as (...a: unknown[]) => void)(...callArgs)
        },
        ms,
        ...args,
      )
    }) as typeof window.setInterval
    w.__blinqBackground = {
      set(next: boolean) {
        hidden = next
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event(next ? 'blur' : 'focus'))
        if (!next) for (const callback of pendingFrames.splice(0)) realRaf(callback)
      },
    }
  })
}

export async function setBackground(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    ;(window as unknown as { __blinqBackground: { set(hidden: boolean): void } }).__blinqBackground.set(value)
  }, hidden)
}

/** Frames the compositor drew so far (test builds publish it with `state.recording`). */
export async function framesDrawn(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      ((window as unknown as { __blinqTest?: { state: { recording?: { framesDrawn?: number } } } }).__blinqTest?.state
        .recording?.framesDrawn ?? 0) as number,
  )
}

// ---- Server-side helpers (the recorder's session) -------------------------------------------------------------------

function publicOrigin(): string {
  return new URL(process.env.PUBLIC_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin
}

function apiOrigin(): string {
  const port = process.env.E2E_APP_PORT
  return port ? `http://127.0.0.1:${port}` : publicOrigin()
}

export interface RecordingSummaryData {
  id: string
  mode: RecordingMode
  status: 'recording' | 'processing' | 'ready' | 'failed'
  partial: boolean
  durationMs: number | null
  sizeBytes: number | null
}

export async function getRecording(user: E2eUser, id: string): Promise<RecordingSummaryData | null> {
  const res = await fetch(new URL(`/api/recordings/${id}`, apiOrigin()), {
    headers: {
      accept: 'application/json',
      cookie: `${user.cookie.name}=${user.cookie.value}`,
      'x-forwarded-for': user.ip,
    },
  })
  if (res.status !== 200) return null
  return ((await res.json()) as { recording: RecordingSummaryData }).recording
}

/** Polls `GET /api/recordings/:id` until the status is one of `statuses` (fails fast on `failed` unless expected). */
export async function waitForRecording(
  user: E2eUser,
  id: string,
  statuses: RecordingSummaryData['status'][],
  timeout = 90_000,
): Promise<RecordingSummaryData> {
  const seen: { last: RecordingSummaryData | null } = { last: null }
  await expect
    .poll(
      async () => {
        const last = await getRecording(user, id)
        seen.last = last
        if (last?.status === 'failed' && !statuses.includes('failed'))
          throw new Error('the recording failed processing')
        return last ? statuses.includes(last.status) : false
      },
      { timeout, intervals: [500, 1000, 1000, 2000], message: `recording ${id} reaches ${statuses.join('/')}` },
    )
    .toBe(true)
  return seen.last!
}

/** Downloads the processed MP4 (`?download=1`) with the user's session. */
export async function downloadRecording(user: E2eUser, id: string, path: string): Promise<void> {
  const res = await fetch(new URL(`/api/recordings/${id}/file?download=1`, apiOrigin()), {
    headers: { cookie: `${user.cookie.name}=${user.cookie.value}`, 'x-forwarded-for': user.ip },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('video/mp4')
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
}

// ---- Media checks (ffmpeg / ffprobe from PATH) ------------------------------------------------------------------------

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()))
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export interface ProbeResult {
  formatName: string
  durationSec: number | null
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>
}

export async function probe(path: string): Promise<ProbeResult> {
  const result = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=format_name,duration:stream=codec_type,codec_name,width,height',
    '-of',
    'json',
    path,
  ])
  if (result.code !== 0) throw new Error(`ffprobe rejected ${path}: ${result.stderr}`)
  const json = JSON.parse(result.stdout) as {
    format?: { format_name?: string; duration?: string }
    streams?: ProbeResult['streams']
  }
  const duration = Number(json.format?.duration)
  return {
    formatName: json.format?.format_name ?? '',
    durationSec: Number.isFinite(duration) ? duration : null,
    streams: json.streams ?? [],
  }
}

/** `ffmpeg -af volumedetect`: mean and max volume in dB (digital silence reads about -91 dB). */
export async function volume(path: string): Promise<{ meanDb: number; maxDb: number }> {
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ])
  const mean = result.stderr.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/)
  const max = result.stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/)
  const parse = (value: string | undefined) => (value === undefined || value === '-inf' ? -Infinity : Number(value))
  return { meanDb: parse(mean?.[1]), maxDb: parse(max?.[1]) }
}

/** Frozen stretches (`freezedetect`, at least `minSeconds` without change) in the video, as durations in seconds. */
export async function freezes(path: string, minSeconds = 2): Promise<number[]> {
  const result = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-vf',
    `freezedetect=n=-60dB:d=${minSeconds}`,
    '-f',
    'null',
    '-',
  ])
  return [...result.stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((match) => Number(match[1]))
}

// ---- Fixture ---------------------------------------------------------------------------------------------------------

export const test = roomsTest.extend<{ recordingCall: RecordingCallFixture }>({
  recordingCall: async ({ rooms, page, browser, guards }, use) => {
    const contexts: BrowserContext[] = []
    const pages: Page[] = []

    async function enter(
      target: Page,
      room: E2eRoom,
      who: E2eUser | E2eGuest,
      name: string,
      inviteToken: string | undefined,
      params: Record<string, string> = {},
    ): Promise<CallMember> {
      const join = await rooms.join(room, who, inviteToken ? { inviteToken } : {})
      const grant = await rooms.waitForAdmission(join)
      await rooms.useIdentity(target.context(), 'id' in who ? who : join)
      const extra = new URLSearchParams(params).toString()
      await target.goto(`${rooms.harnessPath(room, grant, name)}${extra ? `&${extra}` : ''}`)
      await expect(target.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
      await target.getByTestId('join-button').click()
      await waitForPhase(target, 'inCall')
      pages.push(target)
      return { name, page: target, context: target.context(), join, identity: grant.identity }
    }

    async function newPage(engine?: Browser): Promise<Page> {
      const context = await (engine ?? browser).newContext({ viewport: { width: 1280, height: 720 } })
      contexts.push(context)
      await guards.watch(context)
      return context.newPage()
    }

    await use({
      async open(options = {}) {
        const hostName = options.hostName ?? 'Hana Host'
        const account = await rooms.createUser({ displayName: hostName })
        const room = await rooms.createRoom(account, { waitingRoom: false, allowGuests: true, ...options.settings })
        const member = await enter(page, room, account, hostName, undefined, options.params)
        return { room, host: { ...member, account } }
      },
      async join(room, host, options = {}) {
        const target = await newPage(options.browser)
        const name = options.name ?? (options.guest ? 'Gus Guest' : 'Pat Participant')
        const invite = options.invite === false ? undefined : await rooms.createInvite(room, host)
        if (options.guest) return enter(target, room, { guest: name }, name, invite, options.params)
        const account = options.user ?? (await rooms.createUser({ displayName: name }))
        const member = await enter(target, room, account, name, invite, options.params)
        return { ...member, account }
      },
    })

    for (const joined of pages) await leaveCall(joined)
    for (const context of contexts) await context.close().catch(() => undefined)
  },
})
