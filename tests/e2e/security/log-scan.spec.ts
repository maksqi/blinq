import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { e2eLogFile, findLeaks, type Leak, type LogName } from '../fixtures/base'
import type { E2eUser } from '../fixtures/join'
import { waitForPhase } from '../fixtures/livekit'
import { startRecording, stopRecording } from '../fixtures/recording'
import { closeE2eDb, createUser as createPasswordUser, strongPassword, tokenLink, uniqueEmail, waitForMail } from '../auth/support'
import { openPanel } from '../collab/helpers'
import { HTTP_ERROR_CONSOLE, leaveCalls, newWatchedContext, openToPrejoin, pressJoin, waitingRequestId } from '../join/support'

// Stage 10 DoD (docs/SECURITY.md §8): after a realistic flow, no secret appears in the app, Caddy, LiveKit or Postgres
// logs. The flow covers a failed and a successful sign-in, a room with a waiting room, an invite, a guest admitted
// through the waiting-room stream, chat, a server recording, an account invite, a password reset and sign-out. Every
// secret it produces is tracked (passwords, session and guest cookies, room key, join proof, invite and account
// tokens, LiveKit tokens) together with the secrets of the E2E environment; the generic patterns of the base fixture
// (JWTs, unredacted access_token=, #k=, #t=, link fragments, cookies, password fields) apply to every line.
// scripts/e2e.sh runs the app with LOG_LEVEL=debug; the base fixture scans app and Caddy logs after every test too.

const LIVEKIT_CONTAINER = 'blinq-dev-livekit-1'
const POSTGRES_CONTAINER = 'blinq-dev-postgres-1'
const ENV_SECRETS = ['APP_SECRET', 'LIVEKIT_API_SECRET', 'RECORDING_ENCRYPTION_KEY', 'ADMIN_PASSWORD', 'SMTP_PASSWORD']

function publicOrigin(): string {
  return new URL(process.env.PUBLIC_URL ?? process.env.E2E_BASE_URL ?? 'http://localhost:8080').origin
}

function uniqueIp(): string {
  return `2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`
}

/** Log output of a container since `since` (stdout and stderr). */
function containerLogs(name: string, since: Date): string {
  const result = spawnSync('docker', ['logs', '--since', since.toISOString(), name], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`docker logs ${name} failed: ${result.stderr}`)
  return `${result.stdout}\n${result.stderr}`
}

function readSince(name: LogName, offset: number): string {
  return readFileSync(e2eLogFile(name)).subarray(offset).toString('utf8')
}

function logSize(name: LogName): number {
  return statSync(e2eLogFile(name)).size
}

/** A same-origin API call from inside a page (cookies of its context, through the e2e Caddy). */
async function pageApi(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await page.request.fetch(path, {
    method,
    headers: { origin: publicOrigin(), 'content-type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status(), body: text && (res.headers()['content-type'] ?? '').includes('json') ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

test.describe('secrets in logs', () => {
  test.setTimeout(240_000)
  test.afterAll(closeE2eDb)

  test('a full flow leaves no secret in app, Caddy, LiveKit or Postgres logs', async ({ page, context, browser, rooms, guards, secrets }) => {
    expect(process.env.LOG_LEVEL, 'scripts/e2e.sh runs the app with debug logging').toBe('debug')
    guards.allowConsoleError(HTTP_ERROR_CONSOLE)
    const startedAt = new Date(Date.now() - 1_000)
    const offsets = { app: logSize('app.log'), caddy: logSize('caddy.log') }
    const tracked = new Map<string, string>()
    const track = (value: string | undefined, label: string) => {
      if (!value || value.length < 8) return
      tracked.set(value, label)
      secrets.track(value, label)
    }

    // Every LiveKit token that reaches a page in a join answer.
    const watchJoins = (target: Page) =>
      target.on('response', async (response) => {
        if (response.request().method() !== 'POST' || !/^\/api\/join\/[a-z-]+$/.test(new URL(response.url()).pathname)) return
        const body = (await response.json().catch(() => null)) as { token?: string } | null
        track(body?.token, 'LiveKit token (join answer)')
      })
    watchJoins(page)

    // 1. Sign-in: a wrong password first, then the right one.
    const account = await createPasswordUser({ displayName: 'Hana Host' })
    const wrong = `wrong-${randomBytes(6).toString('hex')}-password`
    track(account.password, 'password')
    track(wrong, 'wrong password')
    await page.goto('/login')
    await page.getByLabel('Email').fill(account.email)
    await page.getByLabel('Password', { exact: true }).fill(wrong)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByTestId('form-alert')).toBeVisible()
    await page.getByLabel('Password', { exact: true }).fill(account.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/dashboard/)
    const sessionCookie = (await context.cookies()).find((cookie) => /blinq_session$/.test(cookie.name))!
    track(sessionCookie.value, 'session token')
    const host: E2eUser = {
      id: ((await pageApi(page, 'GET', '/api/auth/me')).body.user as { id: string }).id,
      email: account.email,
      displayName: account.displayName,
      cookie: { name: sessionCookie.name, value: sessionCookie.value },
      ip: uniqueIp(),
    }

    // 2. A room with a waiting room, the host in the call through the real host link.
    const room = await rooms.createRoom(host, { name: 'Log scan room', waitingRoom: true })
    track(room.key, 'room key')
    track(room.proof, 'join proof')
    await openToPrejoin(page, room.link)
    await pressJoin(page)
    await waitForPhase(page, 'inCall')

    // 3. A guest with an invite waits, is admitted through the waiting-room stream and chats.
    const inviteToken = await rooms.createInvite(room, host)
    track(inviteToken, 'room invite token')
    const guestContext = await newWatchedContext(browser, guards)
    const guest = await guestContext.newPage()
    watchJoins(guest)
    await openToPrejoin(guest, rooms.inviteLink(room, inviteToken))
    const requestId = await waitingRequestId(guest, room.slug, () => pressJoin(guest, 'Gus Guest'))
    await rooms.admit(room, host, requestId)
    await waitForPhase(guest, 'inCall')
    for (const cookie of await guestContext.cookies()) track(cookie.value, `guest cookie ${cookie.name}`)

    await openPanel(guest, 'chat')
    await guest.getByTestId('chat-input').fill('Hello from the log scan')
    await guest.getByTestId('chat-send').click()
    await openPanel(page, 'chat')
    await expect(page.getByTestId('chat-panel').getByTestId('chat-message-text').last()).toHaveText('Hello from the log scan')

    // 4. A short server recording by the host.
    await startRecording(page, 'server')
    await page.waitForTimeout(3_000)
    await stopRecording(page)

    await leaveCalls(guest, page)
    await guestContext.close()

    // 5. An account invite from an admin, previewed and accepted.
    const admin = await rooms.createUser({ role: 'admin', displayName: 'Ada Admin' })
    track(admin.cookie.value, 'admin session token')
    const adminContext = await browser.newContext({ baseURL: publicOrigin() })
    await guards.watch(adminContext)
    await rooms.useIdentity(adminContext, admin)
    const adminPage = await adminContext.newPage()
    const invited = uniqueEmail('invited')
    const created = await pageApi(adminPage, 'POST', '/api/admin/invites', { email: invited, role: 'user', expiresIn: '7d', sendEmail: false })
    expect(created.status).toBe(201)
    const accountToken = created.body.token as string
    track(accountToken, 'account invite token')
    const anonymous = await browser.newContext({ baseURL: publicOrigin() })
    await guards.watch(anonymous)
    const visitor = await anonymous.newPage()
    expect((await pageApi(visitor, 'POST', '/api/auth/invites/preview', { token: accountToken })).status).toBe(200)
    const invitedPassword = strongPassword('invited')
    track(invitedPassword, 'invited user password')
    const accepted = await pageApi(visitor, 'POST', '/api/auth/invites/accept', { token: accountToken, displayName: 'Ivy Invited', password: invitedPassword })
    expect(accepted.status).toBe(201)
    for (const cookie of await anonymous.cookies()) track(cookie.value, `invited session ${cookie.name}`)
    await adminContext.close()

    // 6. A password reset by email, then sign-out.
    expect((await pageApi(visitor, 'POST', '/api/auth/password-reset/request', { email: account.email })).status).toBe(202)
    const mail = await waitForMail(account.email, /Reset your/)
    const resetToken = tokenLink(mail, '/reset-password').token
    track(resetToken, 'password reset token')
    const newPassword = strongPassword('reset')
    track(newPassword, 'new password')
    expect((await pageApi(visitor, 'POST', '/api/auth/password-reset/confirm', { token: resetToken, newPassword })).status).toBe(200)
    expect((await pageApi(visitor, 'POST', '/api/auth/logout')).status).toBe(204)
    await anonymous.close()

    // 7. Let webhooks, SSE and WebSocket closes reach the logs, then scan everything since the start.
    await page.waitForTimeout(2_000)
    for (const name of ENV_SECRETS) track(process.env[name], `environment ${name}`)
    const databasePassword = decodeURIComponent(new URL(process.env.DATABASE_URL ?? 'postgres://x@localhost/x').password)
    const logs: Record<string, string> = {
      'app.log': readSince('app.log', offsets.app),
      'caddy.log': readSince('caddy.log', offsets.caddy),
      [LIVEKIT_CONTAINER]: containerLogs(LIVEKIT_CONTAINER, startedAt),
      [POSTGRES_CONTAINER]: containerLogs(POSTGRES_CONTAINER, startedAt),
    }
    const leaks: Leak[] = Object.entries(logs).flatMap(([file, text]) => findLeaks(text, tracked, file))
    // The database password is short and common in container names, so it only counts as a whole word.
    if (databasePassword) {
      const word = new RegExp(`(?<![\\w-])${databasePassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)
      for (const [file, text] of Object.entries(logs)) if (word.test(text)) leaks.push({ file, kind: 'environment DATABASE_URL password', excerpt: '<masked>' })
    }
    await test.info().attach('scanned-logs.json', {
      body: JSON.stringify({ tracked: [...tracked.values()], bytes: Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, v.length])) }, null, 2),
      contentType: 'application/json',
    })
    expect(leaks, leaks.map((leak) => `[${leak.file}] ${leak.kind}: ${leak.excerpt}`).join('\n')).toEqual([])

    // The scan saw real traffic: the app logged the flow's requests and LiveKit the meeting of this room.
    expect(logs['app.log']).toContain('/api/join/')
    expect(logs['caddy.log']).toContain('/rtc')
    expect(logs[LIVEKIT_CONTAINER]).toContain(room.id)
    expect(tracked.size).toBeGreaterThanOrEqual(15)
  })
})
