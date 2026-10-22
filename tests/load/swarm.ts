/**
 * Browser bot swarm (Stage 10, docs/PERFORMANCE.md §3.2): N guests join one meeting through the real invite flow
 * (`/m/<slug>#k=…&t=…`) in headless Chromium with fake media and E2EE on, exactly like people who open an invite link.
 * It is a Playwright library script, not a test: `pnpm test:e2e` never runs it.
 *
 *   SWARM_LINK='<invite link>' pnpm exec tsx tests/load/swarm.ts --bots 8 --duration 300 --out swarm.json
 *
 * The meeting: create a room (waiting room off, guests allowed, maximum participants 25) and an invite link with
 * enough uses (or unlimited) for every bot and the observer. Pass the link in SWARM_LINK, never on the command line:
 * it contains the room key, and this script never prints it (only its origin).
 *
 * What it does:
 * - An observer tab (1920×1080) joins first, so every bot has a remote publisher when it joins. Then the bots join one
 *   by one, `--join-interval` apart (the `join-ip` limit allows 30 info/join requests per minute per source IP and
 *   every join makes two, so one host adds at most 15 bots per minute).
 * - Per bot: page load → pre-join, Join click → connected and → first remote frame (the `blinq:join:*` performance
 *   marks, present in production builds), and inbound WebRTC statistics over the steady state (packet loss, decoded
 *   frame rate, freezes) plus why its own camera encoder was limited (cpu, bandwidth).
 * - The observer checks the grid (`5x5` for 25 people), counts tiles and measures presented frames per remote video
 *   (requestVideoFrameCallback) and decoded frames (inbound-rtp) several times during the steady state.
 * - The host running the bots samples its own CPU; `--sfu-container <name>` also samples a local LiveKit container
 *   (`docker stats` CPU and memory, eth0 byte counters for Mbit/s), for single-machine runs.
 * - Prints one JSON summary on stdout (and to `--out`). Exit code 1 when a bot could not join.
 *
 * Bots publish a small test pattern (`--video-size`, default 640x360 at 15 fps, generated with ffmpeg) so the bot host
 * measures blinq rather than video encoding; `--video default` uses Chromium's built-in fake camera instead.
 *
 * Several load hosts: run this script on each host with the same SWARM_LINK, a distinct `--name` and `--bots` set to
 * that host's share, and `--no-observer` on all but one (best: the observer on a machine without bots). Start the
 * hosts a few seconds apart; each host has its own `join-ip` budget when it has its own public IP. Keep every bot host
 * below 70 % CPU (`host.cpu` in the summary); above that the numbers describe the bots, not blinq.
 *
 * Options: --bots N (4) · --duration S of steady state after the last join (60) · --join-interval MS (4500) ·
 * --name PREFIX (`Bot <hostname>`) · --bots-per-browser N (4) · --video auto|default|<file.y4m> (auto) ·
 * --video-size WxH (640x360) · --video-fps N (15) · --no-observer · --observer-samples N (3) · --sfu-container NAME ·
 * --ignore-https-errors (Caddy's internal CA) · --headed · --join-timeout MS (60000) · --out FILE.
 *
 * On a single machine against the E2E stack (test build, e2e Caddy, dev LiveKit), `tests/load/onbox.spec.ts` creates
 * the room and invite and runs this swarm: `sh scripts/e2e.sh --config tests/load/playwright.config.ts`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { cpus, hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'

export interface SwarmOptions {
  /** Invite link with `#k=…&t=…`. Never logged. */
  link: string
  bots: number
  durationSec: number
  joinIntervalMs: number
  namePrefix: string
  botsPerBrowser: number
  /** `auto` (generated test pattern), `default` (Chromium's fake camera) or a .y4m file. */
  video: string
  videoSize: string
  videoFps: number
  observer: boolean
  observerSamples: number
  sfuContainer?: string
  ignoreHttpsErrors: boolean
  headed: boolean
  joinTimeoutMs: number
  out?: string
  /** Progress lines (stderr by default). */
  log?: (line: string) => void
}

export const DEFAULT_OPTIONS: Omit<SwarmOptions, 'link'> = {
  bots: 4,
  durationSec: 60,
  joinIntervalMs: 4_500,
  namePrefix: `Bot ${hostname().split('.')[0]!.slice(0, 12)}`,
  botsPerBrowser: 4,
  video: 'auto',
  videoSize: '640x360',
  videoFps: 15,
  observer: true,
  observerSamples: 3,
  ignoreHttpsErrors: false,
  headed: false,
  joinTimeoutMs: 60_000,
}

const MARKS = {
  click: 'blinq:join:click',
  connected: 'blinq:join:connected',
  frame: 'blinq:join:first-remote-frame',
} as const

const CHROMIUM_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]

interface InboundTotals {
  at: number
  videoStreams: number
  packetsReceived: number
  packetsLost: number
  framesDecoded: number
  freezeCount: number
  bytesReceived: number
  /** Own camera layers by `qualityLimitationReason`. */
  limitation: Record<string, number>
}

export interface SteadyStats {
  videoStreams: number
  lossPercent: number
  decodedFpsPerStream: number
  freezesPerMin: number
  receivedMbps: number
  cameraLimitation: Record<string, number>
}

export interface BotResult {
  name: string
  role: 'bot' | 'observer'
  ok: boolean
  error?: string
  /** goto → pre-join screen. */
  loadMs?: number
  /** Join click → first decoded remote frame (the join-time metric). */
  joinMs?: number
  /** Join click → connected. */
  connectMs?: number
  /** Connected → first remote frame. */
  firstFrameMs?: number
  steady?: SteadyStats
}

export interface Distribution {
  min: number
  p50: number
  mean: number
  max: number
}

export interface Percentiles {
  n: number
  p50: number
  p95: number
  max: number
}

export interface ObserverSample {
  atSec: number
  participants: number
  grid: string
  tiles: number
  remoteVideos: number
  presentedFps: Distribution | null
  /** Decoded frames per second and remote video stream (inbound-rtp, averaged over the streams). */
  decodedFpsPerStream: number
  resolutions: Record<string, number>
  /** Remote videos that presented fewer than 5 frames per second. */
  slowTiles: number
}

export interface SwarmSummary {
  target: string
  startedAt: string
  options: Omit<SwarmOptions, 'link' | 'log'>
  host: { name: string; cpuModel: string; cores: number; cpuPercent: Distribution | null }
  joined: number
  failed: number
  joinMs: Percentiles | null
  connectMs: Percentiles | null
  firstFrameMs: Percentiles | null
  loadMs: Percentiles | null
  steady: {
    lossPercent: Distribution | null
    decodedFpsPerStream: Distribution | null
    freezesPerMin: Distribution | null
    receivedMbpsPerParticipant: Distribution | null
    cameraLimitation: Record<string, number>
  }
  observer: ObserverSample[]
  sfu?: {
    cpuPercent: Distribution | null
    memMiB: Distribution | null
    rxMbps: Distribution | null
    txMbps: Distribution | null
  }
  bots: BotResult[]
}

// ---- Small helpers --------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits

/** Nearest-rank percentiles, as in docs/TESTING.md §6.7. */
export function percentiles(values: number[]): Percentiles | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
  return { n: sorted.length, p50: Math.round(rank(0.5)), p95: Math.round(rank(0.95)), max: Math.round(sorted.at(-1)!) }
}

export function distribution(values: number[]): Distribution | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    min: round(sorted[0]!),
    p50: round(sorted[Math.max(0, Math.ceil(0.5 * sorted.length) - 1)]!),
    mean: round(mean),
    max: round(sorted.at(-1)!),
  }
}

/** Runs a command without a shell and returns its stdout (rejects on a non-zero exit). */
function output(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}`))))
  })
}

/** A generated test pattern (y4m) for the fake camera, or undefined for Chromium's built-in one. */
function prepareVideo(options: SwarmOptions, log: (line: string) => void): string | undefined {
  if (options.video === 'default') return undefined
  if (options.video !== 'auto') {
    if (!existsSync(options.video)) throw new Error(`--video ${options.video} does not exist`)
    return resolve(options.video)
  }
  const file = join(tmpdir(), `blinq-swarm-${options.videoSize}-${options.videoFps}.y4m`)
  if (existsSync(file)) return file
  const source = `testsrc2=size=${options.videoSize}:rate=${options.videoFps}`
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', '20', '-pix_fmt', 'yuv420p']
  const ffmpeg = spawnSync('ffmpeg', [...args, '-y', file], { stdio: 'inherit' })
  if (ffmpeg.status !== 0) {
    log('ffmpeg is not available: using the built-in fake camera (--video default)')
    return undefined
  }
  return file
}

/**
 * Init script for every swarm page: keeps each RTCPeerConnection the app creates, so the script can read the standard
 * WebRTC statistics without test hooks (production builds have none). Runs in the page, before the app.
 */
function recordPeerConnections(): void {
  const Original = globalThis.RTCPeerConnection
  if (!Original) return
  const connections: RTCPeerConnection[] = []
  class Recorded extends Original {
    constructor(configuration?: RTCConfiguration) {
      super(configuration)
      connections.push(this)
    }
  }
  globalThis.RTCPeerConnection = Recorded
  Object.defineProperty(globalThis, '__swarmPeerConnections', { value: connections })
}

async function inboundTotals(page: Page): Promise<InboundTotals> {
  return page.evaluate(async () => {
    const connections =
      (globalThis as unknown as { __swarmPeerConnections?: RTCPeerConnection[] }).__swarmPeerConnections ?? []
    const totals = {
      at: performance.now(),
      videoStreams: 0,
      packetsReceived: 0,
      packetsLost: 0,
      framesDecoded: 0,
      freezeCount: 0,
      bytesReceived: 0,
      limitation: {} as Record<string, number>,
    }
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    for (const connection of connections) {
      if (connection.connectionState === 'closed') continue
      const stats = await connection.getStats()
      stats.forEach((report: Record<string, unknown>) => {
        if (report.type === 'inbound-rtp') {
          totals.packetsReceived += num(report.packetsReceived)
          totals.packetsLost += Math.max(0, num(report.packetsLost))
          totals.bytesReceived += num(report.bytesReceived)
          if (report.kind === 'video') {
            totals.videoStreams += num(report.framesDecoded) > 0 ? 1 : 0
            totals.framesDecoded += num(report.framesDecoded)
            totals.freezeCount += num(report.freezeCount)
          }
        } else if (report.type === 'outbound-rtp' && report.kind === 'video' && report.active !== false) {
          const reason = String(report.qualityLimitationReason ?? 'none')
          totals.limitation[reason] = (totals.limitation[reason] ?? 0) + 1
        }
      })
    }
    return totals
  })
}

function steadyStats(before: InboundTotals, after: InboundTotals): SteadyStats {
  const seconds = Math.max(0.001, (after.at - before.at) / 1000)
  const received = after.packetsReceived - before.packetsReceived
  const lost = after.packetsLost - before.packetsLost
  return {
    videoStreams: after.videoStreams,
    lossPercent: round((lost / Math.max(1, received + lost)) * 100, 2),
    decodedFpsPerStream: round(
      (after.framesDecoded - before.framesDecoded) / seconds / Math.max(1, after.videoStreams),
    ),
    freezesPerMin: round(((after.freezeCount - before.freezeCount) / seconds) * 60, 2),
    receivedMbps: round(((after.bytesReceived - before.bytesReceived) * 8) / seconds / 1e6, 2),
    cameraLimitation: after.limitation,
  }
}

async function marks(page: Page): Promise<Record<keyof typeof MARKS, number | null>> {
  return page.evaluate((names) => {
    const at = (name: string) => performance.getEntriesByName(name)[0]?.startTime ?? null
    return { click: at(names.click), connected: at(names.connected), frame: at(names.frame) }
  }, MARKS)
}

// ---- Participants ----------------------------------------------------------------------------------------------------

interface Participant {
  role: 'bot' | 'observer'
  context: BrowserContext
  page: Page
  result: BotResult
  before?: InboundTotals
}

async function joinMeeting(
  browser: Browser,
  options: SwarmOptions,
  name: string,
  role: Participant['role'],
): Promise<Participant> {
  const viewport = role === 'observer' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: options.ignoreHttpsErrors })
  await context.addInitScript(recordPeerConnections)
  const page = await context.newPage()
  const result: BotResult = { name, role, ok: false }
  try {
    const started = Date.now()
    await page.goto(options.link)
    await page.getByTestId('prejoin').waitFor({ timeout: options.joinTimeoutMs })
    result.loadMs = Date.now() - started
    const nameField = page.getByLabel('Your name')
    if (await nameField.count()) await nameField.fill(name)
    await page.getByTestId('join-button').click()
    await page.locator('[data-testid="join-flow"][data-phase="inCall"]').waitFor({ timeout: options.joinTimeoutMs })
    if (role === 'bot') {
      const deadline = Date.now() + options.joinTimeoutMs
      let found = await marks(page)
      while (found.frame === null && Date.now() < deadline) {
        await sleep(250)
        found = await marks(page)
      }
      if (found.click === null || found.frame === null) throw new Error('no first remote frame')
      result.joinMs = Math.round(found.frame - found.click)
      if (found.connected !== null) {
        result.connectMs = Math.round(found.connected - found.click)
        result.firstFrameMs = Math.round(found.frame - found.connected)
      }
    }
    result.ok = true
  } catch (error) {
    const flow = page.getByTestId('join-flow')
    const phase = await flow.getAttribute('data-phase', { timeout: 1_000 }).catch(() => null)
    const text = await flow.innerText({ timeout: 1_000 }).catch(() => '')
    const reason = (error as Error).message.split('\n')[0]
    result.error = `${reason} (phase ${phase ?? 'unknown'}: ${text.replace(/\s+/g, ' ').slice(0, 160)})`
  }
  return { role, context, page, result }
}

async function observe(page: Page, atSec: number): Promise<ObserverSample> {
  const before = await inboundTotals(page)
  const view = await page.evaluate(async () => {
    const grid = document.querySelector('[data-testid="video-grid"]')
    const tiles = document.querySelectorAll('[data-testid="participant-tile"]').length
    const videos = [
      ...document.querySelectorAll<HTMLVideoElement>('[data-testid="participant-tile"]:not([data-local]) video'),
    ]
    const counts = videos.map(() => 0)
    let running = true
    videos.forEach((video, index) => {
      const onFrame = () => {
        counts[index]!++
        if (running) video.requestVideoFrameCallback(onFrame)
      }
      video.requestVideoFrameCallback(onFrame)
    })
    const windowMs = 3_000
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    running = false
    return {
      participants: Number(document.querySelector('[data-testid="participant-count"]')?.textContent ?? 0),
      grid: grid ? `${grid.getAttribute('data-cols')}x${grid.getAttribute('data-rows')}` : 'none',
      tiles,
      videos: videos.map((video, index) => ({
        fps: counts[index]! / (windowMs / 1000),
        size: `${video.videoWidth}x${video.videoHeight}`,
      })),
    }
  })
  const after = await inboundTotals(page)
  const seconds = Math.max(0.001, (after.at - before.at) / 1000)
  const resolutions: Record<string, number> = {}
  for (const video of view.videos) resolutions[video.size] = (resolutions[video.size] ?? 0) + 1
  return {
    atSec,
    participants: view.participants,
    grid: view.grid,
    tiles: view.tiles,
    remoteVideos: view.videos.length,
    presentedFps: distribution(view.videos.map((video) => video.fps)),
    decodedFpsPerStream: round(
      (after.framesDecoded - before.framesDecoded) / seconds / Math.max(1, after.videoStreams),
    ),
    resolutions,
    slowTiles: view.videos.filter((video) => video.fps < 5).length,
  }
}

// ---- Resource sampling ----------------------------------------------------------------------------------------------

function cpuTimes(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total += cpu.times.idle + cpu.times.user + cpu.times.sys + cpu.times.nice + cpu.times.irq
  }
  return { idle, total }
}

const UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
}

function parseSize(text: string): number {
  const match = /([\d.]+)\s*([A-Za-z]+)/.exec(text.trim())
  return match ? Number(match[1]) * (UNITS[match[2]!] ?? 1) : 0
}

/** Host CPU every 5 s; with a container name also its CPU, memory and eth0 traffic (single-machine runs). */
class Sampler {
  private timer: ReturnType<typeof setInterval> | undefined
  private lastCpu = cpuTimes()
  private lastNet: { at: number; rx: number; tx: number } | undefined
  readonly hostCpu: number[] = []
  readonly sfuCpu: number[] = []
  readonly sfuMem: number[] = []
  readonly sfuRx: number[] = []
  readonly sfuTx: number[] = []

  constructor(private readonly container?: string) {}

  start(intervalMs = 5_000): void {
    this.lastCpu = cpuTimes()
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Drops the samples taken so far (the join phase), so the summary covers the steady state only. */
  reset(): void {
    for (const list of [this.hostCpu, this.sfuCpu, this.sfuMem, this.sfuRx, this.sfuTx]) list.length = 0
  }

  private async tick(): Promise<void> {
    const now = cpuTimes()
    const total = now.total - this.lastCpu.total
    if (total > 0) this.hostCpu.push((1 - (now.idle - this.lastCpu.idle) / total) * 100)
    this.lastCpu = now
    if (!this.container) return
    try {
      const stats = await output('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.CPUPerc}};{{.MemUsage}}',
        this.container,
      ])
      const [cpu, mem] = stats.trim().split(';')
      this.sfuCpu.push(Number.parseFloat(cpu ?? '0'))
      this.sfuMem.push(parseSize((mem ?? '').split('/')[0] ?? '') / 1024 ** 2)
      const counters = await output('docker', [
        'exec',
        this.container,
        'cat',
        '/sys/class/net/eth0/statistics/rx_bytes',
        '/sys/class/net/eth0/statistics/tx_bytes',
      ])
      const [rx, tx] = counters.trim().split('\n').map(Number)
      if (rx === undefined || tx === undefined) return
      const at = Date.now()
      if (this.lastNet) {
        const seconds = (at - this.lastNet.at) / 1000
        this.sfuRx.push(((rx - this.lastNet.rx) * 8) / seconds / 1e6)
        this.sfuTx.push(((tx - this.lastNet.tx) * 8) / seconds / 1e6)
      }
      this.lastNet = { at, rx, tx }
    } catch {
      // A missing container or docker CLI only loses the SFU columns.
    }
  }
}

// ---- The swarm --------------------------------------------------------------------------------------------------------

export async function runSwarm(options: SwarmOptions): Promise<SwarmSummary> {
  const log = options.log ?? ((line: string) => process.stderr.write(`swarm: ${line}\n`))
  const target = new URL(options.link).origin
  const video = prepareVideo(options, log)
  const args = [...CHROMIUM_ARGS, ...(video ? [`--use-file-for-fake-video-capture=${video}`] : [])]
  const browsers: Browser[] = []
  const launch = async () => {
    const browser = await chromium.launch({ headless: !options.headed, args })
    browsers.push(browser)
    return browser
  }
  const participants: Participant[] = []
  const sampler = new Sampler(options.sfuContainer)
  const startedAt = new Date().toISOString()
  log(
    `${target}: ${options.bots} bots${options.observer ? ' and an observer' : ''}, ${options.joinIntervalMs} ms apart`,
  )
  sampler.start()
  try {
    if (options.observer) {
      const observer = await joinMeeting(await launch(), options, `${options.namePrefix} observer`, 'observer')
      participants.push(observer)
      log(observer.result.ok ? 'observer joined' : `observer failed: ${observer.result.error}`)
      await sleep(options.joinIntervalMs)
    }
    let browser: Browser | undefined
    const joins: Promise<void>[] = []
    for (let index = 0; index < options.bots; index++) {
      if (!browser || index % options.botsPerBrowser === 0) browser = await launch()
      const name = `${options.namePrefix} ${String(index + 1).padStart(2, '0')}`
      joins.push(
        joinMeeting(browser, options, name, 'bot').then((participant) => {
          participants.push(participant)
          const { result } = participant
          log(result.ok ? `${name} joined in ${result.joinMs} ms` : `${name} failed: ${result.error}`)
        }),
      )
      if (index < options.bots - 1) await sleep(options.joinIntervalMs)
    }
    await Promise.all(joins)

    // Steady state: everyone who joined stays for `durationSec`.
    await sleep(5_000)
    sampler.reset()
    const live = participants.filter((participant) => participant.result.ok)
    await Promise.all(live.map(async (participant) => (participant.before = await inboundTotals(participant.page))))
    const steadyStart = Date.now()
    const observerSamples: ObserverSample[] = []
    const observer = live.find((participant) => participant.role === 'observer')
    const count = Math.max(1, options.observerSamples)
    for (let index = 1; index <= count; index++) {
      const due = steadyStart + (options.durationSec * 1000 * index) / count - 5_000
      await sleep(Math.max(0, due - Date.now()))
      if (observer) observerSamples.push(await observe(observer.page, Math.round((Date.now() - steadyStart) / 1000)))
    }
    await sleep(Math.max(0, steadyStart + options.durationSec * 1000 - Date.now()))
    await Promise.all(
      live.map(async (participant) => {
        const after = await inboundTotals(participant.page).catch(() => undefined)
        if (after && participant.before) participant.result.steady = steadyStats(participant.before, after)
      }),
    )
    sampler.stop()

    const bots = participants.filter((participant) => participant.role === 'bot').map(({ result }) => result)
    const joined = bots.filter((bot) => bot.ok)
    const steady = participants.flatMap(({ result }) => (result.steady ? [result.steady] : []))
    const limitation: Record<string, number> = {}
    for (const entry of steady) {
      for (const [reason, n] of Object.entries(entry.cameraLimitation))
        limitation[reason] = (limitation[reason] ?? 0) + n
    }
    const only = (pick: (bot: BotResult) => number | undefined) =>
      joined.flatMap((bot) => {
        const value = pick(bot)
        return value === undefined ? [] : [value]
      })
    const { link: _link, log: _log, ...shown } = options
    const summary: SwarmSummary = {
      target,
      startedAt,
      options: shown,
      host: {
        name: hostname(),
        cpuModel: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        cpuPercent: distribution(sampler.hostCpu),
      },
      joined: joined.length,
      failed: bots.length - joined.length,
      joinMs: percentiles(only((bot) => bot.joinMs)),
      connectMs: percentiles(only((bot) => bot.connectMs)),
      firstFrameMs: percentiles(only((bot) => bot.firstFrameMs)),
      loadMs: percentiles(only((bot) => bot.loadMs)),
      steady: {
        lossPercent: distribution(steady.map((s) => s.lossPercent)),
        decodedFpsPerStream: distribution(steady.map((s) => s.decodedFpsPerStream)),
        freezesPerMin: distribution(steady.map((s) => s.freezesPerMin)),
        receivedMbpsPerParticipant: distribution(steady.map((s) => s.receivedMbps)),
        cameraLimitation: limitation,
      },
      observer: observerSamples,
      ...(options.sfuContainer
        ? {
            sfu: {
              cpuPercent: distribution(sampler.sfuCpu),
              memMiB: distribution(sampler.sfuMem),
              rxMbps: distribution(sampler.sfuRx),
              txMbps: distribution(sampler.sfuTx),
            },
          }
        : {}),
      bots: participants.map(({ result }) => result),
    }
    if (options.out) writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`)
    return summary
  } finally {
    sampler.stop()
    // Leave gracefully: a dropped connection keeps its seat until LiveKit notices.
    await Promise.all(
      participants.map(({ page }) =>
        page
          .getByRole('button', { name: 'Leave call' })
          .click({ timeout: 5_000 })
          .catch(() => undefined),
      ),
    )
    await sleep(1_000)
    for (const browser of browsers) await browser.close().catch(() => undefined)
  }
}

// ---- CLI --------------------------------------------------------------------------------------------------------------

function parseCli(argv: string[]): SwarmOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      bots: { type: 'string' },
      duration: { type: 'string' },
      'join-interval': { type: 'string' },
      name: { type: 'string' },
      'bots-per-browser': { type: 'string' },
      video: { type: 'string' },
      'video-size': { type: 'string' },
      'video-fps': { type: 'string' },
      'no-observer': { type: 'boolean' },
      'observer-samples': { type: 'string' },
      'sfu-container': { type: 'string' },
      'ignore-https-errors': { type: 'boolean' },
      headed: { type: 'boolean' },
      'join-timeout': { type: 'string' },
      out: { type: 'string' },
    },
  })
  const link = process.env.SWARM_LINK
  if (!link || !/#k=[\w-]{43}/.test(link)) {
    throw new Error('Set SWARM_LINK to an invite link with its #k=… fragment (never pass it as an argument)')
  }
  const number = (value: string | undefined, fallback: number) => (value === undefined ? fallback : Number(value))
  const d = DEFAULT_OPTIONS
  return {
    link,
    bots: number(values.bots, d.bots),
    durationSec: number(values.duration, d.durationSec),
    joinIntervalMs: number(values['join-interval'], d.joinIntervalMs),
    namePrefix: values.name ?? d.namePrefix,
    botsPerBrowser: Math.max(1, number(values['bots-per-browser'], d.botsPerBrowser)),
    video: values.video ?? d.video,
    videoSize: values['video-size'] ?? d.videoSize,
    videoFps: number(values['video-fps'], d.videoFps),
    observer: !values['no-observer'],
    observerSamples: number(values['observer-samples'], d.observerSamples),
    sfuContainer: values['sfu-container'],
    ignoreHttpsErrors: Boolean(values['ignore-https-errors']),
    headed: Boolean(values.headed),
    joinTimeoutMs: number(values['join-timeout'], d.joinTimeoutMs),
    out: values.out,
  }
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href
if (invokedDirectly) {
  const summary = await runSwarm(parseCli(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  process.exitCode = summary.failed > 0 ? 1 : 0
}
