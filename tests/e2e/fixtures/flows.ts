/**
 * Real-flow fixtures (Wave 3, owner `e2e-flows`): accounts signed in with a session cookie, rooms and invites through
 * the API, and every participant in the product UI at `/m/<slug>` (pre-join, waiting room, call) instead of the
 * `/dev/call` harness. Built on the `rooms` fixture (join.ts) and tests/e2e/join/support.ts; still runs against
 * `pnpm build:test`, so `window.__blinqTest` has the stats hooks (`state.join`, `state.call`, `inboundVideo`, …).
 *
 *   test('a guest joins through the waiting room', async ({ flows }) => {
 *     const { host, room } = await flows.meeting({ waitingRoom: true })     // host signed in, in the call
 *     const guest = await flows.openAsGuest(await flows.inviteLink(room), { browser: 'firefox' })
 *     await flows.askToJoin(guest, { name: 'Gus Guest' })                   // waiting room
 *     await flows.admit('Gus Guest')                                         // the host's lobby panel
 *     await flows.waitForCall(guest)                                         // state.join + state.call: inCall
 *   })
 *
 * - `loginAs(role)`: a new account (`admin` for an admin; `host` and `user` are plain users, `host` becomes the default
 *   room owner) with a DB session, in a new browser context or in the test's own `page` (keeps the project's device
 *   emulation). `browser: 'firefox' | 'chromium'` opens the context in the other engine (same fake-media setup).
 * - `createRoom(settings)` and `inviteLink(room)`: `POST /api/rooms` (K, slug and proof made in Node) and
 *   `POST /api/rooms/:id/invites` as the room owner.
 * - `open(actor, link)` and `openAsGuest(link)`: a meeting link up to pre-join. Every browser request shares the e2e
 *   Caddy's IP, so this books the `join-ip` budget first (join/support.ts).
 * - `enterCall`, `askToJoin`, `admit(requestName)` (the host's lobby panel when the host is in the call in a page of
 *   this fixture, else the API), `waitForCall`, `leave`; `meeting()` and `joinAsGuest()` combine them.
 * - Teardown leaves every call gracefully (a torn-down connection makes the SDK log errors), then closes the contexts
 *   and browsers it opened.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { openToPrejoin, pressJoin } from '../join/support'
import { expect } from './base'
import { test as roomsTest, type E2eRoom, type E2eUser, type RoomSettingsInput } from './join'
import { callState, engineContextOptions, launchEngine, waitForPhase, type Engine } from './livekit'

export type AccountRole = 'host' | 'user' | 'admin'

export interface ActorOptions {
  /** Open the context in this engine (default: the project's own browser). */
  browser?: Engine
  /** Drive this page instead of a new context (the test's own `page` keeps the project's device emulation). */
  page?: Page
  viewport?: { width: number; height: number }
  /** A test-only init script for a new context (runs before the app on every navigation). */
  init?: () => void
}

export interface Actor {
  page: Page
  context: BrowserContext
  /** Display name: the account's, or the guest name typed on pre-join. */
  name: string
  /** The account of a signed-in actor; guests have none. */
  account?: E2eUser
  /** LiveKit identity, once in the call. */
  identity?: string
}

export interface SignedIn extends Actor {
  account: E2eUser
}

export interface InCall extends Actor {
  identity: string
}

/** `window.__blinqTest.state.join` (rooms-ui) without its `leave()` function. */
export interface JoinStateSnapshot {
  phase: string
  problem: string | null
  notice: string | null
  requestId: string | null
  duplicate: boolean
}

export interface FlowsFixture {
  /** A new account with a session, signed in in a new context (or `options.page`). */
  loginAs(role: AccountRole, options?: ActorOptions & { name?: string }): Promise<SignedIn>
  /** `POST /api/rooms` as `owner` (default: the last `loginAs('host')`). */
  createRoom(settings?: Partial<RoomSettingsInput> & { owner?: SignedIn | E2eUser }): Promise<E2eRoom>
  /** A new room invite link `/m/<slug>#k=…&t=…`, created by the room owner (or `by`). */
  inviteLink(room: E2eRoom, options?: { by?: SignedIn | E2eUser; maxUses?: number | null }): Promise<string>
  /** Opens a meeting link in the actor's page and waits for pre-join. */
  open(actor: Actor, link: string): Promise<void>
  /** A guest (no account) in a new context (or `options.page`) on the pre-join screen of `link`. */
  openAsGuest(link: string, options?: ActorOptions & { name?: string }): Promise<Actor>
  /**
   * A tracked context without a fixture account, at `about:blank` (for people who sign in or register through the UI);
   * teardown leaves its call like any other.
   */
  newActor(options?: ActorOptions & { name?: string }): Promise<Actor>
  /** Presses Join (typing the name when pre-join asks for one) and waits for the call. */
  enterCall(actor: Actor, options?: { name?: string }): Promise<InCall>
  /** Presses "Ask to join" and waits for the waiting room. Returns the request id. */
  askToJoin(actor: Actor, options?: { name?: string }): Promise<string>
  /**
   * Admits the waiting request of `requestName` in `room` (default: the last room of this fixture): through the lobby
   * panel of the moderator's page when it is in the call in this fixture (or `by`), otherwise through the API.
   */
  admit(requestName: string, options?: { room?: E2eRoom; by?: Actor; via?: 'ui' | 'api' }): Promise<void>
  /** Waits until `state.join.phase` and `state.call.phase` are `inCall`; returns the actor with its identity. */
  waitForCall(actor: Actor, timeout?: number): Promise<InCall>
  /** A host account, a room (`waitingRoom: false` unless given) and the host in the call. */
  meeting(
    settings?: Partial<RoomSettingsInput>,
    options?: ActorOptions & { hostName?: string },
  ): Promise<{ host: SignedIn & InCall; room: E2eRoom }>
  /** A guest with a new invite in the call (admitted by the host when the room has a waiting room). */
  joinAsGuest(room: E2eRoom, options?: ActorOptions & { name?: string }): Promise<InCall>
  /** Leaves the call gracefully (no-op outside a call). */
  leave(actor: Actor): Promise<void>
}

const DEFAULT_NAMES: Record<AccountRole, string> = { host: 'Hana Host', user: 'Uma User', admin: 'Ada Admin' }

/** The engine a cross-browser test pairs with the project's own. */
export function otherEngine(browserName: string): Engine {
  return browserName === 'chromium' ? 'firefox' : 'chromium'
}

export async function joinState(page: Page): Promise<JoinStateSnapshot | undefined> {
  return page.evaluate(() => {
    const hooks = (window as unknown as { __blinqTest?: { state: Record<string, unknown> } }).__blinqTest
    const value = hooks?.state.join
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as JoinStateSnapshot)
  })
}

/** `phase`, or `error:<code>` for a join problem, so a failed wait says why. */
async function joinPhase(page: Page): Promise<string | undefined> {
  const state = await joinState(page)
  if (!state) return undefined
  return state.phase === 'error' ? `error:${state.problem ?? 'unknown'}` : state.phase
}

/** The `performance.mark` timestamps of the join (`blinq:join:click`, `…:connected`, `…:first-remote-frame`). */
export function joinMetrics(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () => (window as unknown as { __blinqTest: { metrics: Record<string, number> } }).__blinqTest.metrics,
  )
}

/** Opens the waiting-room panel of a moderator in the call (control-bar toggle, or the More menu on narrow screens). */
async function openLobbyPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('lobby-panel')
  if (await panel.isVisible()) return
  const toggle = page.locator('button[data-panel="lobby"]')
  if (await toggle.isVisible()) {
    await toggle.click()
  } else {
    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('menuitem', { name: 'Waiting room' }).click()
  }
  await expect(panel).toBeVisible()
}

/** The name to type on pre-join: only guests are asked for one (signed-in people join with their profile name). */
async function guestName(actor: Actor): Promise<string | undefined> {
  const field = actor.page.getByLabel('Your name')
  return (await field.count()) > 0 ? actor.name : undefined
}

function accountOf(who: SignedIn | E2eUser): E2eUser {
  return 'account' in who ? who.account : who
}

export const test = roomsTest.extend<{ flows: FlowsFixture }>({
  // `page` is a dependency so that its teardown runs after this fixture leaves the calls in it.
  flows: async ({ browser, playwright, rooms, guards, page: _page }, use, testInfo) => {
    const baseURL = String(testInfo.project.use.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080')
    const ownEngine = browser.browserType().name()
    const launched = new Map<Engine, Browser>()
    const contexts: BrowserContext[] = []
    const actors: Actor[] = []
    const owners = new Map<string, E2eUser>()
    let lastHost: SignedIn | undefined
    let lastRoom: E2eRoom | undefined

    async function browserFor(engine: Engine): Promise<Browser> {
      if (engine === ownEngine) return browser
      let other = launched.get(engine)
      if (!other) {
        other = await launchEngine(playwright, engine)
        launched.set(engine, other)
      }
      return other
    }

    async function actorPage(options: ActorOptions): Promise<{ page: Page; context: BrowserContext }> {
      if (options.page) {
        if (options.viewport) await options.page.setViewportSize(options.viewport)
        return { page: options.page, context: options.page.context() }
      }
      const engine = options.browser ?? (ownEngine as Engine)
      const target = await browserFor(engine)
      const context = await target.newContext({
        ...engineContextOptions(engine, ownEngine),
        baseURL,
        viewport: options.viewport ?? { width: 1280, height: 720 },
      })
      contexts.push(context)
      await guards.watch(context)
      if (options.init) await context.addInitScript(options.init)
      return { page: await context.newPage(), context }
    }

    async function waitForCall(actor: Actor, timeout = 20_000): Promise<InCall> {
      await expect
        .poll(() => joinPhase(actor.page), { timeout, message: `${actor.name} reaches the call` })
        .toBe('inCall')
      await waitForPhase(actor.page, 'inCall', timeout)
      const identity = (await callState(actor.page))?.identity
      if (!identity) throw new Error(`${actor.name} is in the call without an identity`)
      actor.identity = identity
      return actor as InCall
    }

    async function admitViaApi(room: E2eRoom, requestName: string): Promise<void> {
      const owner = owners.get(room.id)
      if (!owner) throw new Error('admit() through the API needs a room created by this fixture')
      let requestId: string | undefined
      await expect
        .poll(
          async () => {
            const res = await rooms.callApi(owner, room, 'GET', '/lobby')
            const items = (res.body as { items?: Array<{ requestId: string; displayName: string }> }).items ?? []
            requestId = items.find((item) => item.displayName === requestName)?.requestId
            return requestId ?? null
          },
          { message: `${requestName} is waiting` },
        )
        .not.toBeNull()
      await rooms.admit(room, owner, requestId!)
    }

    const fixture: FlowsFixture = {
      async loginAs(role, options = {}) {
        const account = await rooms.createUser({
          role: role === 'admin' ? 'admin' : 'user',
          displayName: options.name ?? DEFAULT_NAMES[role],
        })
        const { page, context } = await actorPage(options)
        await rooms.useIdentity(context, account)
        const actor: SignedIn = { page, context, name: account.displayName, account }
        actors.push(actor)
        if (role === 'host') lastHost = actor
        return actor
      },

      async createRoom(settings = {}) {
        const { owner, ...rest } = settings
        const account = owner ? accountOf(owner) : lastHost?.account
        if (!account) throw new Error('createRoom() needs an owner: call loginAs("host") first or pass `owner`')
        const room = await rooms.createRoom(account, rest)
        owners.set(room.id, account)
        lastRoom = room
        return room
      },

      async inviteLink(room, options = {}) {
        const by = options.by ? accountOf(options.by) : owners.get(room.id)
        if (!by) throw new Error('inviteLink() needs `by` for a room this fixture did not create')
        const token = await rooms.createInvite(room, by, { maxUses: options.maxUses ?? null })
        return rooms.inviteLink(room, token)
      },

      async open(actor, link) {
        await openToPrejoin(actor.page, link)
      },

      async openAsGuest(link, options = {}) {
        const actor = await fixture.newActor({ ...options, name: options.name ?? 'Gus Guest' })
        await fixture.open(actor, link)
        return actor
      },

      async newActor(options = {}) {
        const { page, context } = await actorPage(options)
        const actor: Actor = { page, context, name: options.name ?? '' }
        actors.push(actor)
        return actor
      },

      async enterCall(actor, options = {}) {
        if (options.name) actor.name = options.name
        await pressJoin(actor.page, await guestName(actor))
        return waitForCall(actor)
      },

      async askToJoin(actor, options = {}) {
        if (options.name) actor.name = options.name
        await expect(actor.page.getByTestId('join-button')).toHaveText(/Ask to join/)
        await pressJoin(actor.page, await guestName(actor))
        await expect.poll(() => joinPhase(actor.page), { message: `${actor.name} waits` }).toBe('waiting')
        await expect(actor.page.getByTestId('waiting-room')).toBeVisible()
        const requestId = (await joinState(actor.page))?.requestId
        if (!requestId) throw new Error(`${actor.name} waits without a request id`)
        return requestId
      },

      async admit(requestName, options = {}) {
        const room = options.room ?? (options.by ? undefined : lastRoom)
        const owner = room ? owners.get(room.id) : undefined
        const moderator =
          options.by ??
          actors.find(
            (actor) =>
              actor.identity !== undefined &&
              actor.account?.id === owner?.id &&
              !actor.page.isClosed() &&
              new URL(actor.page.url()).pathname === `/m/${room?.slug}`,
          )
        if (options.via === 'api' || !moderator) {
          if (!room) throw new Error('admit() needs a room: create one with this fixture or pass `room` or `by`')
          await admitViaApi(room, requestName)
          return
        }
        await openLobbyPanel(moderator.page)
        const entry = moderator.page.getByTestId('lobby-entry').filter({ hasText: requestName })
        await expect(entry).toHaveCount(1)
        await entry.getByTestId('lobby-admit').click()
        await expect(entry).toHaveCount(0)
      },

      waitForCall,

      async meeting(settings = {}, options = {}) {
        const { hostName, ...actorOptions } = options
        const host = await fixture.loginAs('host', { ...actorOptions, name: hostName })
        const room = await fixture.createRoom({ waitingRoom: false, ...settings, owner: host })
        await fixture.open(host, room.link)
        await fixture.enterCall(host)
        return { host: host as SignedIn & InCall, room }
      },

      async joinAsGuest(room, options = {}) {
        const guest = await fixture.openAsGuest(await fixture.inviteLink(room), options)
        await pressJoin(guest.page, await guestName(guest))
        await expect
          .poll(() => joinPhase(guest.page), { timeout: 20_000, message: `${guest.name} joins` })
          .toMatch(/^(inCall|waiting)$/)
        if ((await joinPhase(guest.page)) === 'waiting') await fixture.admit(guest.name, { room })
        return waitForCall(guest)
      },

      async leave(actor) {
        if (actor.page.isClosed()) return
        await actor.page
          .evaluate(async () => {
            const hooks = (window as unknown as { __blinqTest?: { state: { join?: { leave?: () => Promise<void> } } } })
              .__blinqTest
            await hooks?.state.join?.leave?.()
          })
          .catch(() => undefined)
      },
    }

    await use(fixture)

    for (const actor of actors) await fixture.leave(actor)
    for (const context of contexts) await context.close().catch(() => undefined)
    for (const other of launched.values()) await other.close().catch(() => undefined)
  },
})
