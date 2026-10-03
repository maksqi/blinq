/**
 * Helpers for the call specs (owner `e2e-flows`). People join through the real meeting page (`flows` fixture); the
 * `/dev/call` harness is left only for the attacker side of the negative E2EE specs, which the product UI cannot
 * express: a client that publishes without encryption, or one that runs with another key.
 *
 * `intruders.open(room, owner, options)` gets a real grant first (`POST /api/join/:slug` with the room's proof and an
 * invite, so the server has a `call_participants` row and the webhooks accept the participant), then opens the harness
 * with that grant in its own context: with `key`, the client encrypts with another room key; with `e2ee: 'off'`, it
 * connects without encryption (test builds only). Teardown leaves the harness call and closes the context.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { expect, test as base } from '../fixtures'
import type { E2eRoom, E2eUser } from '../fixtures/join'
import { waitForPhase } from '../fixtures/livekit'

export { expect }

export interface IntruderOptions {
  name: string
  /** Another room key (base64url) for the harness client. */
  key?: string
  e2ee?: 'on' | 'off'
  camera?: boolean
}

export interface Intruder {
  page: Page
  context: BrowserContext
  identity: string
  name: string
}

export interface IntruderFixture {
  open(room: E2eRoom, owner: E2eUser, options: IntruderOptions): Promise<Intruder>
}

export const test = base.extend<{ intruders: IntruderFixture }>({
  intruders: async ({ browser, rooms, guards, secrets }, use) => {
    const opened: Intruder[] = []
    await use({
      async open(room, owner, options) {
        const join = await rooms.join(
          room,
          { guest: options.name },
          { inviteToken: await rooms.createInvite(room, owner) },
        )
        const grant = await rooms.waitForAdmission(join)
        if (options.key) secrets.track(options.key, 'room key (wrong)')
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
        await guards.watch(context)
        await rooms.useIdentity(context, join)
        const page = await context.newPage()
        const extra = new URLSearchParams({
          ...(options.e2ee === 'off' ? { e2ee: 'off' } : {}),
          ...(options.camera === false ? { cam: '0' } : {}),
        }).toString()
        const path = rooms.harnessPath(options.key ? { ...room, key: options.key } : room, grant, options.name)
        await page.goto(extra ? `${path}&${extra}` : path)
        await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
        await page.getByTestId('join-button').click()
        await waitForPhase(page, 'inCall')
        const intruder = { page, context, identity: grant.identity, name: options.name }
        opened.push(intruder)
        return intruder
      },
    })
    for (const intruder of opened) {
      await intruder.page
        .evaluate(async () => {
          const hooks = (
            window as unknown as { __blinqTest?: { state: { harness?: { leave?: () => Promise<void> } } } }
          ).__blinqTest
          await hooks?.state.harness?.leave?.()
        })
        .catch(() => undefined)
      await intruder.context.close().catch(() => undefined)
    }
  },
})
