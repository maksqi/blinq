/**
 * LiveKit fixtures (owner: call-core, docs/TESTING.md §6.4): `joinAs(role, options)` opens the `/dev/call` harness as
 * a participant of a LiveKit room created for the test.
 *
 * - The room is created with `RoomServiceClient.createRoom` (the server runs with `auto_create: false`) under a unique
 *   name, with room metadata as `publishRoomState` writes it, and deleted on teardown.
 * - Tokens are minted with livekit-server-sdk following the grants and attributes contract in docs/API.md §12
 *   (decision: switch to `buildParticipantToken` from server/services/livekit/token.ts once rooms-backend merges).
 * - K, the epoch and the slug are random per room; K and every token are registered with `secrets.track()`.
 * - Each participant gets its own browser context (or the test's own `page`); `browser: 'firefox' | 'chromium'`
 *   launches the other engine with the same fake-media flags as playwright.config.ts.
 *
 * Helpers for specs: `callState`, `inboundVideo`, `inboundAudio`, `subscriptions`, `waitForRemoteFrames`.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import {
  devices,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test'
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { expect, test as base } from './base'

export type Role = 'host' | 'cohost' | 'participant'
export type Engine = 'chromium' | 'firefox'

export interface TestRoom {
  name: string
  slug: string
  /** Room key K, base64url (43 characters). */
  key: string
  /** Meeting epoch, base64url (22 characters). */
  epoch: string
}

export interface JoinOptions {
  name?: string
  kind?: 'user' | 'guest'
  /** Reuse a room from an earlier joinAs/createRoom in the same test. */
  room?: TestRoom
  /** Launch this engine (default: the project's own browser). */
  browser?: Engine
  /** `off` connects without E2EE (only for the unencrypted-publisher negative test). */
  e2ee?: 'on' | 'off'
  /** Use another room key (wrong-key test). */
  key?: string
  /** Drive the test's own page instead of a new context (keeps the project's device emulation). */
  page?: Page
  /** Click Join and wait for the call (default true). */
  join?: boolean
  /** Wait for the pre-join screen (default true; false for pages that must not reach it). */
  wait?: boolean
  camera?: boolean
  microphone?: boolean
  viewport?: { width: number; height: number }
  /** Extra harness fragment parameters (maxShare, shareFps, title, rec, ...). */
  params?: Record<string, string>
}

export interface JoinedPeer {
  page: Page
  context: BrowserContext
  identity: string
  name: string
  role: Role
  room: TestRoom
  token: string
  /** The harness URL including the fragment (the page strips it on load; navigate here again to rejoin). */
  url: string
}

export interface LiveKitFixtures {
  createRoom: () => Promise<TestRoom>
  joinAs: (role: Role, options?: JoinOptions) => Promise<JoinedPeer>
}

// Same media setup as playwright.config.ts (frozen there; duplicated here for the second engine).
export const CHROMIUM_MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--auto-accept-this-tab-capture',
  '--autoplay-policy=no-user-gesture-required',
]
export const FIREFOX_MEDIA_PREFS = {
  'media.navigator.streams.fake': true,
  'media.navigator.permission.disabled': true,
  'permissions.default.camera': 1,
  'permissions.default.microphone': 1,
  'media.autoplay.default': 0,
}

const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz'
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function randomFrom(alphabet: string, length: number): string {
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Rejection sampling keeps the distribution uniform.
      if (byte < 256 - (256 % alphabet.length) && out.length < length) out += alphabet[byte % alphabet.length]
    }
  }
  return out
}

export function randomSlug(): string {
  const s = randomFrom(SLUG_ALPHABET, 10)
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`
}

export function randomRoomKey(): string {
  return randomBytes(32).toString('base64url')
}

function randomIdentity(): string {
  return `p_${randomFrom(BASE62, 16)}`
}

function publishSources(role: Role): TrackSource[] {
  // docs/API.md §12: hosts and co-hosts may publish everything; participants too while the room policy is
  // "everyone" and their allowances are on (the fixture's default room).
  void role
  return [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
}

/** Launches `engine` with the same fake-media flags or prefs as its project in playwright.config.ts. */
export function launchEngine(playwright: PlaywrightWorkerArgs['playwright'], engine: Engine): Promise<Browser> {
  const type: BrowserType = playwright[engine]
  return type.launch(engine === 'chromium' ? { args: CHROMIUM_MEDIA_ARGS } : { firefoxUserPrefs: FIREFOX_MEDIA_PREFS })
}

/**
 * Context options for a browser of `engine` in a project of `ownEngine`. The test runner applies the project's `use`
 * options (user agent included) to every context, also in another engine: give a second engine its own desktop
 * profile, or the SDK takes Firefox for Chrome.
 */
export function engineContextOptions(engine: Engine, ownEngine: string): BrowserContextOptions {
  if (engine === ownEngine) return {}
  return { ...devices[engine === 'firefox' ? 'Desktop Firefox' : 'Desktop Chrome'] }
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (!value) throw new Error(`${name} is not set. Run E2E with sh scripts/e2e.sh (docs/TESTING.md §6.2).`)
  return value
}

export const test = base.extend<LiveKitFixtures>({
  createRoom: async ({ secrets }, use) => {
    const service = new RoomServiceClient(
      env('LIVEKIT_URL', 'http://127.0.0.1:7880'),
      env('LIVEKIT_API_KEY'),
      env('LIVEKIT_API_SECRET'),
    )
    const created: string[] = []
    await use(async () => {
      const room: TestRoom = {
        name: randomUUID(),
        slug: randomSlug(),
        key: randomRoomKey(),
        epoch: randomBytes(16).toString('base64url'),
      }
      secrets.track(room.key, 'room key')
      const metadata = {
        v: 1,
        epoch: room.epoch,
        locked: false,
        waitingRoom: false,
        screenSharePolicy: 'everyone',
        allowSelfUnmute: true,
        chatEnabled: true,
        recording: null,
      }
      await service.createRoom({
        name: room.name,
        emptyTimeout: 120,
        departureTimeout: 10,
        maxParticipants: 25,
        metadata: JSON.stringify(metadata),
      })
      created.push(room.name)
      return room
    })
    for (const name of created) await service.deleteRoom(name).catch(() => undefined)
  },

  joinAs: async ({ browser, playwright, createRoom, guards, secrets }, use, testInfo) => {
    const baseURL = String(testInfo.project.use.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080')
    const livekitUrl = process.env.LIVEKIT_PUBLIC_URL ?? baseURL.replace(/^http/, 'ws')
    const apiKey = env('LIVEKIT_API_KEY')
    const apiSecret = env('LIVEKIT_API_SECRET')
    const ownEngine = browser.browserType().name() as Engine
    const launched = new Map<Engine, Browser>()
    const contexts: BrowserContext[] = []
    const joinedPages: Page[] = []

    async function browserFor(engine: Engine): Promise<Browser> {
      if (engine === ownEngine) return browser
      const existing = launched.get(engine)
      if (existing) return existing
      const other = await launchEngine(playwright, engine)
      launched.set(engine, other)
      return other
    }

    // joinAs peers have no call_participants rows, so in-call API requests made by Wave 2 features (people and
    // waiting-room lists for moderators) answer 403 CALL_NOT_PARTICIPANT. Specs that need the server use `rooms`.
    guards.allowConsoleError(/status of 403 \(Forbidden\)[\s\S]*\/api\/calls\//)
    await use(async (role, options = {}) => {
      const room = options.room ?? (await createRoom())
      const identity = randomIdentity()
      const name = options.name ?? `${role[0]!.toUpperCase()}${role.slice(1)} ${identity.slice(2, 6)}`
      const token = new AccessToken(apiKey, apiSecret, {
        identity,
        name,
        ttl: '5m',
        attributes: { role, kind: options.kind ?? 'user', hand: '', vol: '100' },
      })
      token.addGrant({
        roomJoin: true,
        room: room.name,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: false,
        canPublish: true,
        canPublishSources: publishSources(role),
      })
      const jwt = await token.toJwt()
      secrets.track(jwt, 'LiveKit token')
      const key = options.key ?? room.key
      if (options.key) secrets.track(options.key, 'room key (wrong)')

      let page = options.page
      let context: BrowserContext
      if (page) {
        context = page.context()
        if (options.viewport) await page.setViewportSize(options.viewport)
      } else {
        const engine = options.browser ?? ownEngine
        const target = await browserFor(engine)
        context = await target.newContext({
          ...engineContextOptions(engine, ownEngine),
          baseURL,
          viewport: options.viewport ?? { width: 1280, height: 720 },
        })
        contexts.push(context)
        await guards.watch(context)
        page = await context.newPage()
      }

      const fragment = new URLSearchParams({
        url: livekitUrl,
        token: jwt,
        k: key,
        epoch: room.epoch,
        slug: room.slug,
        name,
        ...(options.e2ee === 'off' ? { e2ee: 'off' } : {}),
        ...(options.camera === false ? { cam: '0' } : {}),
        ...(options.microphone === false ? { mic: '0' } : {}),
        ...options.params,
      })
      const url = new URL(`/dev/call#${fragment.toString()}`, baseURL).toString()
      await page.goto(url)
      if (options.wait !== false) await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
      if (options.wait !== false && options.join !== false) {
        await page.getByTestId('join-button').click()
        await waitForPhase(page, 'inCall')
      }
      joinedPages.push(page)
      return { page, context, identity, name, role, room, token: jwt, url }
    })

    // Leave gracefully first: tearing down a live connection makes the SDK log data-channel errors (Firefox).
    for (const joined of joinedPages) {
      await joined
        .evaluate(async () => {
          const hooks = (
            window as unknown as { __blinqTest?: { state: { harness?: { leave?: () => Promise<void> } } } }
          ).__blinqTest
          await hooks?.state.harness?.leave?.()
        })
        .catch(() => undefined)
    }
    for (const context of contexts) await context.close().catch(() => undefined)
    for (const other of launched.values()) await other.close().catch(() => undefined)
  },
})

// ---- Helpers ------------------------------------------------------------------------------------------------------

export interface CallStateSnapshot {
  phase: string
  phaseHistory: string[]
  identity: string | null
  e2eeEnabled: boolean
  badge: string
  blocked: string[]
  undecryptable: string[]
  media: { micOn: boolean; cameraOn: boolean }
  screenShare: { active: boolean }
  participants: Array<{
    identity: string
    micEnabled: boolean
    cameraEnabled: boolean
    screenSharing: boolean
    mediaEncrypted: boolean
  }>
  safetyCode: string | null
}

export interface InboundVideo {
  identity: string
  source: string
  trackSid: string
  frameWidth: number
  frameHeight: number
  framesDecoded: number
  framesReceived: number
  packetsReceived: number
  bytesReceived: number
}

export interface InboundAudio {
  identity: string
  source: string
  trackSid: string
  audioLevel: number
  totalAudioEnergy: number
  packetsReceived: number
}

export interface SubscriptionEntry {
  identity: string
  source: string
  subscribed: boolean
  enabled: boolean
  blocked: boolean
  width?: number
  height?: number
}

async function hookState<T>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate((name) => {
    const hooks = (window as unknown as { __blinqTest?: { state: Record<string, unknown> } }).__blinqTest
    const value = hooks?.state[name]
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  }, key) as Promise<T | undefined>
}

export async function callState(page: Page): Promise<CallStateSnapshot | undefined> {
  return hookState<CallStateSnapshot>(page, 'call')
}

export async function waitForPhase(page: Page, phase: string, timeout = 20_000): Promise<void> {
  await expect.poll(async () => (await callState(page))?.phase, { timeout, message: `call phase ${phase}` }).toBe(phase)
}

/** Remote video tracks this page receives, by source, for one publisher. */
export async function inboundVideo(page: Page, identity?: string, source = 'camera'): Promise<InboundVideo[]> {
  const all = (await hookState<Record<string, InboundVideo>>(page, 'inboundVideo')) ?? {}
  return Object.values(all).filter((v) => (!identity || v.identity === identity) && v.source === source)
}

export async function inboundAudio(page: Page, identity?: string): Promise<InboundAudio[]> {
  const all = (await hookState<Record<string, InboundAudio>>(page, 'inboundAudio')) ?? {}
  return Object.values(all).filter((a) => !identity || a.identity === identity)
}

export async function subscriptions(page: Page, identity?: string): Promise<SubscriptionEntry[]> {
  const all = (await hookState<Record<string, SubscriptionEntry>>(page, 'subscriptions')) ?? {}
  return Object.values(all).filter((s) => !identity || s.identity === identity)
}

/** Waits until `page` has decoded at least `minFrames` more frames of `identity`'s camera than when called. */
export async function waitForRemoteFrames(
  page: Page,
  identity: string,
  minFrames = 10,
  timeout = 20_000,
): Promise<number> {
  let start: number | undefined
  let latest = 0
  await expect
    .poll(
      async () => {
        const [video] = await inboundVideo(page, identity)
        latest = video?.framesDecoded ?? 0
        if (start === undefined && video) start = latest
        return start === undefined ? 0 : latest - start
      },
      { timeout, message: `decoded frames of ${identity}` },
    )
    .toBeGreaterThanOrEqual(minFrames)
  return latest
}
