/**
 * Cookies (Stage 10, docs/API.md §13, docs/SECURITY.md §4). These tests run against a second test server behind an
 * https PUBLIC_URL, the production setup, where cookies carry the `__Host-` prefix (on plain http the harness server
 * uses the development names; tests/api/auth/cookie.test.ts covers those).
 *
 * - Every cookie the API sets, from every flow that sets one, is `__Host-` with Secure, HttpOnly, SameSite=Lax,
 *   Path=/ and no Domain; sessions last 30 days, guest sessions 12 hours.
 * - Sessions rotate on login (no fixation) and on privilege changes; logout, password change, password reset,
 *   disabling, the admin's reset and revoke all end them at once (the 30 s validation cache included).
 * - Guest cookies are per room: a guest token works only under its own room's cookie name and room.
 */
import { join as joinPath } from 'node:path'
import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { settings } from '../../../server/database/schema'
import {
  ApiClient,
  type ApiResponse,
  createAdmin,
  createGuestSession,
  createInvite,
  createParticipant,
  createRoom,
  createRoomInvite,
  createSession,
  createUser,
  expectApiError,
  REPO_ROOT,
  serverEnv,
  startTestServer,
  testDb,
  type TestRoom,
  type TestServer,
  type TestUser,
  uniqueEmail,
} from '../_harness'
import { createEmailToken } from '../auth/support'
import { join, newClientId, participantRow } from '../rooms/_support'

const HTTPS_ORIGIN = 'https://blinq.test'
const SESSION_COOKIE = '__Host-blinq_session'
const NEW_PASSWORD = 'amber-falcon-ledger-73'
const SESSION_MAX_AGE = 30 * 24 * 3600
const GUEST_MAX_AGE = 12 * 3600

/** A client of the https server: same-origin requests carry the public https origin, like a browser behind Caddy. */
class HttpsClient extends ApiClient {
  override get origin(): string {
    return HTTPS_ORIGIN
  }
}

interface ParsedCookie {
  raw: string
  name: string
  value: string
  attributes: Map<string, string>
}

function parseSetCookie(header: string): ParsedCookie {
  const [pair = '', ...rest] = header.split(';').map((part) => part.trim())
  const index = pair.indexOf('=')
  const attributes = new Map<string, string>()
  for (const attribute of rest) {
    const at = attribute.indexOf('=')
    attributes.set((at === -1 ? attribute : attribute.slice(0, at)).toLowerCase(), at === -1 ? '' : attribute.slice(at + 1))
  }
  return { raw: header, name: pair.slice(0, index), value: pair.slice(index + 1), attributes }
}

function cookiesOf(res: ApiResponse): ParsedCookie[] {
  return res.setCookies.map(parseSetCookie)
}

function cookieNamed(res: ApiResponse, name: string): ParsedCookie {
  const cookie = cookiesOf(res).find((c) => c.name === name)
  expect(cookie, `Set-Cookie ${name} in ${JSON.stringify(res.setCookies)}`).toBeDefined()
  return cookie!
}

/** The documented attributes of every blinq cookie in production. */
function expectHostCookie(cookie: ParsedCookie): void {
  expect(cookie.name, cookie.raw).toMatch(/^__Host-blinq_(session|g_[a-z]{3}-[a-z]{4}-[a-z]{3})$/)
  expect(cookie.attributes.has('secure'), `Secure: ${cookie.raw}`).toBe(true)
  expect(cookie.attributes.has('httponly'), `HttpOnly: ${cookie.raw}`).toBe(true)
  expect(cookie.attributes.get('samesite'), cookie.raw).toBe('Lax')
  expect(cookie.attributes.get('path'), cookie.raw).toBe('/')
  expect(cookie.attributes.has('domain'), `no Domain: ${cookie.raw}`).toBe(false)
}

let server: TestServer

function client(): HttpsClient {
  return new HttpsClient({ baseUrl: server.baseUrl })
}

/** A client holding a fresh session of `user` under the production cookie name. */
async function signedIn(user: { id: string }): Promise<{ api: HttpsClient; token: string; id: string }> {
  const session = await createSession(user.id)
  const api = client()
  api.setCookie(SESSION_COOKIE, session.token)
  return { api, token: session.token, id: session.id }
}

/** Who the server thinks a raw session token belongs to (`null`: no valid session). */
async function ownerOf(token: string): Promise<string | null> {
  const res = await client().setCookie(SESSION_COOKIE, token).get('/api/auth/me')
  expect(res.status).toBe(200)
  return res.body.user?.id ?? null
}

async function waitForRegistration(mode: string, baseUrls: string[]): Promise<void> {
  for (const baseUrl of baseUrls) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const res = await new HttpsClient({ baseUrl }).get('/api/config')
      if (res.body?.registration?.mode === mode) break
      if (Date.now() > deadline) throw new Error(`${baseUrl} still serves registration ${JSON.stringify(res.body?.registration)}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

beforeAll(async () => {
  server = await startTestServer(
    { ...serverEnv() },
    { logFile: joinPath(REPO_ROOT, 'test-results', 'api-security-cookies.log'), publicUrl: HTTPS_ORIGIN },
  )
})

afterAll(async () => {
  await server?.stop()
})

describe('cookie attributes in production (https PUBLIC_URL)', () => {
  it('login sets a __Host- session cookie with Secure, HttpOnly, SameSite=Lax, Path=/, no Domain and 30 days', async () => {
    const user = await createUser()
    const res = await client().post('/api/auth/login', { body: { email: user.email, password: user.password } })
    expect(res.status, res.text).toBe(200)
    const cookie = cookieNamed(res, SESSION_COOKIE)
    expectHostCookie(cookie)
    expect(cookie.attributes.get('max-age')).toBe(String(SESSION_MAX_AGE))
    expect(res.text, 'the token is never in the body').not.toContain(cookie.value)
  })

  it('every flow that sets a cookie uses the same attributes', async () => {
    const responses: ApiResponse[] = []

    // Account invite accepted (201 + session).
    const invite = await createInvite()
    responses.push(
      await client().post('/api/auth/invites/accept', {
        body: { token: invite.token, email: uniqueEmail(), displayName: 'Ivy Invited', password: NEW_PASSWORD },
      }),
    )

    // Open registration (201 + session).
    await testDb()
      .insert(settings)
      .values({ key: 'registration.mode', value: 'open' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'open' } })
    try {
      await waitForRegistration('open', [server.baseUrl])
      responses.push(await client().post('/api/auth/register', { body: { email: uniqueEmail(), displayName: 'Rita Registered', password: NEW_PASSWORD } }))
    } finally {
      await testDb().delete(settings).where(inArray(settings.key, ['registration.mode']))
      await waitForRegistration('invite_only', [server.baseUrl, serverEnv().PUBLIC_URL!])
    }

    // Password change (rotated session).
    const user = await createUser()
    const own = await signedIn(user)
    responses.push(await own.api.post('/api/auth/password', { body: { currentPassword: user.password, newPassword: NEW_PASSWORD } }))

    // An admin's own role change (rotated session); another admin keeps the server administrable.
    await createAdmin()
    const admin = await signedIn(await createAdmin())
    const self = (await admin.api.get('/api/auth/me')).body.user.id
    responses.push(await admin.api.patch(`/api/admin/users/${self}`, { body: { role: 'user' } }))

    // Logout (cleared) and an invalid cookie (cleared).
    responses.push(await (await signedIn(await createUser())).api.post('/api/auth/logout'))
    responses.push(await client().setCookie(SESSION_COOKIE, 'x'.repeat(43)).get('/api/auth/me'))

    for (const res of responses) {
      expect(res.status, res.text).toBeLessThan(300)
      const cookies = cookiesOf(res)
      expect(cookies.length, `${res.status} ${res.text}`).toBeGreaterThan(0)
      for (const cookie of cookies) expectHostCookie(cookie)
    }
  })

  it('clears the session cookie on logout and for unknown tokens with Max-Age=0 under the same name and path', async () => {
    const logout = await (await signedIn(await createUser())).api.post('/api/auth/logout')
    expect(logout.status).toBe(204)
    const cleared = cookieNamed(logout, SESSION_COOKIE)
    expect(cleared.value).toBe('')
    expect(cleared.attributes.get('max-age')).toBe('0')
    expectHostCookie(cleared)

    const unknown = await client().setCookie(SESSION_COOKIE, 'y'.repeat(43)).get('/api/auth/me')
    expect(unknown.body.user).toBeNull()
    expect(cookieNamed(unknown, SESSION_COOKIE).attributes.get('max-age')).toBe('0')
  })

  it('ignores the development cookie names in production', async () => {
    const user = await createUser()
    const session = await createSession(user.id)
    expect((await client().setCookie('blinq_session', session.token).get('/api/auth/me')).body.user).toBeNull()
    expect(await ownerOf(session.token)).toBe(user.id)
  })
})

describe('session rotation', () => {
  it('issues a new session on login and ends the one the browser held, so a planted cookie is never upgraded', async () => {
    const attacker = await createUser()
    const victim = await createUser()
    const planted = await signedIn(attacker)
    const res = await planted.api.post('/api/auth/login', { body: { email: victim.email, password: victim.password } })
    expect(res.status, res.text).toBe(200)
    const issued = cookieNamed(res, SESSION_COOKIE).value
    expect(issued).not.toBe(planted.token)
    expect(await ownerOf(issued)).toBe(victim.id)
    // Whatever session the browser held before ends with the sign-in; it never becomes the victim's.
    expect(await ownerOf(planted.token)).toBeNull()

    // Signing in again as the same person also gets a fresh token and ends the previous one.
    const again = await client().setCookie(SESSION_COOKIE, issued).post('/api/auth/login', { body: { email: victim.email, password: victim.password } })
    const reissued = cookieNamed(again, SESSION_COOKIE).value
    expect(reissued).not.toBe(issued)
    expect(await ownerOf(reissued)).toBe(victim.id)
    expect(await ownerOf(issued)).toBeNull()
  })

  it('rotates the current session and ends all others on a password change', async () => {
    const user = await createUser()
    const current = await signedIn(user)
    const other = await signedIn(user)
    expect(await ownerOf(other.token)).toBe(user.id) // cached as valid before the change
    const res = await current.api.post('/api/auth/password', { body: { currentPassword: user.password, newPassword: NEW_PASSWORD } })
    expect(res.status, res.text).toBe(200)
    const rotated = cookieNamed(res, SESSION_COOKIE).value
    expect(rotated).not.toBe(current.token)
    expect(await ownerOf(rotated)).toBe(user.id)
    expect(await ownerOf(current.token)).toBeNull()
    expect(await ownerOf(other.token)).toBeNull()
  })

  it('rotates an admin\'s own session on an own role change and signs a promoted user out everywhere', async () => {
    await createAdmin()
    const adminUser = await createAdmin()
    const admin = await signedIn(adminUser)
    const target = await createUser()
    const targetSession = await signedIn(target)
    expect(await ownerOf(targetSession.token)).toBe(target.id)

    const promoted = await admin.api.patch(`/api/admin/users/${target.id}`, { body: { role: 'admin' } })
    expect(promoted.status, promoted.text).toBe(200)
    expect(await ownerOf(targetSession.token), 'the promoted user signs in again').toBeNull()

    const demoted = await admin.api.patch(`/api/admin/users/${adminUser.id}`, { body: { role: 'user' } })
    expect(demoted.status, demoted.text).toBe(200)
    const rotated = cookieNamed(demoted, SESSION_COOKIE).value
    expect(rotated).not.toBe(admin.token)
    expect(await ownerOf(admin.token)).toBeNull()
    const me = await client().setCookie(SESSION_COOKIE, rotated).get('/api/auth/me')
    expect(me.body.user).toMatchObject({ id: adminUser.id, role: 'user' })
  })
})

describe('session revocation', () => {
  it('logout ends the session for good, also when the token is replayed', async () => {
    const user = await createUser()
    const own = await signedIn(user)
    expect(await ownerOf(own.token)).toBe(user.id)
    expect((await own.api.post('/api/auth/logout')).status).toBe(204)
    expect(await ownerOf(own.token)).toBeNull()
    expectApiError(await client().setCookie(SESSION_COOKIE, own.token).get('/api/auth/sessions'), 401, 'UNAUTHENTICATED')
  })

  it('a password reset by email ends every session', async () => {
    const user = await createUser()
    const sessions = [await signedIn(user), await signedIn(user)]
    for (const s of sessions) expect(await ownerOf(s.token)).toBe(user.id)
    const token = await createEmailToken(user.id, 'reset_password')
    const res = await client().post('/api/auth/password-reset/confirm', { body: { token, newPassword: NEW_PASSWORD } })
    expect(res.status, res.text).toBe(200)
    for (const s of sessions) expect(await ownerOf(s.token)).toBeNull()
  })

  it.each([
    ['disabling the account', (id: string) => ({ method: 'PATCH', path: `/api/admin/users/${id}`, body: { disabled: true } })],
    ['the admin password reset', (id: string) => ({ method: 'POST', path: `/api/admin/users/${id}/reset-password`, body: {} })],
    ['the admin session revoke', (id: string) => ({ method: 'POST', path: `/api/admin/users/${id}/revoke-sessions`, body: undefined })],
  ] as const)('%s ends every session of the user at once', async (_name, action) => {
    const admin = await signedIn(await createAdmin())
    const user: TestUser = await createUser()
    const sessions = [await signedIn(user), await signedIn(user)]
    for (const s of sessions) expect(await ownerOf(s.token)).toBe(user.id)
    const { method, path, body } = action(user.id)
    const res = await admin.api.request(method, path, body === undefined ? {} : { body })
    expect(res.status, res.text).toBeLessThan(300)
    for (const s of sessions) expect(await ownerOf(s.token)).toBeNull()
    if (method === 'PATCH') {
      // Enabling the account again does not bring the old sessions back.
      expect((await admin.api.patch(path, { body: { disabled: false } })).status).toBe(200)
      for (const s of sessions) expect(await ownerOf(s.token)).toBeNull()
    }
  })
})

describe('guest cookies are per room', () => {
  let roomA: { room: TestRoom; meetingId: string }
  let roomB: { room: TestRoom; meetingId: string }

  /** A room whose owner started the meeting through the https server (its own fake LiveKit). */
  async function liveRoom(): Promise<{ room: TestRoom; meetingId: string }> {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await signedIn(owner)
    const res = await join(host.api, room)
    expect(res.status, res.text).toBe(200)
    return { room, meetingId: (await participantRow(res.body.identity))!.meetingId! }
  }

  beforeAll(async () => {
    roomA = await liveRoom()
    roomB = await liveRoom()
  })

  async function joinAsGuest(api: HttpsClient, room: TestRoom) {
    const invite = await createRoomInvite(room)
    const res = await join(api, room, { inviteToken: invite.token, displayName: 'Gail Guest', clientId: newClientId() })
    expect(res.status, res.text).toBe(200)
    return res
  }

  it('sets one __Host- cookie per room, valid for 12 hours', async () => {
    const api = client()
    const a = cookieNamed(await joinAsGuest(api, roomA.room), `__Host-blinq_g_${roomA.room.slug}`)
    const b = cookieNamed(await joinAsGuest(api, roomB.room), `__Host-blinq_g_${roomB.room.slug}`)
    for (const cookie of [a, b]) {
      expectHostCookie(cookie)
      const maxAge = Number(cookie.attributes.get('max-age'))
      expect(maxAge).toBeGreaterThan(GUEST_MAX_AGE - 120)
      expect(maxAge).toBeLessThanOrEqual(GUEST_MAX_AGE)
    }
    expect(a.value).not.toBe(b.value)
    // Both rooms see their own guest, and a guest cookie is never a user session.
    expect((await api.get(`/api/calls/${roomA.room.id}/participants`)).status).toBe(200)
    expect((await api.get(`/api/calls/${roomB.room.id}/participants`)).status).toBe(200)
    expect((await api.get('/api/auth/me')).body.user).toBeNull()
  })

  it('does not accept a guest token under another room\'s cookie name', async () => {
    const guest = await createGuestSession(roomA.room)
    await createParticipant({ room: roomA.room, meeting: { id: roomA.meetingId }, guestSessionId: guest.id, status: 'joined' })
    const own = client().setCookie(`__Host-blinq_g_${roomA.room.slug}`, guest.token)
    expect((await own.get(`/api/calls/${roomA.room.id}/participants`)).status).toBe(200)

    const moved = client().setCookie(`__Host-blinq_g_${roomB.room.slug}`, guest.token)
    expectApiError(await moved.get(`/api/calls/${roomB.room.id}/participants`), 403, 'CALL_NOT_PARTICIPANT')
    // Joining room B with it starts a new guest session instead of reusing room A's.
    const res = await joinAsGuest(moved, roomB.room)
    const issued = cookieNamed(res, `__Host-blinq_g_${roomB.room.slug}`)
    expect(issued.value).not.toBe(guest.token)

    // The development name of a guest cookie means nothing in production.
    const devName = client().setCookie(`blinq_g_${roomA.room.slug}`, guest.token)
    expectApiError(await devName.get(`/api/calls/${roomA.room.id}/participants`), 403, 'CALL_NOT_PARTICIPANT')
  })
})
