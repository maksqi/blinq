/**
 * Shared helpers for the Stage 06 collaboration specs (owner: collab-ui).
 *
 * Every peer is a real participant: users and rooms come from the DB-backed `rooms` fixture, joins go through
 * `POST /api/join/:slug` (and the waiting room when the room has one), and each peer opens the `/dev/call` harness in
 * its own browser context with its session or guest cookie, so in-call APIs see real `call_participants` rows.
 *
 *   const { host, room, call } = await collab.meeting({ waitingRoom: false })
 *   const ana = await collab.addUser(room, call, { name: 'Ana' })
 *   await openPanel(call.page, 'participants')
 *   await participantAction(call.page, ana.identity, 'mute-microphone')
 */
import type { BrowserContext, Page } from '@playwright/test'
import { expect, test as base } from '../fixtures'
import { callState, waitForPhase } from '../fixtures/livekit'
import type { E2eRoom, E2eUser, JoinResult, RoomSettingsInput } from '../fixtures/join'

export { expect }

export interface PeerView {
  identity: string
  name: string
  role: 'host' | 'cohost' | 'participant'
  kind: 'user' | 'guest'
  isLocal: boolean
  micEnabled: boolean
  cameraEnabled: boolean
  screenSharing: boolean
  handRaisedAt: number | null
  volumeForEveryone: number
  mediaEncrypted: boolean
}

export interface CallPeer {
  page: Page
  context: BrowserContext
  identity: string
  name: string
  join: JoinResult
  user?: E2eUser
}

export interface Meeting {
  host: E2eUser
  room: E2eRoom
  /** The host in the call. */
  call: CallPeer
}

export interface OpenOptions {
  viewport?: { width: number; height: number }
  /** Join with the camera off (lighter for peers that only observe). */
  camera?: boolean
  microphone?: boolean
  /** Drive this page instead of a new context (keeps the project's device emulation). */
  page?: Page
  /** A test-only init script for the new context (runs before the app on every navigation). */
  init?: () => void
}

export interface CollabFixture {
  /** A host with an account, a room (`settings` as in `POST /api/rooms`) and the host in the call. */
  meeting(settings?: Partial<RoomSettingsInput>, options?: OpenOptions & { hostName?: string }): Promise<Meeting>
  /** A signed-in user with an invite, admitted (by `admitter` when the room has a waiting room) and in the call. */
  addUser(
    room: E2eRoom,
    admitter: CallPeer,
    options?: OpenOptions & { name?: string; user?: E2eUser },
  ): Promise<CallPeer>
  /** A guest with an invite, admitted and in the call. */
  addGuest(room: E2eRoom, admitter: CallPeer, options?: OpenOptions & { name?: string }): Promise<CallPeer>
  /** Opens the harness for an admitted join, clicks Join and waits for the call. */
  open(room: E2eRoom, join: JoinResult, name: string, options?: OpenOptions): Promise<CallPeer>
}

/** The fixture's own host user for a peer (the admitter of later joins). */
const hostUsers = new WeakMap<CallPeer, E2eUser>()

export const test = base.extend<{ collab: CollabFixture }>({
  collab: async ({ browser, rooms, guards }, use, testInfo) => {
    const baseURL = String(testInfo.project.use.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080')
    const contexts: BrowserContext[] = []
    const pages: Page[] = []

    async function open(room: E2eRoom, join: JoinResult, name: string, options: OpenOptions = {}): Promise<CallPeer> {
      if (!join.grant) throw new Error('open() needs an admitted join')
      let page = options.page
      let context: BrowserContext
      if (page) {
        context = page.context()
        if (options.viewport) await page.setViewportSize(options.viewport)
      } else {
        context = await browser.newContext({ baseURL, viewport: options.viewport ?? { width: 1280, height: 800 } })
        contexts.push(context)
        await guards.watch(context)
        if (options.init) await context.addInitScript(options.init)
        page = await context.newPage()
      }
      await rooms.useIdentity(context, join)
      const extra = new URLSearchParams({
        ...(options.camera === false ? { cam: '0' } : {}),
        ...(options.microphone === false ? { mic: '0' } : {}),
      }).toString()
      await page.goto(rooms.harnessPath(room, join.grant, name) + (extra ? `&${extra}` : ''))
      await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
      await page.getByTestId('join-button').click()
      await waitForPhase(page, 'inCall')
      pages.push(page)
      return { page, context, identity: join.grant.identity, name, join }
    }

    async function admitted(room: E2eRoom, admitter: CallPeer, join: JoinResult): Promise<JoinResult> {
      if (join.status === 'admitted') return join
      const moderator = hostUsers.get(admitter) ?? admitter.user
      if (!moderator) throw new Error('the admitter must be a user with an account')
      await rooms.admit(room, moderator, join.requestId!)
      await rooms.waitForAdmission(join)
      return join
    }

    const fixture: CollabFixture = {
      async meeting(settings = {}, options = {}) {
        const host = await rooms.createUser({ displayName: options.hostName ?? 'Hana Host' })
        const room = await rooms.createRoom(host, settings)
        const join = await rooms.join(room, host)
        const call = await open(room, join, host.displayName, options)
        call.user = host
        hostUsers.set(call, host)
        return { host, room, call }
      },
      async addUser(room, admitter, options = {}) {
        const user = options.user ?? (await rooms.createUser({ displayName: options.name ?? 'Ana User' }))
        const moderator = hostUsers.get(admitter) ?? admitter.user
        if (!moderator) throw new Error('the admitter must be a user with an account')
        const inviteToken = await rooms.createInvite(room, moderator)
        const join = await admitted(room, admitter, await rooms.join(room, user, { inviteToken }))
        const peer = await open(room, join, user.displayName, options)
        peer.user = user
        return peer
      },
      async addGuest(room, admitter, options = {}) {
        const moderator = hostUsers.get(admitter) ?? admitter.user
        if (!moderator) throw new Error('the admitter must be a user with an account')
        const name = options.name ?? 'Gil Guest'
        const inviteToken = await rooms.createInvite(room, moderator)
        const join = await admitted(room, admitter, await rooms.join(room, { guest: name }, { inviteToken }))
        return open(room, join, name, options)
      },
      open,
    }

    await use(fixture)

    // Leave gracefully first: tearing down a live connection makes the SDK log data-channel errors (Firefox).
    for (const page of pages) {
      await page
        .evaluate(async () => {
          const hooks = (
            window as unknown as { __blinqTest?: { state: { harness?: { leave?: () => Promise<void> } } } }
          ).__blinqTest
          await hooks?.state.harness?.leave?.()
        })
        .catch(() => undefined)
    }
    for (const context of contexts) await context.close().catch(() => undefined)
  },
})

// ---- State --------------------------------------------------------------------------------------------------------

/** How `page` currently sees `identity` (call-core's projection in `window.__blinqTest.state.call`). */
export async function viewOf(page: Page, identity: string): Promise<PeerView | undefined> {
  const state = (await callState(page)) as unknown as { participants?: PeerView[] } | undefined
  return state?.participants?.find((p) => p.identity === identity)
}

export async function roomStateOf(page: Page): Promise<Record<string, unknown> | null | undefined> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __blinqTest?: { state: Record<string, unknown> } }).__blinqTest
    const value = hooks?.state.roomState
    return value === undefined || value === null ? (value as null | undefined) : JSON.parse(JSON.stringify(value))
  })
}

export async function phaseOf(page: Page): Promise<string | undefined> {
  return (await callState(page))?.phase
}

/** Polls quickly: a 1 s budget must not be eaten by the default back-off. */
export const FAST: { intervals: number[] } = { intervals: [50] }

/** `expect.poll` with a 1 s budget (host action → peer). */
export function within1s<T>(probe: () => Promise<T>, message: string) {
  return expect.poll(probe, { timeout: 1_000, message, ...FAST })
}

// ---- UI -----------------------------------------------------------------------------------------------------------

export const PANEL_TITLES: Record<string, string> = {
  participants: 'People',
  lobby: 'Waiting room',
  chat: 'Chat',
}

export function panelTestId(id: string): string {
  return id === 'participants' ? 'participants-panel' : `${id}-panel`
}

/** Overlay contents that are still animating out (they keep focus traps and the Escape layer until they unmount). */
const CLOSING =
  '[data-state="closed"]:is([data-slot="popover-content"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],[data-slot="sheet-content"],[data-slot="dropdown-menu-content"])'

/** Waits until no menu, popover or dialog is still closing (fast test input would otherwise race their focus return). */
export async function settle(page: Page): Promise<void> {
  await expect(page.locator(CLOSING)).toHaveCount(0)
}

/** Opens a side panel: its control-bar toggle on wide screens, the More menu on narrow ones. */
export async function openPanel(page: Page, id: string): Promise<void> {
  const content = page.getByTestId(panelTestId(id))
  await settle(page)
  if (await content.isVisible()) return
  const toggle = page.locator(`button[data-panel="${id}"]`)
  if (await toggle.isVisible()) {
    await toggle.click()
  } else {
    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('menuitem', { name: PANEL_TITLES[id] ?? id }).click()
  }
  await expect(content).toBeVisible()
}

export async function closePanel(page: Page, id: string): Promise<void> {
  const content = page.getByTestId(panelTestId(id))
  await settle(page)
  if (!(await content.isVisible())) return
  // Wide screens show the panel in an aside next to the video; narrower ones in a sheet (closed with Escape).
  if (await page.locator(`aside[data-panel="${id}"]`).isVisible())
    await page.locator(`button[data-panel="${id}"]`).click()
  else await page.keyboard.press('Escape')
  await expect(content).toBeHidden()
}

export function participantRow(page: Page, identity: string) {
  return page.getByTestId('participants-panel').locator(`[data-testid="participant-row"][data-identity="${identity}"]`)
}

/** The open moderation menu. */
export function actionsMenu(page: Page) {
  return page.locator('[data-testid="participant-actions-menu"][data-state="open"]')
}

/** Opens the people panel and the moderation menu of `identity`. */
export async function openActions(page: Page, identity: string): Promise<void> {
  await openPanel(page, 'participants')
  await participantRow(page, identity).getByTestId('participant-actions').click()
  await expect(actionsMenu(page)).toBeVisible()
}

/** Runs a moderation menu item (`data-action`, e.g. `mute-microphone`) on `identity`. */
export async function participantAction(page: Page, identity: string, action: string): Promise<void> {
  await openActions(page, identity)
  await actionsMenu(page).locator(`[data-action="${action}"]`).click()
}

/** Menu item ids offered for `identity` (closes the menu again). */
export async function menuActions(page: Page, identity: string): Promise<string[]> {
  await openActions(page, identity)
  const ids = await actionsMenu(page)
    .locator('[data-action]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-action') ?? ''))
  await page.keyboard.press('Escape')
  await expect(actionsMenu(page)).toBeHidden()
  await settle(page)
  return ids
}

/** Presses Escape and waits until the closed overlay is gone. */
export async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await settle(page)
}

export async function openHostControls(page: Page): Promise<void> {
  const panel = page.getByTestId('host-controls')
  await settle(page)
  if (await panel.isVisible()) return
  await page.locator('[data-control="host-controls"]').click()
  await expect(panel).toBeVisible()
}

/** Flips a live-setting switch in the host controls (`locked`, `waitingRoom`, `allowSelfUnmute`, `chatEnabled`). */
export async function toggleSetting(page: Page, key: string): Promise<void> {
  await openHostControls(page)
  await page.getByTestId(`setting-${key}`).click()
}

export function micButton(page: Page) {
  return page.locator('[data-control="microphone"]').getByRole('button', { name: 'Microphone', exact: true })
}

export function cameraButton(page: Page) {
  return page.locator('[data-control="camera"]').getByRole('button', { name: 'Camera', exact: true })
}

/** Toast text anywhere on the page (vue-sonner). */
export function toastWith(page: Page, text: string | RegExp) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text })
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}
