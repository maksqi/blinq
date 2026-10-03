/**
 * IDOR (Stage 10, docs/SECURITY.md §4 "Object access is always scoped by owner or role"): an attacker with a normal
 * account, their own room and a live meeting reaches for the victim's rooms, invites, meetings, recordings, sessions,
 * waiting requests and participants by id. Every request is well-formed, so only the object-level check can stop it,
 * and each case also proves that nothing changed (rows and the fake LiveKit's calls).
 */
import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { deriveJoinProof, generateRoomKey } from '../../../app/lib/e2ee'
import { callParticipants, recordings, roomInvites, roomMembers, rooms, users } from '../../../server/database/schema'
import {
  type ApiClient,
  createAdmin,
  createClient,
  createGuestSession,
  createParticipant,
  createRoom,
  createRoomInvite,
  createSession,
  createUser,
  expectApiError,
  loginAs,
  testDb,
  type TestRoom,
  type TestUser,
} from '../_harness'
import { seedReadyRecording } from '../recordings/_support'
import { join, newClientId, participantRow, startMeeting } from '../rooms/_support'
import { livekitWrites } from './_world'

interface Side {
  owner: TestUser
  api: ApiClient
  room: TestRoom
  meetingId: string
  identity: string
}

async function side(name: string): Promise<Side> {
  const owner = await createUser({ displayName: name })
  const room = await createRoom(owner, { waitingRoom: false })
  const joined = await startMeeting(room, owner)
  const row = await participantRow(joined.identity)
  return { owner, api: joined.api, room, meetingId: row!.meetingId!, identity: joined.identity }
}

let victim: Side
let attacker: Side
let cohost: TestUser
let cohostApi: ApiClient
let participant: { user: TestUser; api: ApiClient; identity: string; rowId: string }
let invite: { id: string; token: string }
let guestRequest: { id: string; cookie: { name: string; value: string } }
let userRequest: { id: string; owner: ApiClient }
let victimRecording: string
let activeRecording: string
let cohostRecording: string

async function roomRow(id: string) {
  const [row] = await testDb().select().from(rooms).where(eq(rooms.id, id))
  return row!
}

async function statusOf(rowId: string) {
  const [row] = await testDb().select().from(callParticipants).where(eq(callParticipants.id, rowId))
  return row?.status
}

beforeAll(async () => {
  victim = await side('Vera Victim')
  attacker = await side('Mallory Attacker')

  cohost = await createUser({ displayName: 'Cora Cohost' })
  await testDb().insert(roomMembers).values({ roomId: victim.room.id, userId: cohost.id })
  cohostApi = await loginAs(cohost)

  const participantUser = await createUser({ displayName: 'Pia Participant' })
  const row = await createParticipant({ room: victim.room, meeting: { id: victim.meetingId }, userId: participantUser.id, status: 'joined', displayName: participantUser.displayName })
  participant = { user: participantUser, api: await loginAs(participantUser), identity: row.lkIdentity, rowId: row.id }

  invite = await createRoomInvite(victim.room)

  const guest = await createGuestSession(victim.room)
  const waiting = await createParticipant({ room: victim.room, meeting: { id: victim.meetingId }, guestSessionId: guest.id, status: 'waiting' })
  guestRequest = { id: waiting.id, cookie: { name: guest.cookieName, value: guest.token } }
  const waitingUser = await createUser()
  const waitingUserRow = await createParticipant({ room: victim.room, meeting: { id: victim.meetingId }, userId: waitingUser.id, status: 'waiting' })
  userRequest = { id: waitingUserRow.id, owner: await loginAs(waitingUser) }

  victimRecording = (await seedReadyRecording({ createdBy: victim.owner.id, roomId: victim.room.id })).id
  cohostRecording = (await seedReadyRecording({ createdBy: cohost.id, roomId: victim.room.id })).id
  const [active] = await testDb()
    .insert(recordings)
    .values({ roomId: victim.room.id, meetingId: victim.meetingId, createdBy: victim.owner.id, mode: 'server', status: 'recording', sourceMime: 'video/webm' })
    .returning()
  activeRecording = active!.id
})

describe('rooms', () => {
  const ownerRoutes = (): Array<[string, string, unknown]> => [
    ['GET', '', undefined],
    ['PATCH', '', { name: 'Taken over', waitingRoom: false, allowGuests: true, password: null }],
    ['DELETE', '', undefined],
    ['POST', '/cohosts', { userId: attacker.owner.id }],
    ['DELETE', `/cohosts/${cohost.id}`, undefined],
    ['GET', '/invites', undefined],
    ['POST', '/invites', { expiresIn: 'never', maxUses: null }],
    ['DELETE', `/invites/${invite.id}`, undefined],
    ['GET', '/meetings', undefined],
  ]

  it('hides another user\'s room behind 404 ROOM_NOT_FOUND for every owner route, and changes nothing', async () => {
    const before = await roomRow(victim.room.id)
    for (const [method, suffix, body] of ownerRoutes()) {
      const res = await attacker.api.request(method, `/api/rooms/${victim.room.id}${suffix}`, body === undefined ? {} : { body })
      expectApiError(res, 404, 'ROOM_NOT_FOUND')
    }
    // Rotating the key needs a valid proof of a new key, which the attacker can make for any slug.
    const proof = await deriveJoinProof(generateRoomKey(), victim.room.slug)
    expectApiError(await attacker.api.put(`/api/rooms/${victim.room.id}/key`, { body: { proof } }), 404, 'ROOM_NOT_FOUND')

    expect(await roomRow(victim.room.id)).toEqual(before)
    const members = await testDb().select().from(roomMembers).where(eq(roomMembers.roomId, victim.room.id))
    expect(members.map((m) => m.userId)).toEqual([cohost.id])
    const [inviteRow] = await testDb().select().from(roomInvites).where(eq(roomInvites.id, invite.id))
    expect(inviteRow!.revokedAt).toBeNull()
    expect((await testDb().select().from(roomInvites).where(eq(roomInvites.roomId, victim.room.id))).length).toBe(1)
  })

  it('lists only the caller\'s own and co-hosted rooms', async () => {
    const own = await attacker.api.get('/api/rooms', { query: { pageSize: 100 } })
    expect(own.status).toBe(200)
    expect(own.body.items.map((r: { id: string }) => r.id)).toEqual([attacker.room.id])
    const cohosted = await cohostApi.get('/api/rooms', { query: { pageSize: 100 } })
    expect(cohosted.body.items.map((r: { id: string }) => r.id)).toEqual([victim.room.id])
  })

  it('does not open owner routes to admins or participants of the room (they get 404 too)', async () => {
    const admin = await loginAs(await createAdmin())
    expectApiError(await admin.get(`/api/rooms/${victim.room.id}`), 404, 'ROOM_NOT_FOUND')
    // Room invite tokens are for the owner and co-hosts only, never for admins.
    expectApiError(await admin.get(`/api/rooms/${victim.room.id}/invites`), 404, 'ROOM_NOT_FOUND')
    expectApiError(await participant.api.get(`/api/rooms/${victim.room.id}`), 404, 'ROOM_NOT_FOUND')
    expectApiError(await participant.api.get(`/api/rooms/${victim.room.id}/invites`), 404, 'ROOM_NOT_FOUND')
  })
})

describe('room invites and co-hosts through the attacker\'s own room', () => {
  it('cannot revoke another room\'s invite or remove another room\'s co-host', async () => {
    expectApiError(await attacker.api.delete(`/api/rooms/${attacker.room.id}/invites/${invite.id}`), 404, 'NOT_FOUND')
    expectApiError(await attacker.api.delete(`/api/rooms/${attacker.room.id}/cohosts/${cohost.id}`), 404, 'NOT_FOUND')
    const [inviteRow] = await testDb().select().from(roomInvites).where(eq(roomInvites.id, invite.id))
    expect(inviteRow!.revokedAt).toBeNull()
    const [member] = await testDb()
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, victim.room.id), eq(roomMembers.userId, cohost.id)))
    expect(member).toBeDefined()
  })

  it('never lists another room\'s invites', async () => {
    const res = await attacker.api.get(`/api/rooms/${attacker.room.id}/invites`)
    expect(res.status).toBe(200)
    expect(res.text).not.toContain(invite.id)
    expect(res.text).not.toContain(invite.token)
  })

  it('binds invite tokens to their room: another room\'s token is ROOM_INVITE_INVALID and is not used up', async () => {
    const guest = createClient()
    const info = await guest.post(`/api/join/${attacker.room.slug}/info`, { body: { proof: attacker.room.proof, inviteToken: invite.token } })
    expectApiError(info, 403, 'ROOM_INVITE_INVALID')
    const res = await join(guest, attacker.room, { inviteToken: invite.token, displayName: 'Gate Crasher' })
    expectApiError(res, 403, 'ROOM_INVITE_INVALID')
    const [inviteRow] = await testDb().select().from(roomInvites).where(eq(roomInvites.id, invite.id))
    expect(inviteRow!.useCount).toBe(0)
  })
})

describe('meetings', () => {
  it('shows a room\'s meetings to its owner and admins only', async () => {
    expectApiError(await attacker.api.get(`/api/rooms/${victim.room.id}/meetings`), 404, 'ROOM_NOT_FOUND')
    const own = await attacker.api.get(`/api/rooms/${attacker.room.id}/meetings`)
    expect(own.body.items.map((m: { id: string }) => m.id)).toEqual([attacker.meetingId])
    expectApiError(await attacker.api.get(`/api/admin/rooms/${victim.room.id}/meetings`), 403, 'FORBIDDEN')
    const admin = await loginAs(await createAdmin())
    const res = await admin.get(`/api/admin/rooms/${victim.room.id}/meetings`)
    expect(res.body.items.map((m: { id: string }) => m.id)).toEqual([victim.meetingId])
  })
})

describe('recordings', () => {
  it('hides another user\'s recording (metadata, file, download, delete) behind 404', async () => {
    for (const api of [attacker.api, participant.api, cohostApi]) {
      expectApiError(await api.get(`/api/recordings/${victimRecording}`), 404, 'NOT_FOUND')
      expectApiError(await api.get(`/api/recordings/${victimRecording}/file`), 404, 'NOT_FOUND')
      expectApiError(await api.get(`/api/recordings/${victimRecording}/file`, { query: { download: 1 } }), 404, 'NOT_FOUND')
      expectApiError(await api.delete(`/api/recordings/${victimRecording}`), 404, 'NOT_FOUND')
    }
    const [row] = await testDb().select().from(recordings).where(eq(recordings.id, victimRecording))
    expect(row?.status).toBe('ready')
  })

  it('refuses chunks and completion of another user\'s upload with 403 (no existence oracle)', async () => {
    const chunk = await attacker.api.put(`/api/recordings/${activeRecording}/chunks/0`, {
      raw: new Uint8Array(randomBytes(64)),
      headers: { 'content-type': 'application/octet-stream' },
    })
    expectApiError(chunk, 403, 'FORBIDDEN')
    expectApiError(await attacker.api.post(`/api/recordings/${activeRecording}/complete`, { body: { chunkCount: 1, durationMs: 1000 } }), 403, 'FORBIDDEN')
    // The room owner is not the recorder either: only the recorder uploads.
    expectApiError(
      await cohostApi.put(`/api/recordings/${activeRecording}/chunks/0`, { raw: new Uint8Array(8), headers: { 'content-type': 'application/octet-stream' } }),
      403,
      'FORBIDDEN',
    )
    const [row] = await testDb().select().from(recordings).where(eq(recordings.id, activeRecording))
    expect(row).toMatchObject({ status: 'recording', chunkCount: 0, uploadedBytes: 0 })
  })

  it('lists only the caller\'s recordings and those of rooms they own', async () => {
    const attackerList = await attacker.api.get('/api/recordings', { query: { pageSize: 100 } })
    expect(attackerList.body.items).toEqual([])
    const ownerList = await victim.api.get('/api/recordings', { query: { pageSize: 100 } })
    const ids = ownerList.body.items.map((r: { id: string }) => r.id)
    expect(ids).toEqual(expect.arrayContaining([victimRecording, cohostRecording]))
    const cohostList = await cohostApi.get('/api/recordings', { query: { pageSize: 100 } })
    expect(cohostList.body.items.map((r: { id: string }) => r.id)).toEqual([cohostRecording])
  })

  it('lets the room owner read a co-host\'s recording of that room, and the co-host only their own', async () => {
    expect((await victim.api.get(`/api/recordings/${cohostRecording}`)).status).toBe(200)
    expect((await cohostApi.get(`/api/recordings/${cohostRecording}`)).status).toBe(200)
    expectApiError(await attacker.api.get(`/api/recordings/${cohostRecording}`), 404, 'NOT_FOUND')
  })
})

describe('sessions', () => {
  it('cannot list or end another user\'s session', async () => {
    const victimSession = await createSession(victim.owner.id)
    const res = await attacker.api.delete(`/api/auth/sessions/${victimSession.id}`)
    expectApiError(res, 404, 'NOT_FOUND')
    const replay = createClient().setCookie(victimSession.cookieName, victimSession.token)
    expect((await replay.get('/api/auth/me')).body.user?.id).toBe(victim.owner.id)

    const listed = await attacker.api.get('/api/auth/sessions')
    expect(listed.status).toBe(200)
    const ids = listed.body.items.map((s: { id: string }) => s.id)
    expect(ids).toContain(attacker.api.session!.id)
    expect(ids).not.toContain(victimSession.id)
    expect(ids).not.toContain(victim.api.session!.id)
  })
})

describe('waiting-room requests', () => {
  it('cannot admit or deny another room\'s request through the attacker\'s own call', async () => {
    for (const action of ['admit', 'deny']) {
      for (const id of [guestRequest.id, userRequest.id]) {
        expectApiError(await attacker.api.post(`/api/calls/${attacker.room.id}/lobby/${id}/${action}`), 404, 'NOT_FOUND')
      }
    }
    const admitted = await attacker.api.post(`/api/calls/${attacker.room.id}/lobby/admit-all`)
    expect(admitted.body).toEqual({ admitted: 0 })
    expect(await statusOf(guestRequest.id)).toBe('waiting')
    expect(await statusOf(userRequest.id)).toBe('waiting')
  })

  it('opens the waiting-room stream and cancel only to the session or guest cookie that owns the request', async () => {
    const guestOwner = createClient().setCookie(guestRequest.cookie.name, guestRequest.cookie.value)
    const strangers = [attacker.api, victim.api, cohostApi, createClient(), guestOwner]
    for (const [id, owner] of [
      [guestRequest.id, guestOwner],
      [userRequest.id, userRequest.owner],
    ] as const) {
      for (const stranger of strangers.filter((client) => client !== owner)) {
        expectApiError(await stranger.post(`/api/join/requests/${id}/cancel`), 403, 'FORBIDDEN')
        const stream = await fetch(new URL(`/api/join/requests/${id}/events`, stranger.baseUrl), {
          headers: { cookie: stranger.cookieHeader(), 'x-forwarded-for': stranger.ip, accept: 'text/event-stream' },
        })
        expect(stream.status).toBe(403)
        expect((await stream.json()).data.code).toBe('FORBIDDEN')
      }
      expect(await statusOf(id)).toBe('waiting')
    }
  })

  it('does not accept a guest cookie copied under another room\'s cookie name', async () => {
    const renamed = createClient().setCookie(guestRequest.cookie.name.replace(victim.room.slug, attacker.room.slug), guestRequest.cookie.value)
    expectApiError(await renamed.post(`/api/join/requests/${guestRequest.id}/cancel`), 403, 'FORBIDDEN')
    expect(await statusOf(guestRequest.id)).toBe('waiting')
  })
})

describe('participant identities from another room', () => {
  const actions: Array<[string, unknown]> = [
    ['mute', { source: 'microphone' }],
    ['permissions', { microphone: false, camera: false }],
    ['ask-unmute', undefined],
    ['volume', { level: 0 }],
    ['remove', undefined],
    ['role', { role: 'cohost' }],
    ['name', { displayName: 'Renamed by Mallory' }],
    ['lower-hand', undefined],
  ]

  it('answers 404 NOT_FOUND for every targeted action on an identity of another meeting and touches nothing', async () => {
    const before = await participantRow(participant.identity)
    const callsBefore = await livekitWrites(victim.room.id)
    for (const [action, body] of actions) {
      const res = await attacker.api.post(`/api/calls/${attacker.room.id}/participants/${participant.identity}/${action}`, body === undefined ? {} : { body })
      expectApiError(res, 404, 'NOT_FOUND')
    }
    // The victim's host is not a target in the attacker's meeting either.
    expectApiError(await attacker.api.post(`/api/calls/${attacker.room.id}/participants/${victim.identity}/remove`), 404, 'NOT_FOUND')
    expect(await participantRow(participant.identity)).toEqual(before)
    expect(await livekitWrites(victim.room.id)).toEqual(callsBefore)
  })

  it('refuses every in-call route of a room the caller is not in (CALL_NOT_PARTICIPANT)', async () => {
    const base = `/api/calls/${victim.room.id}`
    for (const [method, path, body] of [
      ['GET', '/participants', undefined],
      ['GET', '/lobby', undefined],
      ['POST', `/participants/${participant.identity}/remove`, undefined],
      ['POST', '/mute-all', { preventSelfUnmute: true }],
      ['PATCH', '/settings', { locked: true }],
      ['POST', '/end', undefined],
      ['POST', '/recording/start', { mode: 'local' }],
      ['POST', '/recording/stop', undefined],
    ] as const) {
      expectApiError(await attacker.api.request(method, `${base}${path}`, body === undefined ? {} : { body }), 403, 'CALL_NOT_PARTICIPANT')
    }
    expect(await statusOf(participant.rowId)).toBe('joined')
  })

  it('does not let a guest of one room act in another room with a renamed cookie', async () => {
    const guest = await createGuestSession(attacker.room)
    await createParticipant({ room: attacker.room, meeting: { id: attacker.meetingId }, guestSessionId: guest.id, status: 'joined' })
    const renamed = createClient().setCookie(guest.cookieName.replace(attacker.room.slug, victim.room.slug), guest.token)
    expectApiError(await renamed.get(`/api/calls/${victim.room.id}/participants`), 403, 'CALL_NOT_PARTICIPANT')
    // The same cookie under its own name works in its own room.
    const own = createClient().setCookie(guest.cookieName, guest.token)
    expect((await own.get(`/api/calls/${attacker.room.id}/participants`)).status).toBe(200)
  })

  it('exposes no user ids, emails or guest session ids to people in the call', async () => {
    const res = await participant.api.get(`/api/calls/${victim.room.id}/participants`)
    expect(res.status).toBe(200)
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(
        ['cameraAllowed', 'displayName', 'handRaisedAt', 'identity', 'joinedAt', 'kind', 'micAllowed', 'role', 'volumeLevel'].sort(),
      )
    }
    for (const secret of [victim.owner.id, victim.owner.email, participant.user.id, participant.user.email, cohost.email]) {
      expect(res.text).not.toContain(secret)
    }
  })
})

describe('admin resources', () => {
  it('refuses admin objects to a signed-in user and leaves the target unchanged', async () => {
    expectApiError(await attacker.api.get(`/api/admin/users/${victim.owner.id}`), 403, 'FORBIDDEN')
    expectApiError(await attacker.api.patch(`/api/admin/users/${victim.owner.id}`, { body: { disabled: true } }), 403, 'FORBIDDEN')
    expectApiError(await attacker.api.patch(`/api/admin/users/${attacker.owner.id}`, { body: { role: 'admin' } }), 403, 'FORBIDDEN')
    expectApiError(await attacker.api.delete(`/api/admin/rooms/${victim.room.id}`), 403, 'FORBIDDEN')
    expectApiError(await attacker.api.delete(`/api/admin/recordings/${victimRecording}`), 403, 'FORBIDDEN')
    const rows = await testDb().select().from(users).where(eq(users.id, victim.owner.id))
    expect(rows[0]).toMatchObject({ role: 'user', disabledAt: null })
    const self = await testDb().select().from(users).where(eq(users.id, attacker.owner.id))
    expect(self[0]!.role).toBe('user')
    expect((await roomRow(victim.room.id)).deletedAt).toBeNull()
  })

  it('never puts room keys, proofs, password hashes or invite tokens into admin responses', async () => {
    const admin = await loginAs(await createAdmin())
    await testDb().update(rooms).set({ passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g' }).where(eq(rooms.id, victim.room.id))
    const room = await roomRow(victim.room.id)
    const [user] = await testDb().select().from(users).where(eq(users.id, victim.owner.id))
    const responses = [
      await admin.get('/api/admin/rooms', { query: { q: victim.room.name, pageSize: 100 } }),
      await admin.get(`/api/admin/users/${victim.owner.id}`),
      await admin.get('/api/admin/users', { query: { q: victim.owner.email } }),
      await admin.get('/api/admin/invites', { query: { pageSize: 100 } }),
      await admin.get('/api/admin/recordings', { query: { pageSize: 100 } }),
      await admin.get('/api/admin/audit', { query: { pageSize: 100 } }),
    ]
    const listed = responses[0]!.body.items.find((item: { id: string }) => item.id === victim.room.id)
    expect(listed).toBeDefined()
    expect(Object.keys(listed).sort()).toEqual(['createdAt', 'ephemeral', 'id', 'lastActiveAt', 'live', 'name', 'owner', 'participantCount', 'slug'])
    for (const res of responses) {
      expect(res.status, res.text).toBe(200)
      for (const secret of [victim.room.key, victim.room.proof, room.joinProofHash, room.passwordHash!, user!.passwordHash!, invite.token]) {
        expect(res.text).not.toContain(secret)
      }
      expect(res.text).not.toMatch(/"(?:passwordHash|joinProofHash|tokenHash|proof|token)"/)
    }
  })
})

describe('joining as someone else', () => {
  it('ignores a session cookie for a room the user cannot moderate: a signed-in stranger still needs an invite', async () => {
    const res = await join(attacker.api, victim.room, { clientId: newClientId() })
    expectApiError(res, 403, 'ROOM_INVITE_REQUIRED')
  })
})
