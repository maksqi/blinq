import { randomBytes } from 'node:crypto'
import { chromium, expect, firefox, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { smoke, watchProblems, type PageProblems } from './support'

/**
 * The real call flow on the production image behind the real Caddy (Stage 10). The bootstrap admin signs in (and
 * picks a new password, as the first sign-in requires), creates a room on the dashboard and joins it at /m/<slug>. A
 * guest in the other engine opens the invite link from the in-call invite button, asks to join, is admitted from the
 * waiting-room panel, and both receive each other's decrypted video and audio.
 *
 * - No test hooks (the image has none), no bypassCSP, no harness: the production CSP applies, and every CSP violation
 *   or console error in any page fails the test.
 * - What the UI shows is checked from the DOM: the remote tile's <video> presents frames (requestVideoFrameCallback),
 *   the app's hidden <audio> element plays the remote microphone as a live, unmuted track, the tile shows no muted
 *   microphone, the E2EE badge says "Encrypted" and both sides show the same safety code.
 * - What the DOM cannot show is read from the standard WebRTC statistics of the app's own peer connections: a
 *   Playwright init script (test side, never in the image, CSP untouched) keeps a reference to each RTCPeerConnection
 *   the app creates and, for the relay-only call, sets iceTransportPolicy 'relay' the way a firewall that allows no
 *   direct media would force it. From those: the Stage 09 network assertions (every IPv4 SFU candidate is
 *   LIVEKIT_NODE_IP, UDP ports from the media range; relay-only media through LiveKit's TURN), and that remote audio
 *   keeps arriving, decoding and, from Chromium, carries signal (inbound-rtp totalAudioEnergy).
 * - Firefox's Web Audio cannot run in the Playwright image: Firefox plays audio only through PulseAudio, and the image
 *   has no PulseAudio server, so every AudioContext stays suspended. The app sends the microphone through its Web
 *   Audio chain, so Firefox's published audio is digital silence here (a desktop has a sound server; the app's own
 *   pre-join microphone meter shows 0 in Firefox), and a Web Audio probe in a Firefox page hears nothing. Audio from a
 *   sender whose Web Audio cannot run is therefore asserted as arriving and decoding, not as loud.
 *
 * Signaling goes through Caddy (wss://DOMAIN/rtc), media straight to LiveKit on the host network.
 */

type Engine = 'chromium' | 'firefox'

interface Candidate {
  address: string
  port: number
  protocol: string
  candidateType: string
}

interface IceSummary {
  /**
   * The SFU's candidates as the browser knows them: the host candidates it was sent, plus the remote end of each
   * selected pair (peer-reflexive when the SFU's first check beat its trickled candidate, which happens in Firefox).
   */
  sfu: Candidate[]
  /** The selected pair of every connected peer connection. */
  selected: { local: Candidate; remote: Candidate }[]
}

interface MediaProbe {
  /** Remote camera tiles on the page. */
  tiles: number
  /** The first remote camera <video>: its size and the frames it presented during the probe. */
  video: { width: number; height: number; frames: number } | null
  /** The app's remote audio elements, and how many of them play a live, unmuted track. */
  audio: { elements: number; playing: number }
  /** The remote tile's own indicators (active speaker ring, muted microphone icon). */
  tile: { speaking: boolean; micOff: boolean }
}

/** Remote audio received by the page so far (inbound-rtp of the app's peer connections, summed). */
interface InboundAudio {
  packetsReceived: number
  totalSamplesReceived: number
  totalAudioEnergy: number
}

interface Participant {
  label: string
  engine: Engine
  context: BrowserContext
  page: Page
  problems: PageProblems
  /** Console errors this participant causes on purpose. */
  allowedErrors: RegExp[]
  /** Every console message, attached to the report when the test fails. */
  consoleLog: string[]
}

const CHROMIUM_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
]
const FIREFOX_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'permissions.default.camera': 1,
  'permissions.default.microphone': 1,
  'media.autoplay.default': 0,
}

/**
 * Decoded audio energy (inbound-rtp totalAudioEnergy, the integral of the squared level over time) that 3 s of
 * Chromium's fake microphone, a full-scale beep every 0.5 s, easily exceed (about 0.3 per second); decoded silence and
 * comfort noise stay below 1e-6.
 */
const MIN_AUDIO_ENERGY = 0.01
const AUDIO_WINDOW_MS = 3_000
const MEDIA_TIMEOUT_MS = 60_000
const GUEST_NAME = 'Smoke Guest'

/**
 * The bootstrap admin's password after the forced change: ADMIN_PASSWORD plus a suffix, so scripts/smoke-prod.sh's
 * scan for ADMIN_PASSWORD in the container logs also catches the new one.
 */
const newAdminPassword = () => `${smoke.adminPassword()}-smoke`

/** Set once the forced change has happened in this worker (the stack is fresh for every smoke run). */
let adminPasswordChanged = false

/** The browsers and participants of the running test, for the diagnostics and the cleanup in afterEach. */
const current: { browsers: Browser[]; participants: Participant[] } = { browsers: [], participants: [] }

test.afterEach(async () => {
  const info = test.info()
  if (info.status !== info.expectedStatus) await attachDiagnostics(current.participants)
  await Promise.all(current.browsers.map((browser) => browser.close().catch(() => undefined)))
  current.browsers = []
  current.participants = []
})

test('the admin hosts a meeting in Chromium and a Firefox guest joins through the invite link and waiting room', async () => {
  test.setTimeout(180_000)
  const participants = await meeting({ host: 'chromium', relayOnly: false })

  await test.step('the SFU advertises LIVEKIT_NODE_IP and the media port range', async () => {
    // Every IPv4 address of the SFU is LIVEKIT_NODE_IP (so no Docker bridge address leaks) and every UDP port is from
    // the configured range. LiveKit also offers the host's own IPv6 addresses.
    const [start, end] = smoke.rtcPortRange()
    for (const { label, page } of participants) {
      const { sfu, selected } = await iceSummary(page)
      const detail = JSON.stringify({ sfu, selected })
      test.info().annotations.push({ type: `ICE (${label})`, description: detail })
      const ipv4 = sfu.filter((candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate.address))
      expect(ipv4.length, `${label}: the browser knows IPv4 candidates of the SFU: ${detail}`).toBeGreaterThan(0)
      for (const candidate of ipv4) {
        expect(candidate.address, `${label}: IPv4 candidates advertise LIVEKIT_NODE_IP: ${detail}`).toBe(smoke.nodeIp())
      }
      for (const candidate of sfu.filter((c) => c.protocol === 'udp')) {
        expect(candidate.port, `${label}: UDP media ports are in ${start}-${end}: ${detail}`).toBeGreaterThanOrEqual(
          start,
        )
        expect(candidate.port, `${label}: UDP media ports are in ${start}-${end}: ${detail}`).toBeLessThanOrEqual(end)
      }
      expect(selected.length, `${label}: the connections to the SFU have a selected pair: ${detail}`).toBeGreaterThan(0)
    }
  })

  await leave(participants)
})

// Relay only, as behind a firewall that allows no direct media: both browsers reach the SFU through LiveKit's embedded
// TURN server. The SFU's address is private here, so this also proves turn.allow_restricted_peer_cidrs. Browsers
// reject the internal CA for TURN over TLS, so they relay over TURN/UDP; TURN/TLS itself is checked in routing.spec.ts.
// The engines swap roles: Firefox hosts, Chromium is the guest.
test('a relay-only meeting hosted in Firefox with a Chromium guest goes through LiveKit TURN', async () => {
  test.setTimeout(180_000)
  const participants = await meeting({ host: 'firefox', relayOnly: true })

  await test.step('media goes through TURN relays', async () => {
    for (const { label, page } of participants) {
      const { selected } = await iceSummary(page)
      const detail = JSON.stringify(selected)
      test.info().annotations.push({ type: `relay (${label})`, description: detail })
      expect(selected.length, `${label}: connected through TURN: ${detail}`).toBeGreaterThan(0)
      for (const pair of selected) expect(pair.local.candidateType, `${label}: ${detail}`).toBe('relay')
    }
  })

  await leave(participants)
})

/**
 * The whole meeting up to the point where both sides receive each other's media: the host signs in, creates and joins
 * a room; the guest (the other engine) joins with the in-call invite link through the waiting room.
 */
async function meeting(options: { host: Engine; relayOnly: boolean }): Promise<Participant[]> {
  const launch = async (engine: Engine) => {
    const browser =
      engine === 'chromium'
        ? await chromium.launch({ args: CHROMIUM_ARGS })
        : await firefox.launch({ firefoxUserPrefs: FIREFOX_PREFS })
    current.browsers.push(browser)
    return browser
  }
  const launched = { chromium: await launch('chromium'), firefox: await launch('firefox') }
  const guestEngine: Engine = options.host === 'chromium' ? 'firefox' : 'chromium'
  const roomName = `Smoke ${options.relayOnly ? 'relay' : 'direct'} ${randomBytes(3).toString('hex')}`

  const host = await openParticipant(launched[options.host], `host (${options.host})`, options)
  await test.step(`the admin signs in (${options.host})`, () => signInAsAdmin(host))
  await test.step('the host creates a room on the dashboard and joins it', () => createAndJoinRoom(host, roomName))

  const link = await test.step('the host creates an invite link in the call', async () => {
    // A fresh room invite plus the key from this tab, built in the browser.
    await host.page.getByRole('button', { name: 'Invite people' }).click()
    const field = host.page.getByRole('textbox', { name: 'Invite link' })
    await expect(field).toHaveValue(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}#k=[\w-]{43}&t=[\w-]+$/, { timeout: 20_000 })
    const value = await field.inputValue()
    expect(new URL(value).origin, 'the invite link uses PUBLIC_URL').toBe(new URL(smoke.baseURL).origin)
    await host.page.keyboard.press('Escape')
    return value
  })

  const guest = await openParticipant(launched[guestEngine], `guest (${guestEngine})`, options)
  await test.step(`the guest opens the link and asks to join (${guestEngine})`, async () => {
    await guest.page.goto(link)
    await expectPrejoin(guest, roomName)
    await guest.page.getByLabel('Your name').fill(GUEST_NAME)
    await expect(guest.page.getByTestId('join-button')).toHaveText(/Ask to join/)
    await guest.page.getByTestId('join-button').click()
    await expect(guest.page.getByTestId('waiting-room')).toBeVisible({ timeout: 20_000 })
  })

  await test.step('the host admits the guest from the waiting-room panel', async () => {
    await host.page.locator('button[data-panel="lobby"]').click()
    const entry = host.page.getByTestId('lobby-entry').filter({ hasText: GUEST_NAME })
    await expect(entry).toBeVisible({ timeout: 20_000 })
    await entry.getByTestId('lobby-admit').click()
    await expect(entry).toBeHidden()
    await expectInCall(guest.page)
  })

  const participants = [host, guest]
  await test.step('both see and hear each other, end-to-end encrypted', async () => {
    for (const { label, page } of participants) {
      await expect(page.getByTestId('participant-count'), `${label}: two people`).toHaveText('2', { timeout: 30_000 })
    }
    await expectMediaFromTheOtherSide(participants)
    await expectSameSafetyCode(participants)
  })
  return participants
}

/**
 * Signs in as the bootstrap admin and lands on the dashboard. The first sign-in of the stack goes through the forced
 * password change. A worker that restarted after a failed test no longer knows that the password changed: its refused
 * first attempt is the one console error this allows.
 */
async function signInAsAdmin(participant: Participant): Promise<void> {
  const { page } = participant
  const submit = async (password: string) => {
    await page.getByLabel('Email').fill(smoke.adminEmail())
    await page.getByLabel('Password', { exact: true }).fill(password)
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/auth/login',
      ),
      page.getByRole('button', { name: 'Sign in' }).click(),
    ])
    return response.status()
  }

  await page.goto('/login')
  let status = await submit(adminPasswordChanged ? newAdminPassword() : smoke.adminPassword())
  if (status === 401 && !adminPasswordChanged) {
    participant.allowedErrors.push(/status of 401/)
    adminPasswordChanged = true
    status = await submit(newAdminPassword())
  }
  expect(status, 'the admin signs in').toBe(200)
  if (!adminPasswordChanged) {
    await expect(page).toHaveURL(/\/change-password$/)
    await page.getByLabel('Current password').fill(smoke.adminPassword())
    await page.getByLabel('New password', { exact: true }).fill(newAdminPassword())
    await page.getByLabel('Repeat new password').fill(newAdminPassword())
    await page.getByRole('button', { name: 'Save and continue' }).click()
    adminPasswordChanged = true
  }
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-menu')).toBeVisible()
}

async function openParticipant(browser: Browser, label: string, options: { relayOnly: boolean }): Promise<Participant> {
  const engine = browser.browserType().name() as Engine
  const context = await browser.newContext({
    baseURL: smoke.baseURL,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    // Firefox takes its media permissions from the launch preferences.
    permissions: engine === 'chromium' ? ['camera', 'microphone'] : [],
  })
  const problems = await watchProblems(context)
  await context.addInitScript(recordPeerConnections, options.relayOnly)
  const consoleLog: string[] = []
  context.on('console', (message) => consoleLog.push(`[${message.type()}] ${message.text()}`))
  const page = await context.newPage()
  const participant: Participant = { label, engine, context, page, problems, allowedErrors: [], consoleLog }
  current.participants.push(participant)
  return participant
}

/** Dashboard → New room (waiting room and guests on, the defaults) → Create and open → pre-join → Join now. */
async function createAndJoinRoom(host: Participant, roomName: string): Promise<void> {
  const { page } = host
  await page.goto('/dashboard')
  await page.getByTestId('new-room').click()
  const dialog = page.getByTestId('create-room-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Name', { exact: true }).fill(roomName)
  await expect(dialog.getByRole('switch', { name: 'Waiting room' })).toBeChecked()
  await expect(dialog.getByRole('switch', { name: 'Allow guests' })).toBeChecked()
  await dialog.getByTestId('create-room-submit').click()
  await expect(page).toHaveURL(/\/m\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/, { timeout: 20_000 })
  await expectPrejoin(host, roomName)
  await page.getByTestId('join-button').click()
  await expectInCall(page)
}

/** The pre-join screen with the meeting name and the camera preview; notes the microphone meter it shows. */
async function expectPrejoin(participant: Participant, roomName: string): Promise<void> {
  const { page, label } = participant
  await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('prejoin')).toContainText(roomName)
  await expect(page.getByTestId('prejoin-preview')).toBeVisible({ timeout: 30_000 })
  const meter = page.getByRole('meter', { name: 'Microphone level' })
  let loudest = 0
  for (let i = 0; i < 10 && (await meter.count()) > 0; i++) {
    loudest = Math.max(loudest, Number((await meter.first().getAttribute('aria-valuenow')) ?? 0))
    await page.waitForTimeout(150)
  }
  test.info().annotations.push({ type: `pre-join microphone level (${label})`, description: String(loudest) })
}

async function expectInCall(page: Page): Promise<void> {
  await expect(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'inCall', { timeout: 30_000 })
}

/**
 * Each side shows the other's camera tile whose video presents frames, and plays the other's microphone. The audio
 * keeps arriving and decoding, and it carries signal whenever the sender's Web Audio runs (always in Chromium; see the
 * file comment for Firefox).
 */
async function expectMediaFromTheOtherSide(participants: Participant[]): Promise<void> {
  const flowing = (probe: MediaProbe) =>
    probe.tiles === 1 && (probe.video?.width ?? 0) > 0 && (probe.video?.frames ?? 0) > 0 && probe.audio.playing > 0
  const deadline = Date.now() + MEDIA_TIMEOUT_MS
  let probes = await Promise.all(participants.map(({ page }) => probeRemoteMedia(page, 2_000)))
  while (!probes.every(flowing) && Date.now() < deadline) {
    probes = await Promise.all(participants.map(({ page }) => probeRemoteMedia(page, 2_000)))
  }

  const webAudio = await Promise.all(participants.map(({ page }) => webAudioRuns(page)))
  const before = await Promise.all(participants.map(({ page }) => inboundAudio(page)))
  await participants[0]!.page.waitForTimeout(AUDIO_WINDOW_MS)
  const after = await Promise.all(participants.map(({ page }) => inboundAudio(page)))

  for (const [index, { label, page }] of participants.entries()) {
    const probe = probes[index]!
    const sender = participants[1 - index]!
    const senderWebAudio = webAudio[1 - index]!
    const audio = {
      packets: after[index]!.packetsReceived - before[index]!.packetsReceived,
      samples: after[index]!.totalSamplesReceived - before[index]!.totalSamplesReceived,
      energy: after[index]!.totalAudioEnergy - before[index]!.totalAudioEnergy,
    }
    const detail = `${label}: ${JSON.stringify({ ...probe, audioFromTheOtherSide: audio, senderWebAudio })}`
    test.info().annotations.push({ type: `media (${label})`, description: detail })
    expect(probe.tiles, `one remote camera tile, ${detail}`).toBe(1)
    expect(probe.video?.width ?? 0, `the remote video has a size, ${detail}`).toBeGreaterThan(0)
    expect(probe.video?.frames ?? 0, `the remote video presents frames, ${detail}`).toBeGreaterThan(0)
    expect(probe.audio.playing, `the app plays the remote microphone as a live track, ${detail}`).toBeGreaterThan(0)
    expect(probe.tile.micOff, `the remote tile shows the microphone on, ${detail}`).toBe(false)
    expect(audio.packets, `remote audio keeps arriving, ${detail}`).toBeGreaterThan(0)
    expect(audio.samples, `remote audio keeps decoding, ${detail}`).toBeGreaterThan(0)
    if (sender.engine === 'chromium') expect(senderWebAudio, `Web Audio runs in Chromium, ${detail}`).toBe(true)
    if (senderWebAudio) {
      expect(audio.energy, `the remote audio decodes to signal, ${detail}`).toBeGreaterThan(MIN_AUDIO_ENERGY)
    }

    const tile = page.locator('[data-testid="participant-tile"][data-source="camera"]:not([data-local])')
    await expect(tile, `${label}: the remote tile is not blocked`).not.toHaveAttribute('data-blocked')
    await expect(tile, `${label}: the remote tile is decryptable`).not.toHaveAttribute('data-undecryptable')
    await expect(page.getByTestId('e2ee-badge'), `${label}: the E2EE badge`).toHaveAttribute('data-state', 'encrypted')
  }
}

/** Both sides derive the same safety code from the meeting key (the E2EE badge's popover). */
async function expectSameSafetyCode(participants: Participant[]): Promise<void> {
  const codes: string[] = []
  for (const { page } of participants) {
    await page.getByTestId('e2ee-badge').click()
    const code = page.getByTestId('safety-code')
    await expect(code).toHaveText(/\S/)
    codes.push((await code.textContent())?.trim() ?? '')
    await page.keyboard.press('Escape')
    await expect(code).toBeHidden()
  }
  expect(new Set(codes).size, `safety codes ${JSON.stringify(codes)}`).toBe(1)
}

/** Leaves gracefully (a torn-down live connection makes the SDK log errors), then checks the pages' problems. */
async function leave(participants: Participant[]): Promise<void> {
  await test.step('both leave; no CSP violation or console error anywhere', async () => {
    // The guest first, so the host's meeting stays up until the guest is out.
    for (const { page } of [...participants].reverse()) {
      await page.locator('[data-control="leave"]').click()
      await expect(page.getByTestId('call-end-screen')).toBeVisible({ timeout: 20_000 })
    }
    for (const { label, problems, allowedErrors } of participants) {
      expect(problems.cspViolations, `${label}: CSP violations`).toEqual([])
      expect(
        problems.errors.filter((error) => !allowedErrors.some((pattern) => pattern.test(error))),
        `${label}: console errors and uncaught errors`,
      ).toEqual([])
    }
  })
}

/**
 * Watches the page for `windowMs`: the frames the first remote camera <video> presents, and the app's remote <audio>
 * elements that play a live, unmuted track (a remote track unmutes when its first packets arrive).
 */
function probeRemoteMedia(page: Page, windowMs: number): Promise<MediaProbe> {
  return page.evaluate(async (ms) => {
    const tiles = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="participant-tile"][data-source="camera"]:not([data-local])',
      ),
    ]
    const video = tiles.map((tile) => tile.querySelector('video')).find((element) => element !== null) ?? null
    let frames = 0
    let watching = true
    if (video) {
      const onFrame = () => {
        frames++
        if (watching) video.requestVideoFrameCallback(onFrame)
      }
      video.requestVideoFrameCallback(onFrame)
    }
    await new Promise((resolve) => setTimeout(resolve, ms))
    watching = false

    const elements = [...document.querySelectorAll<HTMLAudioElement>('[data-blinq-audio] audio')]
    const playing = elements.filter(
      (element) =>
        !element.paused &&
        element.srcObject instanceof MediaStream &&
        element.srcObject.getAudioTracks().some((track) => track.readyState === 'live' && !track.muted),
    )
    return {
      tiles: tiles.length,
      video: video ? { width: video.videoWidth, height: video.videoHeight, frames } : null,
      audio: { elements: elements.length, playing: playing.length },
      tile: {
        speaking: tiles.some((tile) => tile.hasAttribute('data-speaking')),
        micOff: tiles.some((tile) => tile.querySelector('[data-testid="tile-mic-off"]') !== null),
      },
    }
  }, windowMs)
}

/**
 * Init script (runs before the app in every page of a participant): keeps every RTCPeerConnection for the ICE
 * statistics (a receiver reports only its own pair) and, for `relayOnly`, allows relay candidates only.
 */
function recordPeerConnections(relayOnly: boolean): void {
  const Original = globalThis.RTCPeerConnection
  if (!Original) return
  const connections: RTCPeerConnection[] = []
  const policy = (configuration?: RTCConfiguration): RTCConfiguration | undefined =>
    relayOnly ? { ...configuration, iceTransportPolicy: 'relay' } : configuration
  class Recorded extends Original {
    constructor(configuration?: RTCConfiguration) {
      super(policy(configuration))
      connections.push(this)
    }

    override setConfiguration(configuration?: RTCConfiguration): void {
      super.setConfiguration(policy(configuration))
    }
  }
  globalThis.RTCPeerConnection = Recorded
  Object.defineProperty(globalThis, '__smokePeerConnections', { value: connections })
}

/** The ICE state of every connected peer connection of the page (publisher and subscriber). */
function iceSummary(page: Page): Promise<IceSummary> {
  return page.evaluate(async () => {
    type Stat = Record<string, unknown>
    const toCandidate = (stat: Stat) => ({
      address: String(stat.address ?? stat.ip),
      port: Number(stat.port),
      protocol: String(stat.protocol),
      candidateType: String(stat.candidateType),
    })
    const connections =
      (globalThis as unknown as { __smokePeerConnections?: RTCPeerConnection[] }).__smokePeerConnections ?? []
    const summary: IceSummary = { sfu: [], selected: [] }
    for (const connection of connections) {
      if (connection.connectionState !== 'connected') continue
      const report = await connection.getStats()
      const stats = [...report.values()] as Stat[]
      summary.sfu.push(
        ...stats.filter((s) => s.type === 'remote-candidate' && s.candidateType === 'host').map(toCandidate),
      )
      // Chromium names the selected pair on the transport; Firefox flags it.
      const transport = stats.find((s) => s.type === 'transport' && typeof s.selectedCandidatePairId === 'string')
      const pair = transport
        ? (report.get(transport.selectedCandidatePairId as string) as Stat | undefined)
        : stats.find((s) => s.type === 'candidate-pair' && s.selected === true)
      const local = pair ? (report.get(pair.localCandidateId as string) as Stat | undefined) : undefined
      const remote = pair ? (report.get(pair.remoteCandidateId as string) as Stat | undefined) : undefined
      if (local && remote) {
        summary.selected.push({ local: toCandidate(local), remote: toCandidate(remote) })
        if (remote.candidateType !== 'host') summary.sfu.push(toCandidate(remote))
      }
    }
    return summary
  })
}

/** Whether an AudioContext can run in the page (it cannot in Firefox without a sound server). */
function webAudioRuns(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const context = new AudioContext()
    // resume() stays pending while the context cannot start.
    await Promise.race([context.resume().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000))])
    const running = context.state === 'running'
    void context.close().catch(() => undefined)
    return running
  })
}

/** Remote audio the page received so far, from the inbound-rtp statistics of its connected peer connections. */
function inboundAudio(page: Page): Promise<InboundAudio> {
  return page.evaluate(async () => {
    const connections =
      (globalThis as unknown as { __smokePeerConnections?: RTCPeerConnection[] }).__smokePeerConnections ?? []
    const total = { packetsReceived: 0, totalSamplesReceived: 0, totalAudioEnergy: 0 }
    for (const connection of connections) {
      if (connection.connectionState !== 'connected') continue
      for (const stat of [...(await connection.getStats()).values()] as Record<string, unknown>[]) {
        if (stat.type !== 'inbound-rtp' || stat.kind !== 'audio') continue
        total.packetsReceived += Number(stat.packetsReceived ?? 0)
        total.totalSamplesReceived += Number(stat.totalSamplesReceived ?? 0)
        total.totalAudioEnergy += Number(stat.totalAudioEnergy ?? 0)
      }
    }
    return total
  })
}

/** Screenshots, console logs and problems of every participant, for the report of a failed test. */
async function attachDiagnostics(participants: Participant[]): Promise<void> {
  for (const { label, page, consoleLog, problems } of participants) {
    const name = label.replace(/\W+/g, '-').replace(/-$/, '')
    const screenshot = await page.screenshot({ fullPage: true, timeout: 5_000 }).catch(() => undefined)
    if (screenshot) await test.info().attach(`${name}.png`, { body: screenshot, contentType: 'image/png' })
    await test.info().attach(`${name}-console.txt`, {
      body: [...consoleLog, '', 'problems:', ...problems.cspViolations, ...problems.errors].join('\n'),
      contentType: 'text/plain',
    })
  }
}
