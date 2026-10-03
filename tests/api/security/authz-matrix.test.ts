/**
 * Authorization matrix (Stage 10, docs/SECURITY.md §4 and §10): every route under server/api × every kind of caller →
 * the documented status and error code. The route list is read from the file tree, so a new handler without a row
 * here fails the inventory test.
 *
 * Callers (`_world.ts`): anonymous, guest of room A, guest of room B, participant, co-host, host, other user, admin, a
 * disabled admin and an admin with a pending password change. The last two are also co-hosts of room A with live rows,
 * so only their account state keeps them out. Each case runs at the subject level: allowed callers send a probe that
 * passes authorization and stops right after it without side effects (an invalid body → 400, an unknown target → 404,
 * nothing to stop → 409), or act on a fresh resource made for that case. The fine-grained in-call matrix (every role ×
 * target) lives in tests/api/calls/authz.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { type CallAction, canPerform } from '#shared/utils/permissions'
import { roomMembers } from '../../../server/database/schema'
import {
  type ApiClient,
  createClient,
  createParticipant,
  createRoom,
  createRoomInvite,
  createSession,
  createUser,
  loginAs,
  testDb,
} from '../_harness'
import { seedReadyRecording } from '../recordings/_support'
import { startMeeting } from '../rooms/_support'
import {
  buildWorld,
  fileRoutes,
  randomUUID,
  routeKey,
  send,
  type SendOptions,
  snapshot,
  type Subject,
  SUBJECTS,
  unknownIdentity,
  type World,
} from './_world'

interface Outcome {
  status: number
  code?: string
}

interface Probe extends SendOptions {
  path: string
  /** Another client of the same subject (a fresh session that the case may end). */
  client?: ApiClient
}

interface Row {
  expect: Record<Subject, Outcome>
  probe(world: World, subject: Subject): Probe | Promise<Probe>
}

const status = (value: number): Outcome => ({ status: value })
const error = (value: number, code: string): Outcome => ({ status: value, code })

const UNAUTHENTICATED = error(401, 'UNAUTHENTICATED')
const FORBIDDEN = error(403, 'FORBIDDEN')
const PASSWORD_CHANGE = error(403, 'AUTH_PASSWORD_CHANGE_REQUIRED')
const INVALID = error(400, 'VALIDATION_FAILED')
const NOT_FOUND = error(404, 'NOT_FOUND')
const ROOM_NOT_FOUND = error(404, 'ROOM_NOT_FOUND')
const NOT_PARTICIPANT = error(403, 'CALL_NOT_PARTICIPANT')
const CALL_FORBIDDEN = error(403, 'CALL_FORBIDDEN')
const RECORDING_NOT_ALLOWED = error(403, 'RECORDING_NOT_ALLOWED')
const CONFLICT = error(409, 'CONFLICT')

/** Not an object: every request schema rejects it after authorization, so allowed callers get 400 and no effect. */
const INVALID_BODY: unknown = []

const SIGNED_IN = ['participant', 'cohost', 'host', 'otherUser', 'admin'] as const
type SignedIn = (typeof SIGNED_IN)[number]

/** `none` routes: the same answer for everyone; a pending password change blocks all but the exempt routes. */
function open(outcome: Outcome, mustChange: Outcome = PASSWORD_CHANGE): Record<Subject, Outcome> {
  return { ...Object.fromEntries(SUBJECTS.map((s) => [s, outcome])), mustChange } as Record<Subject, Outcome>
}

/** `session` routes: guests and disabled accounts are anonymous (401); `users` is the default for signed-in users. */
function session(users: Outcome, overrides: Partial<Record<SignedIn | 'mustChange', Outcome>> = {}): Record<Subject, Outcome> {
  return {
    anonymous: UNAUTHENTICATED,
    guestA: UNAUTHENTICATED,
    guestB: UNAUTHENTICATED,
    disabled: UNAUTHENTICATED,
    ...(Object.fromEntries(SIGNED_IN.map((s) => [s, users])) as Record<SignedIn, Outcome>),
    mustChange: PASSWORD_CHANGE,
    ...overrides,
  }
}

/** Room routes of room A: owner (host) and co-host (`member` level) vs everyone else (404, the room stays hidden). */
function room(level: 'member' | 'owner', allowed: Outcome): Record<Subject, Outcome> {
  return session(ROOM_NOT_FOUND, { host: allowed, cohost: level === 'member' ? allowed : FORBIDDEN })
}

function admin(allowed: Outcome): Record<Subject, Outcome> {
  return session(FORBIDDEN, { admin: allowed })
}

/** Recording A: its recorder (the host, also the room owner) and admins; everyone else gets 404. */
function recording(allowed: Outcome, others: Outcome = NOT_FOUND): Record<Subject, Outcome> {
  return session(others, { host: allowed, admin: allowed })
}

/** Waiting request B: only the guest session that owns it. */
function requestOwner(allowed: Outcome): Record<Subject, Outcome> {
  return { ...open(FORBIDDEN), guestB: allowed }
}

const CALL_ACTORS = {
  host: { identity: 'p_actorhost000000', role: 'host', kind: 'user' },
  cohost: { identity: 'p_actorcohost0000', role: 'cohost', kind: 'user' },
  participant: { identity: 'p_actorpart000000', role: 'participant', kind: 'user' },
  guestA: { identity: 'p_actorguest00000', role: 'participant', kind: 'guest' },
} as const

/**
 * In-call routes of room A. Callers without a live row in its meeting get CALL_NOT_PARTICIPANT; the others follow the
 * permission matrix (`canPerform` with a plain participant as the target).
 */
function call(action: CallAction | null, allowed: Outcome, denied: Outcome = CALL_FORBIDDEN): Record<Subject, Outcome> {
  const inCall = (who: keyof typeof CALL_ACTORS) =>
    !action || canPerform(CALL_ACTORS[who], action, { identity: 'p_target0000000000', role: 'participant' }) ? allowed : denied
  return {
    ...open(NOT_PARTICIPANT),
    host: inCall('host'),
    cohost: inCall('cohost'),
    participant: inCall('participant'),
    guestA: inCall('guestA'),
  }
}

const SESSION_HOLDERS = new Set<Subject>(['participant', 'cohost', 'host', 'otherUser', 'admin', 'mustChange'])

/** A new session of the subject's own account, for cases that end the session they use. */
async function freshClientOf(world: World, subject: Subject): Promise<ApiClient | undefined> {
  if (!SESSION_HOLDERS.has(subject)) return undefined
  const user = world.users[subject as keyof World['users']]
  return loginAs(user)
}

const calls = (world: World, path: string) => `/api/calls/${world.roomA.id}${path}`
/** Targeted in-call routes: an identity nobody has, so allowed moderators get 404 and nothing changes. */
const target = (name: string, action: CallAction): [string, Row] => [
  `POST /api/calls/:roomId/participants/:identity/${name}`,
  { expect: call(action, NOT_FOUND), probe: (w) => ({ path: calls(w, `/participants/${unknownIdentity()}/${name}`), body: INVALID_BODY }) },
]

const ROWS: Record<string, Row> = {
  // ---- Public ------------------------------------------------------------------------------------------------------
  'GET /api/config': { expect: open(status(200), status(200)), probe: () => ({ path: '/api/config' }) },
  'GET /api/health': { expect: open(status(200), status(200)), probe: () => ({ path: '/api/health' }) },
  'GET /api/ready': { expect: open(status(200), status(200)), probe: () => ({ path: '/api/ready' }) },

  // ---- Auth --------------------------------------------------------------------------------------------------------
  'POST /api/auth/login': { expect: open(INVALID), probe: () => ({ path: '/api/auth/login', body: INVALID_BODY }) },
  'POST /api/auth/logout': {
    expect: session(status(204), { mustChange: status(204) }),
    probe: async (w, s) => ({ path: '/api/auth/logout', client: await freshClientOf(w, s) }),
  },
  'GET /api/auth/me': { expect: open(status(200), status(200)), probe: () => ({ path: '/api/auth/me' }) },
  'POST /api/auth/register': { expect: open(INVALID), probe: () => ({ path: '/api/auth/register', body: INVALID_BODY }) },
  'POST /api/auth/verify-email': { expect: open(INVALID), probe: () => ({ path: '/api/auth/verify-email', body: INVALID_BODY }) },
  'POST /api/auth/password': {
    expect: session(INVALID, { mustChange: INVALID }),
    probe: () => ({ path: '/api/auth/password', body: INVALID_BODY }),
  },
  'POST /api/auth/password-reset/request': {
    expect: open(INVALID),
    probe: () => ({ path: '/api/auth/password-reset/request', body: INVALID_BODY }),
  },
  'POST /api/auth/password-reset/confirm': {
    expect: open(INVALID),
    probe: () => ({ path: '/api/auth/password-reset/confirm', body: INVALID_BODY }),
  },
  'POST /api/auth/invites/preview': { expect: open(INVALID), probe: () => ({ path: '/api/auth/invites/preview', body: INVALID_BODY }) },
  'POST /api/auth/invites/accept': { expect: open(INVALID), probe: () => ({ path: '/api/auth/invites/accept', body: INVALID_BODY }) },
  'GET /api/auth/sessions': { expect: session(status(200)), probe: () => ({ path: '/api/auth/sessions' }) },
  'DELETE /api/auth/sessions/:id': {
    // Only the owner of a session can end it; for everyone else it does not exist.
    expect: session(NOT_FOUND, { host: status(204) }),
    probe: async (w, s) => ({ path: `/api/auth/sessions/${s === 'host' ? (await createSession(w.users.host.id)).id : w.hostSpareSession}` }),
  },

  // ---- Me ----------------------------------------------------------------------------------------------------------
  'PATCH /api/me': { expect: session(INVALID), probe: () => ({ path: '/api/me', body: INVALID_BODY }) },

  // ---- Rooms (room A) ----------------------------------------------------------------------------------------------
  'GET /api/rooms': { expect: session(status(200)), probe: () => ({ path: '/api/rooms' }) },
  'POST /api/rooms': { expect: session(INVALID), probe: () => ({ path: '/api/rooms', body: INVALID_BODY }) },
  'GET /api/rooms/:id': { expect: room('member', status(200)), probe: (w) => ({ path: `/api/rooms/${w.roomA.id}` }) },
  'PATCH /api/rooms/:id': { expect: room('owner', INVALID), probe: (w) => ({ path: `/api/rooms/${w.roomA.id}`, body: INVALID_BODY }) },
  'DELETE /api/rooms/:id': {
    expect: room('owner', status(204)),
    probe: async (w, s) => ({ path: `/api/rooms/${s === 'host' ? (await createRoom(w.users.host)).id : w.roomA.id}` }),
  },
  'PUT /api/rooms/:id/key': { expect: room('owner', INVALID), probe: (w) => ({ path: `/api/rooms/${w.roomA.id}/key`, body: INVALID_BODY }) },
  'POST /api/rooms/:id/cohosts': {
    expect: room('owner', INVALID),
    probe: (w) => ({ path: `/api/rooms/${w.roomA.id}/cohosts`, body: INVALID_BODY }),
  },
  'DELETE /api/rooms/:id/cohosts/:userId': {
    expect: room('owner', status(204)),
    probe: async (w, s) => {
      if (s !== 'host') return { path: `/api/rooms/${w.roomA.id}/cohosts/${w.users.cohost.id}` }
      const extra = await createUser()
      await testDb().insert(roomMembers).values({ roomId: w.roomA.id, userId: extra.id })
      return { path: `/api/rooms/${w.roomA.id}/cohosts/${extra.id}` }
    },
  },
  'GET /api/rooms/:id/invites': { expect: room('member', status(200)), probe: (w) => ({ path: `/api/rooms/${w.roomA.id}/invites` }) },
  'POST /api/rooms/:id/invites': {
    expect: room('member', INVALID),
    probe: (w) => ({ path: `/api/rooms/${w.roomA.id}/invites`, body: INVALID_BODY }),
  },
  'DELETE /api/rooms/:id/invites/:inviteId': {
    expect: room('member', status(204)),
    probe: async (w, s) => {
      const invite = s === 'host' || s === 'cohost' ? (await createRoomInvite(w.roomA)).id : w.inviteA.id
      return { path: `/api/rooms/${w.roomA.id}/invites/${invite}` }
    },
  },
  'GET /api/rooms/:id/meetings': { expect: room('member', status(200)), probe: (w) => ({ path: `/api/rooms/${w.roomA.id}/meetings` }) },

  // ---- Join --------------------------------------------------------------------------------------------------------
  'POST /api/join/:slug/info': { expect: open(status(200)), probe: (w) => ({ path: `/api/join/${w.roomA.slug}/info`, body: { proof: w.roomA.proof } }) },
  'POST /api/join/:slug': { expect: open(INVALID), probe: (w) => ({ path: `/api/join/${w.roomA.slug}`, body: INVALID_BODY }) },
  'GET /api/join/requests/:id/events': {
    expect: requestOwner(status(200)),
    probe: (w) => ({ path: `/api/join/requests/${w.requestB}/events` }),
  },
  'POST /api/join/requests/:id/cancel': {
    expect: requestOwner(status(204)),
    probe: async (w, s) => {
      if (s !== 'guestB') return { path: `/api/join/requests/${w.requestB}/cancel` }
      const fresh = await createParticipant({ room: w.roomB, meeting: { id: w.meetingB }, guestSessionId: w.guestB.sessionId, status: 'waiting' })
      return { path: `/api/join/requests/${fresh.id}/cancel` }
    },
  },

  // ---- In-call (room A) --------------------------------------------------------------------------------------------
  'POST /api/calls/:roomId/me/name': { expect: call('self.rename', INVALID), probe: (w) => ({ path: calls(w, '/me/name'), body: INVALID_BODY }) },
  'POST /api/calls/:roomId/me/hand': { expect: call('self.hand', INVALID), probe: (w) => ({ path: calls(w, '/me/hand'), body: INVALID_BODY }) },
  'GET /api/calls/:roomId/participants': { expect: call(null, status(200)), probe: (w) => ({ path: calls(w, '/participants') }) },
  'GET /api/calls/:roomId/lobby': { expect: call('lobby.view', status(200)), probe: (w) => ({ path: calls(w, '/lobby') }) },
  'POST /api/calls/:roomId/lobby/:requestId/admit': {
    expect: call('lobby.admit', NOT_FOUND),
    probe: (w) => ({ path: calls(w, `/lobby/${randomUUID()}/admit`) }),
  },
  'POST /api/calls/:roomId/lobby/:requestId/deny': {
    expect: call('lobby.deny', NOT_FOUND),
    probe: (w) => ({ path: calls(w, `/lobby/${randomUUID()}/deny`) }),
  },
  // Room A's lobby is empty, so admitting everyone changes nothing.
  'POST /api/calls/:roomId/lobby/admit-all': { expect: call('lobby.admit', status(200)), probe: (w) => ({ path: calls(w, '/lobby/admit-all') }) },
  ...Object.fromEntries([
    target('mute', 'participant.mute'),
    target('permissions', 'participant.permissions'),
    target('ask-unmute', 'participant.askUnmute'),
    target('volume', 'participant.volume'),
    target('remove', 'participant.remove'),
    target('role', 'participant.role'),
    target('name', 'participant.rename'),
    target('lower-hand', 'participant.lowerHand'),
  ]),
  'POST /api/calls/:roomId/mute-all': { expect: call('call.muteAll', INVALID), probe: (w) => ({ path: calls(w, '/mute-all'), body: INVALID_BODY }) },
  'PATCH /api/calls/:roomId/settings': { expect: call('call.lock', INVALID), probe: (w) => ({ path: calls(w, '/settings'), body: INVALID_BODY }) },
  'POST /api/calls/:roomId/end': {
    expect: call('call.end', status(204)),
    probe: async (w, s) => {
      if (s !== 'host') return { path: calls(w, '/end') }
      const fresh = await createRoom(w.users.host, { waitingRoom: false })
      const joined = await startMeeting(fresh, w.users.host)
      return { path: `/api/calls/${fresh.id}/end`, client: joined.api }
    },
  },
  'POST /api/calls/:roomId/recording/start': {
    expect: call('recording.start', INVALID, RECORDING_NOT_ALLOWED),
    probe: (w) => ({ path: calls(w, '/recording/start'), body: INVALID_BODY }),
  },
  // Nothing records in room A: allowed callers reach "not recording".
  'POST /api/calls/:roomId/recording/stop': {
    expect: call('recording.stop', CONFLICT, RECORDING_NOT_ALLOWED),
    probe: (w) => ({ path: calls(w, '/recording/stop') }),
  },

  // ---- Recordings (recording A: ready, made by the host) -----------------------------------------------------------
  'GET /api/recordings': { expect: session(status(200)), probe: () => ({ path: '/api/recordings' }) },
  'GET /api/recordings/:id': { expect: recording(status(200)), probe: (w) => ({ path: `/api/recordings/${w.recordingA}` }) },
  'DELETE /api/recordings/:id': {
    expect: recording(status(204)),
    probe: async (w, s) => {
      if (s !== 'host' && s !== 'admin') return { path: `/api/recordings/${w.recordingA}` }
      const fresh = await seedReadyRecording({ createdBy: w.users.host.id, roomId: w.roomA.id })
      return { path: `/api/recordings/${fresh.id}` }
    },
  },
  // Only the recorder uploads (unknown and foreign ids look the same: 403); a ready recording takes no more chunks.
  'PUT /api/recordings/:id/chunks/:seq': {
    expect: session(FORBIDDEN, { host: CONFLICT }),
    probe: (w) => ({
      path: `/api/recordings/${w.recordingA}/chunks/0`,
      raw: new Uint8Array([1, 2, 3]),
      headers: { 'content-type': 'application/octet-stream' },
    }),
  },
  'POST /api/recordings/:id/complete': {
    expect: session(FORBIDDEN, { host: CONFLICT }),
    probe: (w) => ({ path: `/api/recordings/${w.recordingA}/complete`, body: { chunkCount: 1, durationMs: 1000 } }),
  },
  'GET /api/recordings/:id/file': { expect: recording(status(200)), probe: (w) => ({ path: `/api/recordings/${w.recordingA}/file` }) },

  // ---- Admin (random ids answer 404 after the role check, so admins change nothing) ------------------------------
  'GET /api/admin/audit': { expect: admin(status(200)), probe: () => ({ path: '/api/admin/audit' }) },
  'GET /api/admin/invites': { expect: admin(status(200)), probe: () => ({ path: '/api/admin/invites' }) },
  'POST /api/admin/invites': { expect: admin(INVALID), probe: () => ({ path: '/api/admin/invites', body: INVALID_BODY }) },
  'DELETE /api/admin/invites/:id': { expect: admin(NOT_FOUND), probe: () => ({ path: `/api/admin/invites/${randomUUID()}` }) },
  'GET /api/admin/recordings': { expect: admin(status(200)), probe: () => ({ path: '/api/admin/recordings' }) },
  'DELETE /api/admin/recordings/:id': { expect: admin(NOT_FOUND), probe: () => ({ path: `/api/admin/recordings/${randomUUID()}` }) },
  'GET /api/admin/rooms': { expect: admin(status(200)), probe: () => ({ path: '/api/admin/rooms' }) },
  'DELETE /api/admin/rooms/:id': { expect: admin(NOT_FOUND), probe: () => ({ path: `/api/admin/rooms/${randomUUID()}` }) },
  'POST /api/admin/rooms/:id/end': { expect: admin(NOT_FOUND), probe: () => ({ path: `/api/admin/rooms/${randomUUID()}/end` }) },
  'GET /api/admin/rooms/:id/meetings': { expect: admin(status(200)), probe: (w) => ({ path: `/api/admin/rooms/${w.roomA.id}/meetings` }) },
  'GET /api/admin/settings': { expect: admin(status(200)), probe: () => ({ path: '/api/admin/settings' }) },
  'PUT /api/admin/settings': { expect: admin(INVALID), probe: () => ({ path: '/api/admin/settings', body: INVALID_BODY }) },
  'POST /api/admin/settings/test-email': { expect: admin(INVALID), probe: () => ({ path: '/api/admin/settings/test-email', body: INVALID_BODY }) },
  'GET /api/admin/users': { expect: admin(status(200)), probe: () => ({ path: '/api/admin/users' }) },
  'POST /api/admin/users': { expect: admin(INVALID), probe: () => ({ path: '/api/admin/users', body: INVALID_BODY }) },
  'GET /api/admin/users/:id': { expect: admin(status(200)), probe: (w) => ({ path: `/api/admin/users/${w.users.otherUser.id}` }) },
  'PATCH /api/admin/users/:id': { expect: admin(INVALID), probe: (w) => ({ path: `/api/admin/users/${w.users.otherUser.id}`, body: INVALID_BODY }) },
  'DELETE /api/admin/users/:id': { expect: admin(NOT_FOUND), probe: () => ({ path: `/api/admin/users/${randomUUID()}` }) },
  'POST /api/admin/users/:id/reset-password': {
    expect: admin(NOT_FOUND),
    probe: () => ({ path: `/api/admin/users/${randomUUID()}/reset-password`, body: {} }),
  },
  'POST /api/admin/users/:id/revoke-sessions': {
    expect: admin(NOT_FOUND),
    probe: () => ({ path: `/api/admin/users/${randomUUID()}/revoke-sessions` }),
  },

  // ---- Webhooks: signature only, whoever calls (and exempt from the password-change guard) -------------------------
  'POST /api/webhooks/livekit': {
    expect: open(UNAUTHENTICATED, UNAUTHENTICATED),
    probe: () => ({ path: '/api/webhooks/livekit', raw: '{}', origin: null, headers: { 'content-type': 'application/webhook+json' } }),
  },
}

/** A copy of the subject's client, so cookie changes from one case (a cleared or rotated cookie) never leak. */
function copyOf(client: ApiClient): ApiClient {
  const copy = createClient({ ip: client.ip })
  for (const [name, value] of client.cookies) copy.setCookie(name, value)
  return copy
}

const routes = fileRoutes()

describe('route inventory', () => {
  it('has a row for every handler under server/api, and no row without a handler', () => {
    const files = new Set(routes.map(routeKey))
    expect(routes.length).toBeGreaterThanOrEqual(78)
    expect(routes.filter((route) => !ROWS[routeKey(route)]).map((route) => route.file), 'handlers missing from the matrix').toEqual([])
    expect(Object.keys(ROWS).filter((key) => !files.has(key)), 'matrix rows without a handler').toEqual([])
  })
})

describe('authorization matrix', () => {
  let world: World
  let before: Awaited<ReturnType<typeof snapshot>>

  beforeAll(async () => {
    world = await buildWorld()
    before = await snapshot(world)
  })

  const cases = routes
    .filter((route) => ROWS[routeKey(route)])
    .flatMap((route) =>
      SUBJECTS.map((subject) => {
        const outcome = ROWS[routeKey(route)]!.expect[subject]
        return { key: routeKey(route), method: route.method, subject, outcome, expected: `${outcome.status}${outcome.code ? ` ${outcome.code}` : ''}` }
      }),
    )

  it.each(cases)('$key as $subject → $expected', async ({ key, method, subject, outcome }) => {
    const probe = await ROWS[key]!.probe(world, subject)
    const client = probe.client ?? copyOf(world.clients[subject])
    const res = await send(client, method, probe.path, probe)
    const context = `${key} as ${subject}: ${res.text.slice(0, 300)}`
    expect(res.status, context).toBe(outcome.status)
    if (outcome.code) expect(res.body?.data?.code, context).toBe(outcome.code)
  })

  it('left the shared rooms, rows, sessions and settings as they were', async () => {
    // Every allowed case acted on its own fresh resource and every refused one changed nothing.
    expect(await snapshot(world)).toEqual(before)
  })
})
