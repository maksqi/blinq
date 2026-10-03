/**
 * Rate limits and caps (Stage 10, docs/API.md §1.2, docs/SECURITY.md §4): every documented limiter answers 429
 * RATE_LIMITED with `Retry-After` (whole seconds, also in `data.details.retryAfter`), per-IP keys aggregate IPv6 by /64,
 * and `X-Forwarded-For` is trusted only from a loopback peer (the first entry, which Caddy sets). Each test uses its
 * own client IPs, users and rooms, so limiter state never leaks between tests (the server's limiter store is shared).
 */
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { describe, expect, it } from 'vitest'
import { generateSlug } from '../../../app/lib/e2ee'
import {
  type ApiClient,
  type ApiResponse,
  apiBaseUrl,
  createClient,
  createGuestSession,
  createParticipant,
  createRoom,
  createRoomInvite,
  createUser,
  expectApiError,
  loginAs,
  searchMessages,
  uniqueEmail,
  uniqueIp,
} from '../_harness'
import { liveCall, startServerRecording } from '../recordings/_support'
import { join, joinGuest, participantRow, startMeeting } from '../rooms/_support'

const WRONG_PASSWORD = 'definitely-not-the-password'

function expectRateLimited(res: ApiResponse, maxSeconds: number): number {
  expectApiError(res, 429, 'RATE_LIMITED')
  const header = res.headers.get('retry-after')
  expect(header, 'Retry-After header').toMatch(/^\d+$/)
  const seconds = Number(header)
  expect(seconds).toBeGreaterThanOrEqual(1)
  expect(seconds).toBeLessThanOrEqual(maxSeconds)
  expect(res.body.data.details).toEqual({ retryAfter: seconds })
  return seconds
}

/** Another address in the same IPv6 /64 as `ip` (uniqueIp() gives `2001:db8:x:y::z`). */
function sibling(ip: string): string {
  return ip.replace(/::[0-9a-f]+$/, `::${randomBytes(2).toString('hex')}:1`)
}

const login = (api: ApiClient, email: string, password: string) => api.post('/api/auth/login', { body: { email, password } })

describe('login (limiter `login`: database backoff per email and per IP)', () => {
  it('lets 5 failures pass, then backs off with 429 and Retry-After, even for the right password', async () => {
    const user = await createUser()
    const api = createClient()
    for (let i = 0; i < 6; i++) expectApiError(await login(api, user.email, WRONG_PASSWORD), 401, 'AUTH_INVALID_CREDENTIALS')
    expectRateLimited(await login(api, user.email, user.password), 2)
    // The email key holds from any other IP too.
    expectRateLimited(await login(createClient(), user.email, user.password), 2)
  })

  it('backs off one IP (its /64) across many emails, but not other networks', async () => {
    const api = createClient()
    for (let i = 0; i < 6; i++) await login(api, uniqueEmail('spray'), WRONG_PASSWORD)
    const user = await createUser()
    expectRateLimited(await login(api, user.email, user.password), 2)
    expectRateLimited(await login(createClient({ ip: sibling(api.ip) }), user.email, user.password), 2)
    expect((await login(createClient(), user.email, user.password)).status).toBe(200)
  })

  it('is the only limiter on POST /api/auth/login, as documented (auth-ip does not apply)', async () => {
    // docs/API.md §1.2 lists only `login` for this route: 11 well-formed attempts for 11 accounts from one IP never
    // hit the 10-per-minute auth-ip limit; only the IP backoff (after 5 failures) would.
    const api = createClient()
    for (let i = 0; i < 11; i++) {
      const user = await createUser()
      expect((await login(api, user.email, user.password)).status).toBe(200)
    }
  })
})

/** Routes behind the shared `auth-ip` limiter (10 per minute per IP); malformed requests count too. */
const AUTH_IP_ROUTES = [
  '/api/auth/register',
  '/api/auth/verify-email',
  '/api/auth/password-reset/request',
  '/api/auth/password-reset/confirm',
  '/api/auth/invites/preview',
  '/api/auth/invites/accept',
]

describe('auth-ip (10 per minute per IP)', () => {
  it.each(AUTH_IP_ROUTES)('%s answers 429 after 10 requests', async (path) => {
    const api = createClient()
    for (let i = 0; i < 10; i++) expect((await api.post(path, { body: {} })).status).toBe(400)
    expectRateLimited(await api.post(path, { body: {} }), 60)
  })

  it('is one bucket for all of these routes', async () => {
    const api = createClient()
    for (let i = 0; i < 10; i++) expect((await api.post(AUTH_IP_ROUTES[i % 5]!, { body: {} })).status).toBe(400)
    for (const path of AUTH_IP_ROUTES) expectRateLimited(await api.post(path, { body: {} }), 60)
    // A valid invite preview from the same IP is refused before the token is looked at.
    expectRateLimited(await api.post('/api/auth/invites/preview', { body: { token: 'A'.repeat(43) } }), 60)
  })

  it('keys IPv6 clients by /64 and IPv4-mapped addresses like IPv4', async () => {
    const api = createClient()
    for (let i = 0; i < 10; i++) {
      const neighbour = createClient({ ip: sibling(api.ip) })
      expect((await neighbour.post('/api/auth/verify-email', { body: {} })).status).toBe(400)
    }
    expectRateLimited(await api.post('/api/auth/verify-email', { body: {} }), 60)
    expect((await createClient().post('/api/auth/verify-email', { body: {} })).status).toBe(400)

    const v4 = uniqueIp(4)
    for (let i = 0; i < 10; i++) expect((await createClient({ ip: v4 }).post('/api/auth/verify-email', { body: {} })).status).toBe(400)
    expectRateLimited(await createClient({ ip: `::ffff:${v4}` }).post('/api/auth/verify-email', { body: {} }), 60)
  })

  it('takes the first X-Forwarded-For entry from the loopback proxy', async () => {
    const real = uniqueIp()
    const api = createClient({ ip: real })
    for (let i = 0; i < 10; i++) expect((await api.post('/api/auth/verify-email', { body: {} })).status).toBe(400)
    const appended = createClient({ ip: `${real}, ${uniqueIp()}` })
    expectRateLimited(await appended.post('/api/auth/verify-email', { body: {} }), 60)
    const prefixed = createClient({ ip: `${uniqueIp()}, ${real}` })
    expect((await prefixed.post('/api/auth/verify-email', { body: {} })).status).toBe(400)
  })
})

/** The first non-internal IPv4 address of this machine (the LAN address), if any. */
function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((address) => address && address.family === 'IPv4' && !address.internal)?.address
}

/** POST from a non-loopback source address to the (loopback) test server. */
function postFrom(localAddress: string, path: string, forwardedFor: string): Promise<{ status: number; retryAfter?: string }> {
  const base = new URL(apiBaseUrl())
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        path,
        method: 'POST',
        localAddress,
        headers: { origin: base.origin, 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string | undefined }))
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
}

describe('X-Forwarded-For from a peer that is not loopback', () => {
  const lan = lanAddress()

  it.skipIf(!lan)('is ignored: every spoofed value lands in the bucket of the real peer address', async () => {
    // The app trusts the header only from Caddy on loopback. A direct client with a forged header per request must
    // still hit the 10-per-minute auth-ip limit of its own address (earlier runs may already have used part of it).
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await postFrom(lan!, '/api/auth/verify-email', uniqueIp())).status)
    const first = statuses.indexOf(429)
    expect(first, `statuses ${statuses.join(',')}`).toBeGreaterThanOrEqual(0)
    expect(statuses.slice(first).every((status) => status === 429)).toBe(true)
    expect(statuses.slice(0, first).every((status) => status === 400)).toBe(true)
    const last = await postFrom(lan!, '/api/auth/verify-email', uniqueIp(4))
    expect(last.status).toBe(429)
    expect(last.retryAfter).toMatch(/^\d+$/)
  })
})

describe('reset-email (3 per address and hour, silent)', () => {
  it('answers 202 every time but sends only 3 mails to one address', async () => {
    const user = await createUser()
    for (let i = 0; i < 5; i++) {
      const res = await createClient().post('/api/auth/password-reset/request', { body: { email: user.email } })
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ ok: true })
    }
    let found = 0
    for (let i = 0; i < 25 && found < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      found = (await searchMessages(`to:"${user.email}"`)).length
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect((await searchMessages(`to:"${user.email}"`)).length).toBe(3)
  })
})

describe('join-ip (30 per minute per IP, info and join together)', () => {
  it('limits join info and join requests together, wrong keys included', async () => {
    const room = await createRoom(await createUser())
    const api = createClient()
    for (let i = 0; i < 15; i++) expect((await api.post(`/api/join/${room.slug}/info`, { body: { proof: room.proof } })).status).toBe(200)
    for (let i = 0; i < 15; i++) {
      const res = await join(api, room, { proof: 'B'.repeat(43) })
      expectApiError(res, 403, 'ROOM_KEY_INVALID')
    }
    expectRateLimited(await api.post(`/api/join/${room.slug}/info`, { body: { proof: room.proof } }), 60)
    expectRateLimited(await join(api, room), 60)
  })

  it('counts unknown rooms, so slugs cannot be enumerated quickly', async () => {
    const api = createClient()
    for (let i = 0; i < 30; i++) {
      expectApiError(await api.post(`/api/join/${generateSlug()}/info`, { body: { proof: 'C'.repeat(43) } }), 404, 'ROOM_NOT_FOUND')
    }
    expectRateLimited(await api.post(`/api/join/${generateSlug()}/info`, { body: { proof: 'C'.repeat(43) } }), 60)
  })
})

describe('room-password (backoff per room and IP)', () => {
  it('backs off wrong room passwords per room and IP, then refuses even the right one', async () => {
    const room = await createRoom(await createUser(), { password: 'correct horse', waitingRoom: false })
    const other = await createRoom(await createUser(), { password: 'battery staple', waitingRoom: false })
    const api = createClient()
    const attempt = async (target = room, password = 'wrong') =>
      join(api, target, { inviteToken: (await createRoomInvite(target)).token, displayName: 'Guess Who', password })
    for (let i = 0; i < 6; i++) expectApiError(await attempt(), 403, 'ROOM_PASSWORD_INVALID')
    expectRateLimited(await attempt(room, 'correct horse'), 2)
    // The same IP is not slowed down in another room, and another IP not in this one.
    expectApiError(await attempt(other), 403, 'ROOM_PASSWORD_INVALID')
    const fresh = createClient()
    const res = await join(fresh, room, { inviteToken: (await createRoomInvite(room)).token, displayName: 'Someone', password: 'correct horse' })
    expect(res.status, res.text).toBe(200)
  })
})

describe('waiting-room cap (50 per room, 409 LOBBY_FULL)', () => {
  it('refuses the 51st waiting request of a room, but not of another room', async () => {
    const room = await createRoom(await createUser(), { waitingRoom: true })
    for (let i = 0; i < 50; i++) await createParticipant({ room, meeting: null, status: 'waiting' })
    expectApiError((await joinGuest(room)).res, 409, 'LOBBY_FULL')
    const other = await createRoom(await createUser(), { waitingRoom: true })
    expect((await joinGuest(other)).res.status).toBe(202)
  })
})

describe('waiting-room streams', () => {
  // pending finding: no limit on concurrent waiting-room SSE streams (per request or per IP); docs/API.md defines none.
  it.skip('caps concurrent SSE connections for one waiting request with 429 RATE_LIMITED and Retry-After', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: true })
    await startMeeting(room, owner)
    const guest = await joinGuest(room, { expectStatus: 202 })
    const controllers: AbortController[] = []
    try {
      const statuses = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const controller = new AbortController()
          controllers.push(controller)
          const res = await fetch(new URL(`/api/join/requests/${guest.res.body.requestId}/events`, apiBaseUrl()), {
            headers: { cookie: guest.api.cookieHeader(), 'x-forwarded-for': guest.api.ip },
            signal: controller.signal,
          })
          return { status: res.status, retryAfter: res.headers.get('retry-after') }
        }),
      )
      const limited = statuses.filter((s) => s.status === 429)
      expect(limited.length).toBeGreaterThan(0)
      expect(limited.every((s) => /^\d+$/.test(s.retryAfter ?? ''))).toBe(true)
    } finally {
      for (const controller of controllers) controller.abort()
    }
  })
})

describe('recording-chunks (8 per second per recording)', () => {
  it('answers 429 with Retry-After to a burst of chunk uploads for one recording', async () => {
    const call = await liveCall()
    const id = await startServerRecording(call.client, call.room.id)
    // The limit is checked before the body: a wrong content type keeps the burst free of side effects (400 when allowed).
    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        call.client.put(`/api/recordings/${id}/chunks/0`, { raw: new Uint8Array(4), headers: { 'content-type': 'text/plain' } }),
      ),
    )
    const limited = burst.filter((res) => res.status === 429)
    expect(limited.length, burst.map((res) => res.status).join(',')).toBeGreaterThanOrEqual(1)
    expect(limited.length).toBeLessThanOrEqual(4)
    for (const res of limited) expectRateLimited(res, 1)
    expect(burst.filter((res) => res.status !== 429).every((res) => res.status === 400)).toBe(true)
  })
})

describe('room-create (20 per hour per user)', () => {
  it('limits room and room-invite creation together per user', async () => {
    const user = await createUser()
    const api = await loginAs(user)
    const room = await createRoom(user)
    for (let i = 0; i < 10; i++) expect((await api.post('/api/rooms', { body: {} })).status).toBe(400)
    for (let i = 0; i < 10; i++) expect((await api.post(`/api/rooms/${room.id}/invites`, { body: { expiresIn: 'soon' } })).status).toBe(400)
    expectRateLimited(await api.post('/api/rooms', { body: {} }), 3600)
    expectRateLimited(await api.post(`/api/rooms/${room.id}/invites`, { body: {} }), 3600)
    // Per user, not per IP: another account on the same address is not affected.
    const neighbour = await loginAs(await createUser(), createClient({ ip: api.ip }))
    expect((await neighbour.post('/api/rooms', { body: {} })).status).toBe(400)
  })
})

describe('call-actions (120 per minute per participant row)', () => {
  it('limits in-call requests per participant', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    const meetingId = (await participantRow(host.identity))!.meetingId!
    const guest = await createGuestSession(room)
    await createParticipant({ room, meeting: { id: meetingId }, guestSessionId: guest.id, status: 'joined' })
    const api = createClient().setCookie(guest.cookieName, guest.token)
    for (let i = 0; i < 120; i++) expect((await api.post(`/api/calls/${room.id}/me/hand`, { body: {} })).status).toBe(400)
    expectRateLimited(await api.post(`/api/calls/${room.id}/me/hand`, { body: { raised: true } }), 60)
    expectRateLimited(await api.get(`/api/calls/${room.id}/participants`), 60)
    // The host's own row has its own budget.
    expect((await host.api.get(`/api/calls/${room.id}/participants`)).status).toBe(200)
  })
})
