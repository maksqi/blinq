/**
 * CSRF (Stage 10, docs/API.md §1.1, docs/SECURITY.md §4): every mutating route under server/api, read from the file
 * tree, refuses a request without `Origin`, with a foreign `Origin`, and with `Sec-Fetch-Site: cross-site`, with 403
 * CSRF_REJECTED. The caller holds every privilege at once (an admin who owns the live room, plus the guest cookie that
 * owns a waiting request) and sends well-formed bodies, so only the CSRF check can stop the request; afterwards the
 * rooms, rows, sessions, settings, audit log and fake LiveKit calls are unchanged. The LiveKit webhook is exempt but
 * needs a valid signature. Safe methods pass the check and change nothing, and a GET never runs a mutating handler.
 */
import { randomBytes } from 'node:crypto'
import { and, count, eq, gte } from 'drizzle-orm'
import { WebhookEvent } from 'livekit-server-sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import { deriveJoinProof, generateRoomKey, generateSlug } from '../../../app/lib/e2ee'
import { auditLog, callParticipants, roomMembers } from '../../../server/database/schema'
import {
  type ApiClient,
  createAdmin,
  createClient,
  createGuestSession,
  createInvite,
  createParticipant,
  createRoom,
  createRoomInvite,
  createSession,
  createUser,
  expectApiError,
  signWebhook,
  testDb,
  type TestRoom,
  type TestUser,
  uniqueEmail,
} from '../_harness'
import { seedReadyRecording } from '../recordings/_support'
import { newClientId, participantRow, startMeeting } from '../rooms/_support'
import { fileRoutes, livekitWrites, MUTATING, routeKey, send } from './_world'

const FOREIGN_ORIGIN = 'https://evil.example'
const STRONG_PASSWORD = 'amber-falcon-ledger-73'

interface Fixture {
  owner: TestUser
  api: ApiClient
  room: TestRoom
  meetingId: string
  target: { identity: string; userId: string }
  cohostId: string
  inviteId: string
  requestId: string
  recordingId: string
  victim: TestUser
  accountInviteId: string
  spareSession: string
  startedAt: Date
}

let fx: Fixture

beforeAll(async () => {
  const startedAt = new Date()
  const owner = await createAdmin({ displayName: 'Olga Owner' })
  const room = await createRoom(owner, { waitingRoom: false })
  const joined = await startMeeting(room, owner)
  const meetingId = (await participantRow(joined.identity))!.meetingId!
  const api = joined.api

  const targetUser = await createUser()
  const target = await createParticipant({ room, meeting: { id: meetingId }, userId: targetUser.id, status: 'joined', displayName: targetUser.displayName })
  const cohost = await createUser()
  await testDb().insert(roomMembers).values({ roomId: room.id, userId: cohost.id })
  const guest = await createGuestSession(room)
  const request = await createParticipant({ room, meeting: { id: meetingId }, guestSessionId: guest.id, status: 'waiting' })
  api.setCookie(guest.cookieName, guest.token)

  fx = {
    owner,
    api,
    room,
    meetingId,
    target: { identity: target.lkIdentity, userId: targetUser.id },
    cohostId: cohost.id,
    inviteId: (await createRoomInvite(room)).id,
    requestId: request.id,
    recordingId: (await seedReadyRecording({ createdBy: owner.id, roomId: room.id })).id,
    victim: await createUser(),
    accountInviteId: (await createInvite({ createdBy: owner.id })).id,
    spareSession: (await createSession(owner.id)).id,
    startedAt,
  }
})

/** Concrete path of a route pattern with this fixture's real objects. */
function concrete(pattern: string): string {
  return pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    if (pattern.startsWith('/api/admin/users')) return fx.victim.id
    if (pattern.startsWith('/api/admin/invites')) return fx.accountInviteId
    if (pattern.startsWith('/api/auth/sessions')) return fx.spareSession
    if (pattern.startsWith('/api/join/requests')) return fx.requestId
    if (pattern.includes('/recordings/')) return fx.recordingId
    switch (name) {
      case 'id':
      case 'roomId':
        return fx.room.id
      case 'slug':
        return fx.room.slug
      case 'identity':
        return fx.target.identity
      case 'requestId':
        return fx.requestId
      case 'userId':
        return fx.cohostId
      case 'inviteId':
        return fx.inviteId
      case 'seq':
        return '0'
      default:
        throw new Error(`No sample for :${name} in ${pattern}`)
    }
  })
}

const TOKEN = 'A'.repeat(43)

/** Well-formed bodies: without the CSRF check, each request would be accepted. */
async function bodyFor(key: string): Promise<{ body?: unknown; raw?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> }> {
  switch (key) {
    case 'POST /api/auth/login':
      return { body: { email: fx.owner.email, password: fx.owner.password } }
    case 'POST /api/auth/register':
      return { body: { email: uniqueEmail(), displayName: 'Mallory', password: STRONG_PASSWORD } }
    case 'POST /api/auth/verify-email':
    case 'POST /api/auth/invites/preview':
      return { body: { token: TOKEN } }
    case 'POST /api/auth/password':
      return { body: { currentPassword: fx.owner.password, newPassword: STRONG_PASSWORD } }
    case 'POST /api/auth/password-reset/request':
      return { body: { email: fx.owner.email } }
    case 'POST /api/auth/password-reset/confirm':
      return { body: { token: TOKEN, newPassword: STRONG_PASSWORD } }
    case 'POST /api/auth/invites/accept':
      return { body: { token: TOKEN, email: uniqueEmail(), displayName: 'Mallory', password: STRONG_PASSWORD } }
    case 'PATCH /api/me':
      return { body: { displayName: 'Mallory' } }
    case 'POST /api/rooms': {
      const slug = generateSlug()
      return { body: { slug, name: 'Planted room', proof: await deriveJoinProof(generateRoomKey(), slug) } }
    }
    case 'PATCH /api/rooms/:id':
      return { body: { name: 'Taken over', waitingRoom: true, password: 'open-sesame' } }
    case 'PUT /api/rooms/:id/key':
      return { body: { proof: await deriveJoinProof(generateRoomKey(), fx.room.slug) } }
    case 'POST /api/rooms/:id/cohosts':
      return { body: { userId: fx.victim.id } }
    case 'POST /api/rooms/:id/invites':
      return { body: { expiresIn: 'never', maxUses: null } }
    case 'POST /api/join/:slug/info':
      return { body: { proof: fx.room.proof } }
    case 'POST /api/join/:slug':
      return { body: { proof: fx.room.proof, clientId: newClientId() } }
    case 'POST /api/calls/:roomId/me/name':
    case 'POST /api/calls/:roomId/participants/:identity/name':
      return { body: { displayName: 'Mallory' } }
    case 'POST /api/calls/:roomId/me/hand':
      return { body: { raised: true } }
    case 'POST /api/calls/:roomId/participants/:identity/mute':
      return { body: { source: 'microphone' } }
    case 'POST /api/calls/:roomId/participants/:identity/permissions':
      return { body: { microphone: false, camera: false } }
    case 'POST /api/calls/:roomId/participants/:identity/volume':
      return { body: { level: 0 } }
    case 'POST /api/calls/:roomId/participants/:identity/role':
      return { body: { role: 'cohost' } }
    case 'POST /api/calls/:roomId/mute-all':
      return { body: { preventSelfUnmute: true } }
    case 'PATCH /api/calls/:roomId/settings':
      return { body: { locked: true, chatEnabled: false } }
    case 'POST /api/calls/:roomId/recording/start':
      return { body: { mode: 'local' } }
    case 'PUT /api/recordings/:id/chunks/:seq':
      return { raw: new Uint8Array(randomBytes(32)), headers: { 'content-type': 'application/octet-stream' } }
    case 'POST /api/recordings/:id/complete':
      return { body: { chunkCount: 1, durationMs: 1000 } }
    case 'POST /api/admin/users':
      return { body: { email: uniqueEmail(), displayName: 'Planted admin', role: 'admin' } }
    case 'PATCH /api/admin/users/:id':
      return { body: { role: 'admin' } }
    case 'POST /api/admin/users/:id/reset-password':
    case 'POST /api/admin/settings/test-email':
      return { body: {} }
    case 'POST /api/admin/invites':
      return { body: { role: 'user', expiresIn: '30d' } }
    case 'PUT /api/admin/settings':
      return { body: { 'registration.mode': 'open', 'guests.allowed': false } }
    default:
      return {}
  }
}

async function state() {
  const audit = await testDb()
    .select({ value: count() })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, fx.owner.id), gte(auditLog.at, fx.startedAt)))
  const [admin, victim, room] = await Promise.all([
    fx.api.get('/api/auth/me'),
    fx.api.get(`/api/admin/users/${fx.victim.id}`),
    fx.api.get(`/api/rooms/${fx.room.id}`),
  ])
  return {
    me: admin.body.user,
    victim: victim.body.user,
    room: room.body.room,
    target: await participantRow(fx.target.identity),
    cohosts: (await testDb().select().from(roomMembers).where(eq(roomMembers.roomId, fx.room.id))).map((m) => m.userId).sort(),
    request: (await testDb().select().from(callParticipants).where(eq(callParticipants.id, fx.requestId)))[0]?.status,
    invites: (await fx.api.get(`/api/rooms/${fx.room.id}/invites`)).body.items,
    recording: (await fx.api.get(`/api/recordings/${fx.recordingId}`)).body.recording,
    sessions: (await fx.api.get('/api/auth/sessions')).body.items.map((s: { id: string }) => s.id).sort(),
    settings: (await fx.api.get('/api/admin/settings')).body.settings,
    accountInvites: (await fx.api.get('/api/admin/invites', { query: { pageSize: 100 } })).body.total,
    audit: audit[0]!.value,
    livekit: (await livekitWrites(fx.room.id)).length,
  }
}

const mutating = fileRoutes().filter((route) => MUTATING.has(route.method) && routeKey(route) !== 'POST /api/webhooks/livekit')
const VARIANTS = [
  { name: 'no Origin', origin: null, headers: {} },
  { name: 'a foreign Origin', origin: FOREIGN_ORIGIN, headers: {} },
  { name: 'the public Origin with Sec-Fetch-Site: cross-site', origin: undefined, headers: { 'sec-fetch-site': 'cross-site' } },
] as const

describe('mutating routes', () => {
  let before: Awaited<ReturnType<typeof state>>

  beforeAll(async () => {
    before = await state()
  })

  it('covers every mutating handler except the webhook', () => {
    expect(mutating.length).toBeGreaterThanOrEqual(55)
    expect(mutating.map(routeKey)).toEqual(expect.arrayContaining(['POST /api/auth/login', 'DELETE /api/rooms/:id', 'PUT /api/admin/settings']))
  })

  const cases = mutating.flatMap((route) => VARIANTS.map((variant) => ({ key: routeKey(route), route, variant, label: variant.name })))

  it.each(cases)('$key with $label → 403 CSRF_REJECTED', async ({ key, route, variant }) => {
    const { body, raw, headers } = await bodyFor(key)
    const res = await fx.api.request(route.method, concrete(route.pattern), {
      body,
      raw,
      origin: variant.origin,
      headers: { ...headers, ...variant.headers },
    })
    expectApiError(res, 403, 'CSRF_REJECTED')
    expect(res.setCookies, 'a refused request sets no cookie').toEqual([])
  })

  it('changed nothing: rooms, rows, sessions, settings, invites, audit log and LiveKit calls', async () => {
    expect(await state()).toEqual(before)
  })

  it('accepts the same request from the public origin (the check, not the request, was refused)', async () => {
    const res = await fx.api.patch('/api/me', { body: { displayName: 'Olga Owner' }, headers: { 'sec-fetch-site': 'same-origin' } })
    expect(res.status, res.text).toBe(200)
  })
})

describe('LiveKit webhook', () => {
  function event(): string {
    const webhook = new WebhookEvent({
      id: `EV_${randomBytes(8).toString('hex')}`,
      createdAt: BigInt(Math.floor(Date.now() / 1000)),
      room: { name: fx.room.id, sid: '' },
    })
    webhook.event = 'room_started'
    return webhook.toJsonString()
  }

  const post = (body: string, headers: Record<string, string>, origin: string | null = FOREIGN_ORIGIN) =>
    createClient().post('/api/webhooks/livekit', {
      raw: body,
      origin,
      headers: { 'content-type': 'application/webhook+json', 'sec-fetch-site': 'cross-site', ...headers },
    })

  it('is exempt from the Origin check but needs a valid signature', async () => {
    const body = event()
    const signed = await post(body, { authorization: await signWebhook(body) })
    expect(signed.status, signed.text).toBe(200)
    expect(signed.body).toEqual({ ok: true })
  })

  it('rejects a missing, foreign or mismatching signature with 401', async () => {
    const body = event()
    expectApiError(await post(body, {}), 401, 'UNAUTHENTICATED')
    expectApiError(await post(body, { authorization: 'Bearer not-a-token' }), 401, 'UNAUTHENTICATED')
    expectApiError(await post(body, { authorization: await signWebhook(body, undefined, `wrong-${randomBytes(24).toString('hex')}`) }), 401, 'UNAUTHENTICATED')
    expectApiError(await post(body, { authorization: await signWebhook(event()) }), 401, 'UNAUTHENTICATED')
    expectApiError(await post(body, { authorization: await signWebhook(body, 'otherkey') }), 401, 'UNAUTHENTICATED')
  })

  it('exempts only POST: other methods on the webhook path need the public origin', async () => {
    expectApiError(await createClient().put('/api/webhooks/livekit', { origin: FOREIGN_ORIGIN }), 403, 'CSRF_REJECTED')
    expectApiError(await createClient().delete('/api/webhooks/livekit', { origin: null }), 403, 'CSRF_REJECTED')
  })
})

describe('safe methods', () => {
  let before: Awaited<ReturnType<typeof state>>

  beforeAll(async () => {
    before = await state()
  })

  const getRoutes = fileRoutes().filter((route) => route.method === 'GET')

  it.each(getRoutes.map((route) => ({ key: routeKey(route), route })))(
    'cross-site $key passes the CSRF check',
    async ({ route }) => {
      const res = await send(fx.api, 'GET', concrete(route.pattern), { origin: FOREIGN_ORIGIN, headers: { 'sec-fetch-site': 'cross-site' } })
      expect(res.body?.data?.code, res.text.slice(0, 200)).not.toBe('CSRF_REJECTED')
      expect(res.status, res.text.slice(0, 200)).toBeLessThan(400)
    },
  )

  it.each(mutating.map((route) => ({ key: routeKey(route), route })))('GET and HEAD never run $key', async ({ route }) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await fx.api.request(method, concrete(route.pattern), { origin: FOREIGN_ORIGIN, headers: { 'sec-fetch-site': 'cross-site' } })
      // A same-path GET handler (for example GET /api/rooms/:id) is fine: the state check below proves it changed nothing.
      expect(res.status === 204 || res.status === 201 || res.status === 202, `${method} ${route.pattern}: ${res.status}`).toBe(false)
    }
  })

  it('changed nothing', async () => {
    expect(await state()).toEqual(before)
  })
})
