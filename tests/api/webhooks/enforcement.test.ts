/**
 * Webhook enforcement and bookkeeping (docs/API.md §10, docs/SECURITY.md §4): participant_joined removes every identity
 * whose row is not admitted or joined in the live meeting (the backstop for leaked tokens), marks admitted rows joined
 * and tracks the peak; participant_left and room_finished close rows and meetings.
 */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { callParticipants, meetings, rooms } from '../../../server/database/schema'
import { createAdmin, createMeeting, createParticipant, createRoom, createUser, expectApiError, loginAs, testDb } from '../_harness'
import { openSse } from '../join/_sse'
import { joinGuest, joinUser, livekitCalls, participantRow, sendWebhook, startMeeting, usesFakeLivekit } from '../rooms/_support'

async function meetingRow(roomId: string) {
  const rows = await testDb().select().from(meetings).where(eq(meetings.roomId, roomId))
  return rows.at(-1)!
}

const removedIdentities = async (roomId: string) =>
  (await livekitCalls(roomId, 'removeParticipant')).map((call) => call.args[1] as string)

describe.skipIf(!usesFakeLivekit())('participant_joined enforcement', () => {
  it('removes identities without a row, with a final row or from an older meeting, and revokes their tokens', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    await startMeeting(room, owner)
    const live = await meetingRow(room.id)
    const old = await createMeeting(room, { endedAt: new Date() })
    const removed = await createParticipant({ room, meeting: live, status: 'removed' })
    const denied = await createParticipant({ room, meeting: live, status: 'denied' })
    const left = await createParticipant({ room, meeting: live, status: 'left' })
    const waiting = await createParticipant({ room, meeting: live, status: 'waiting' })
    const stale = await createParticipant({ room, meeting: old, status: 'joined' })
    const otherRoom = await createRoom(owner)
    const foreign = await createParticipant({ room: otherRoom, meeting: await createMeeting(otherRoom), status: 'joined' })
    const intruders = ['p_NoRowAtAll000000', removed.lkIdentity, denied.lkIdentity, left.lkIdentity, waiting.lkIdentity, stale.lkIdentity, foreign.lkIdentity]
    for (const identity of intruders) expect((await sendWebhook('participant_joined', room, { identity })).status).toBe(200)
    expect(await removedIdentities(room.id)).toEqual(intruders)
    for (const call of await livekitCalls(room.id, 'removeParticipant')) {
      expect(Date.parse(call.args[2].revokeTokensIssuedBefore)).toBeGreaterThan(Date.now())
    }
    expect((await participantRow(removed.lkIdentity))!.status).toBe('removed')
  })

  it('marks admitted rows joined, never removes them, and tracks the peak', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    const guest = await joinGuest(room, { expectStatus: 200 })
    const joinedAtMs = Date.now() - 1_000
    await sendWebhook('participant_joined', room, { identity: host.identity, joinedAtMs })
    await sendWebhook('participant_joined', room, { identity: guest.identity })
    expect(await participantRow(host.identity)).toMatchObject({ status: 'joined', joinedAt: new Date(joinedAtMs) })
    expect((await participantRow(guest.identity))!.status).toBe('joined')
    expect(await removedIdentities(room.id)).toEqual([])
    expect((await meetingRow(room.id)).peakParticipants).toBe(2)
    await sendWebhook('participant_left', room, { identity: guest.identity, joinedAtMs: (await participantRow(guest.identity))!.joinedAt!.getTime() })
    expect((await meetingRow(room.id)).peakParticipants).toBe(2)
    // The joined participant gets the current state pushed (it may have changed after the token was minted).
    const pushed = (await livekitCalls(room.id, 'updateParticipant')).filter((c) => c.args[1] === host.identity)
    expect(pushed.at(-1)!.args[2]).toMatchObject({ name: owner.displayName, attributes: { role: 'host' }, permission: { canSubscribe: true } })
  })

  it('removes everyone of a deleted room', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    await testDb().update(rooms).set({ deletedAt: new Date() }).where(eq(rooms.id, room.id))
    await sendWebhook('participant_joined', room, { identity: host.identity })
    expect(await removedIdentities(room.id)).toEqual([host.identity])
  })

  it('keeps a removed participant out: API rejoin is refused and a leaked token is kicked', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    const user = await createUser()
    const member = await joinUser(room, { user, expectStatus: 200 })
    await host.api.post(`/api/calls/${room.id}/participants/${member.identity}/remove`)
    expectApiError((await joinUser(room, { user })).res, 403, 'JOIN_REMOVED')
    // The token handed out before the removal is still in the attacker's hands: LiveKit reports the join.
    await sendWebhook('participant_joined', room, { identity: member.identity })
    expect((await removedIdentities(room.id)).filter((id) => id === member.identity)).toHaveLength(2)
    expect((await participantRow(member.identity))!.status).toBe('removed')
  })

  it('takes a full LiveKit reconnect back instead of treating it as a removal (F-039)', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    await startMeeting(room, owner)
    const guest = await joinGuest(room, { expectStatus: 200 })
    const first = Date.now() - 30_000
    // joined(T1) → joined; the network drops: left(T1) → left; the SDK reconnects with the same token: joined(T2).
    await sendWebhook('participant_joined', room, { identity: guest.identity, joinedAtMs: first })
    await sendWebhook('participant_left', room, { identity: guest.identity, joinedAtMs: first })
    expect((await participantRow(guest.identity))!.status).toBe('left')
    await sendWebhook('participant_joined', room, { identity: guest.identity, joinedAtMs: first + 25_000 })
    expect(await participantRow(guest.identity)).toMatchObject({
      status: 'joined',
      joinedAt: new Date(first + 25_000),
      leftAt: null,
    })
    expect(await removedIdentities(room.id)).not.toContain(guest.identity)
    // The new connection's own left still closes the row.
    await sendWebhook('participant_left', room, { identity: guest.identity, joinedAtMs: first + 25_000 })
    expect((await participantRow(guest.identity))!.status).toBe('left')
  })

  it('still removes a reconnect after the grace period, and rows closed by a revocation', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    await startMeeting(room, owner)
    const stale = await joinGuest(room, { expectStatus: 200 })
    const connectedAt = Date.now() - 600_000
    await sendWebhook('participant_joined', room, { identity: stale.identity, joinedAtMs: connectedAt })
    await sendWebhook('participant_left', room, { identity: stale.identity, joinedAtMs: connectedAt })
    expect((await participantRow(stale.identity))!.status).toBe('left')
    await testDb()
      .update(callParticipants)
      .set({ leftAt: new Date(Date.now() - 121_000) })
      .where(eq(callParticipants.lkIdentity, stale.identity))
    await sendWebhook('participant_joined', room, { identity: stale.identity })
    expect(await removedIdentities(room.id)).toContain(stale.identity)
    expect((await participantRow(stale.identity))!.status).toBe('left')

    // A user taken out of live calls (disabled, deleted, sessions revoked) cannot come back over LiveKit.
    const member = await joinUser(room, { expectStatus: 200 })
    await sendWebhook('participant_joined', room, { identity: member.identity })
    const admin = await loginAs(await createAdmin())
    expect((await admin.post(`/api/admin/users/${member.user!.id}/revoke-sessions`)).status).toBe(204)
    // The removal runs on the event bus, right after the answer.
    for (let i = 0; i < 50 && (await participantRow(member.identity))!.status !== 'left'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect((await participantRow(member.identity))!.status).toBe('left')
    const removals = async () => (await removedIdentities(room.id)).filter((id) => id === member.identity).length
    const before = await removals()
    await sendWebhook('participant_joined', room, { identity: member.identity })
    expect(await removals()).toBe(before + 1)
    expect((await participantRow(member.identity))!.status).toBe('left')
  })
})

describe.skipIf(!usesFakeLivekit())('participant_left and room_finished', () => {
  it('marks the row left, but ignores a late left of an earlier connection', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    const first = Date.now() - 60_000
    await sendWebhook('participant_joined', room, { identity: host.identity, joinedAtMs: first })
    await sendWebhook('participant_joined', room, { identity: host.identity, joinedAtMs: first + 30_000 })
    await sendWebhook('participant_left', room, { identity: host.identity, joinedAtMs: first })
    expect((await participantRow(host.identity))!.status).toBe('joined')
    await sendWebhook('participant_left', room, { identity: host.identity, joinedAtMs: first + 30_000 })
    expect((await participantRow(host.identity))!.status).toBe('left')
  })

  it('ends the meeting on room_finished: rows left, waiters ended, lock reset, ephemeral room archived', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: true, ephemeral: true })
    const host = await startMeeting(room, owner)
    const guest = await joinGuest(room, { expectStatus: 202 })
    const { stream } = await openSse(guest.api, guest.res.body.requestId)
    expect(await stream!.nextEvent()).toMatchObject({ event: 'status' })
    const meeting = await meetingRow(room.id)
    await testDb().update(rooms).set({ locked: true }).where(eq(rooms.id, room.id))

    // A room_finished for another (older) LiveKit room of the same name changes nothing.
    await sendWebhook('room_finished', { id: room.id, sid: 'RM_older000000' })
    expect((await meetingRow(room.id)).endedAt).toBeNull()
    await sendWebhook('room_finished', { id: room.id, sid: meeting.livekitSid! })
    expect((await meetingRow(room.id)).endedAt).not.toBeNull()
    expect(await stream!.nextEvent()).toMatchObject({ event: 'ended' })
    expect((await participantRow(host.identity))!.status).toBe('left')
    const [row] = await testDb().select().from(rooms).where(eq(rooms.id, room.id))
    expect(row!.locked).toBe(false)
    expect(row!.deletedAt).not.toBeNull()
    const leftovers = await testDb().select().from(callParticipants).where(eq(callParticipants.meetingId, meeting.id))
    expect(leftovers.filter((r) => r.status === 'waiting' || r.status === 'admitted' || r.status === 'joined')).toEqual([])
    // LiveKit already closed the room: no deleteRoom after room_finished.
    expect((await livekitCalls(room.id)).at(-1)!.method).not.toBe('deleteRoom')
  })

  it('records the LiveKit sid on room_started when it is missing', async () => {
    const room = await createRoom(await createUser())
    const meeting = await createMeeting(room)
    await sendWebhook('room_started', { id: room.id, sid: 'RM_started0000000' })
    const [row] = await testDb().select().from(meetings).where(eq(meetings.id, meeting.id))
    expect(row!.livekitSid).toBe('RM_started0000000')
  })
})
