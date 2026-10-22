/**
 * Rooms CRUD, co-hosts, invites and meetings history (docs/API.md §5): owner-only mutations, 404 for everyone who is
 * neither owner nor co-host, the room limit and duplicate slugs.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { deriveJoinProof, generateRoomKey, generateSlug } from '../../../app/lib/e2ee'
import { meetings, roomMembers, rooms } from '../../../server/database/schema'
import { hashToken } from '../../../server/utils/crypto'
import { inviteIdFromToken } from '../../../server/services/invites/token'
import {
  createClient,
  createRoom,
  createUser,
  expectApiError,
  loginAs,
  serverEnv,
  testDb,
  uniqueName,
} from '../_harness'
import { livekitCalls, startMeeting, usesFakeLivekit } from './_support'

async function roomBody(extra: Record<string, unknown> = {}) {
  const slug = generateSlug()
  return { slug, name: uniqueName('Room'), proof: await deriveJoinProof(generateRoomKey(), slug), ...extra }
}

async function withCohost() {
  const owner = await createUser()
  const cohost = await createUser()
  const room = await createRoom(owner)
  await testDb().insert(roomMembers).values({ roomId: room.id, userId: cohost.id })
  return { owner, cohost, room }
}

describe('POST /api/rooms', () => {
  it('creates a room from the browser-generated slug and proof, storing only sha256(proof)', async () => {
    const owner = await createUser()
    const api = await loginAs(owner)
    const body = await roomBody({ waitingRoom: false, password: 'room-pass', maxParticipants: 10, ephemeral: true })
    const res = await api.post('/api/rooms', { body })
    expect(res.status, res.text).toBe(201)
    expect(res.body.room).toMatchObject({
      slug: body.slug,
      name: body.name,
      ephemeral: true,
      isOwner: true,
      role: 'host',
      hasPassword: true,
      waitingRoom: false,
      live: false,
      participantCount: 0,
      maxParticipants: 10,
      allowGuests: true,
      locked: false,
      keyVersion: 1,
      cohosts: [],
    })
    expect(JSON.stringify(res.body)).not.toContain(body.proof)
    const [row] = await testDb().select().from(rooms).where(eq(rooms.id, res.body.room.id))
    expect(row!.joinProofHash).toBe(hashToken(body.proof))
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/)
    expect(row!.ownerId).toBe(owner.id)
  })

  it('answers 409 CONFLICT slug_taken for a slug in use (the client retries with a new one)', async () => {
    const other = await createRoom(await createUser())
    const api = await loginAs(await createUser())
    const res = await api.post('/api/rooms', { body: await roomBody({ slug: other.slug }) })
    expectApiError(res, 409, 'CONFLICT')
    expect(res.body.data.details).toEqual({ reason: 'slug_taken' })
  })

  it('enforces limits.maxRoomsPerUser (deleted rooms do not count)', async () => {
    const owner = await createUser()
    await testDb()
      .insert(rooms)
      .values(
        Array.from({ length: 50 }, (_, i) => ({
          slug: generateSlug(),
          name: `Bulk ${i}`,
          ownerId: owner.id,
          joinProofHash: hashToken(`bulk-${i}`),
          deletedAt: i === 0 ? new Date() : null,
        })),
      )
    const api = await loginAs(owner)
    expect((await api.post('/api/rooms', { body: await roomBody() })).status).toBe(201)
    expectApiError(await api.post('/api/rooms', { body: await roomBody() }), 409, 'ROOM_LIMIT_REACHED')
  })

  it('needs a session and a valid body', async () => {
    expectApiError(await createClient().post('/api/rooms', { body: await roomBody() }), 401, 'UNAUTHENTICATED')
    const api = await loginAs(await createUser())
    expectApiError(await api.post('/api/rooms', { body: await roomBody({ slug: 'not-a-slug' }) }), 400, 'VALIDATION_FAILED')
    expectApiError(await api.post('/api/rooms', { body: await roomBody({ proof: 'short' }) }), 400, 'VALIDATION_FAILED')
    expectApiError(await api.post('/api/rooms', { body: await roomBody({ maxParticipants: 26 }) }), 400, 'VALIDATION_FAILED')
  })
})

describe('GET /api/rooms and /api/rooms/:id', () => {
  it('lists owned and co-hosted rooms only, with the caller role', async () => {
    const { owner, cohost, room } = await withCohost()
    const own = await createRoom(cohost, { name: uniqueName('Own') })
    await createRoom(await createUser())
    await createRoom(cohost, { deletedAt: new Date() })
    const res = await (await loginAs(cohost)).get('/api/rooms')
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(2)
    const byId = Object.fromEntries(res.body.items.map((item: { id: string }) => [item.id, item]))
    expect(byId[own.id]).toMatchObject({ isOwner: true, role: 'host' })
    expect(byId[room.id]).toMatchObject({ isOwner: false, role: 'cohost', live: false })
    expect(res.body.items.every((item: object) => !('cohosts' in item))).toBe(true)
    expect((await (await loginAs(owner)).get('/api/rooms', { query: { q: room.name } })).body.items).toHaveLength(1)
  })

  it('shows details to the owner and co-hosts; 404 for everyone else', async () => {
    const { owner, cohost, room } = await withCohost()
    const details = await (await loginAs(owner)).get(`/api/rooms/${room.id}`)
    expect(details.status).toBe(200)
    expect(details.body.room.cohosts).toEqual([{ userId: cohost.id, displayName: cohost.displayName, email: cohost.email }])
    expect((await (await loginAs(cohost)).get(`/api/rooms/${room.id}`)).body.room).toMatchObject({ isOwner: false })
    const stranger = await loginAs(await createUser())
    expectApiError(await stranger.get(`/api/rooms/${room.id}`), 404, 'ROOM_NOT_FOUND')
    expectApiError(await stranger.get('/api/rooms/not-a-uuid'), 404, 'ROOM_NOT_FOUND')
    await testDb().update(rooms).set({ deletedAt: new Date() }).where(eq(rooms.id, room.id))
    expectApiError(await (await loginAs(owner)).get(`/api/rooms/${room.id}`), 404, 'ROOM_NOT_FOUND')
  })
})

describe('PATCH and DELETE /api/rooms/:id', () => {
  it('lets only the owner change settings; password null clears it', async () => {
    const { owner, cohost, room } = await withCohost()
    const api = await loginAs(owner)
    const set = await api.patch(`/api/rooms/${room.id}`, { body: { name: 'Renamed', password: 'secret-1', screenSharePolicy: 'hosts' } })
    expect(set.status, set.text).toBe(200)
    expect(set.body.room).toMatchObject({ name: 'Renamed', hasPassword: true, screenSharePolicy: 'hosts' })
    expect((await api.patch(`/api/rooms/${room.id}`, { body: { password: null } })).body.room.hasPassword).toBe(false)
    expectApiError(await (await loginAs(cohost)).patch(`/api/rooms/${room.id}`, { body: { name: 'x' } }), 403, 'FORBIDDEN')
    expectApiError(await (await loginAs(await createUser())).patch(`/api/rooms/${room.id}`, { body: { name: 'x' } }), 404, 'ROOM_NOT_FOUND')
  })

  it('counts new passwords against the room-create limit of the owner (each costs an argon2 hash, F-016)', async () => {
    const owner = await createUser()
    const room = await createRoom(owner)
    const api = await loginAs(owner)
    for (let i = 0; i < 20; i++) {
      const res = await api.patch(`/api/rooms/${room.id}`, { body: { password: `secret-${i}` } })
      expect(res.status, res.text).toBe(200)
    }
    const limited = await api.patch(`/api/rooms/${room.id}`, { body: { password: 'one-too-many' } })
    expectApiError(limited, 429, 'RATE_LIMITED')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Changes without a new password are not limited; removing the password costs nothing either.
    expect((await api.patch(`/api/rooms/${room.id}`, { body: { name: 'Still editable' } })).status).toBe(200)
    expect((await api.patch(`/api/rooms/${room.id}`, { body: { password: null } })).status).toBe(200)
  })

  it('soft-deletes for the owner only and ends a live meeting', async () => {
    const { owner, cohost, room } = await withCohost()
    await startMeeting(room, owner)
    expectApiError(await (await loginAs(cohost)).delete(`/api/rooms/${room.id}`), 403, 'FORBIDDEN')
    const api = await loginAs(owner)
    expect((await api.delete(`/api/rooms/${room.id}`)).status).toBe(204)
    const [row] = await testDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(row!.deletedAt).not.toBeNull()
    const [meeting] = await testDb().select().from(meetings).where(eq(meetings.roomId, room.id))
    expect(meeting!.endedAt).not.toBeNull()
    if (usesFakeLivekit()) expect((await livekitCalls(room.id)).at(-1)?.method).toBe('deleteRoom')
    expectApiError(await api.get(`/api/rooms/${room.id}`), 404, 'ROOM_NOT_FOUND')
  })
})

describe('co-hosts', () => {
  it('adds and removes existing enabled users (owner only)', async () => {
    const owner = await createUser()
    const room = await createRoom(owner)
    const api = await loginAs(owner)
    const helper = await createUser()
    const added = await api.post(`/api/rooms/${room.id}/cohosts`, { body: { userId: helper.id } })
    expect(added.status, added.text).toBe(200)
    expect(added.body.room.cohosts.map((c: { userId: string }) => c.userId)).toEqual([helper.id])
    const again = await api.post(`/api/rooms/${room.id}/cohosts`, { body: { userId: helper.id } })
    expectApiError(again, 409, 'CONFLICT')
    expect(again.body.data.details).toEqual({ reason: 'already_cohost' })
    const self = await api.post(`/api/rooms/${room.id}/cohosts`, { body: { userId: owner.id } })
    expect(self.body.data.details).toEqual({ reason: 'self' })
    const disabled = await createUser({ disabled: true })
    expectApiError(await api.post(`/api/rooms/${room.id}/cohosts`, { body: { userId: disabled.id } }), 404, 'NOT_FOUND')
    expectApiError(
      await (await loginAs(helper)).post(`/api/rooms/${room.id}/cohosts`, { body: { userId: (await createUser()).id } }),
      403,
      'FORBIDDEN',
    )
    expect((await api.delete(`/api/rooms/${room.id}/cohosts/${helper.id}`)).status).toBe(204)
    expectApiError(await api.delete(`/api/rooms/${room.id}/cohosts/${helper.id}`), 404, 'NOT_FOUND')
  })
})

describe('invites', () => {
  it('owner and co-hosts create, list (tokens re-derived) and revoke; strangers get 404', async () => {
    const { owner, cohost, room } = await withCohost()
    const created = await (await loginAs(cohost)).post(`/api/rooms/${room.id}/invites`, {
      body: { label: 'Team', expiresIn: '1h', maxUses: 3 },
    })
    expect(created.status, created.text).toBe(201)
    const invite = created.body.invite
    expect(invite).toMatchObject({ label: 'Team', maxUses: 3, useCount: 0, revoked: false })
    expect(new Date(invite.expiresAt).getTime() - Date.now()).toBeGreaterThan(3_500_000)
    expect(inviteIdFromToken(invite.token, serverEnv().APP_SECRET)).toBe(invite.id)

    const never = await (await loginAs(owner)).post(`/api/rooms/${room.id}/invites`, { body: { expiresIn: 'never' } })
    expect(never.body.invite).toMatchObject({ expiresAt: null, maxUses: null, label: null })

    const list = await (await loginAs(owner)).get(`/api/rooms/${room.id}/invites`)
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([never.body.invite.id, invite.id])
    expect(list.body.items[1].token).toBe(invite.token)

    const stranger = await loginAs(await createUser())
    expectApiError(await stranger.get(`/api/rooms/${room.id}/invites`), 404, 'ROOM_NOT_FOUND')
    expectApiError(await stranger.post(`/api/rooms/${room.id}/invites`, { body: {} }), 404, 'ROOM_NOT_FOUND')

    const api = await loginAs(owner)
    expect((await api.delete(`/api/rooms/${room.id}/invites/${invite.id}`)).status).toBe(204)
    expect((await api.get(`/api/rooms/${room.id}/invites`)).body.items[1].revoked).toBe(true)
    const otherRoom = await createRoom(owner)
    expectApiError(await api.delete(`/api/rooms/${otherRoom.id}/invites/${invite.id}`), 404, 'NOT_FOUND')
  })
})

describe('GET /api/rooms/:id/meetings', () => {
  it('lists the meeting history for owner and co-hosts', async () => {
    const { owner, cohost, room } = await withCohost()
    await startMeeting(room, owner)
    const res = await (await loginAs(cohost)).get(`/api/rooms/${room.id}/meetings`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 25 })
    expect(res.body.items[0]).toMatchObject({ endedAt: null, peakParticipants: 0 })
    expectApiError(await (await loginAs(await createUser())).get(`/api/rooms/${room.id}/meetings`), 404, 'ROOM_NOT_FOUND')
  })
})
