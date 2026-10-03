/**
 * In-call actions (docs/API.md §7): each action writes the database, then makes the expected RoomServiceAdapter calls
 * (asserted on the fake), then publishes room state when it changed.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLog, callParticipants, meetings, roomMembers, rooms } from '../../../server/database/schema'
import { testDb } from '../_harness'
import { livekitCalls, participantRow, sendWebhook, usesFakeLivekit, type FakeCall } from '../rooms/_support'
import { guestMember, liveMeeting, type Meeting, waitingRequest } from './_meeting'

async function track(meeting: Meeting) {
  const before = (await livekitCalls(meeting.room.id)).length
  return async (method?: string): Promise<FakeCall[]> => {
    const calls = (await livekitCalls(meeting.room.id)).slice(before)
    return method ? calls.filter((call) => call.method === method) : calls
  }
}

async function row(rowId: string) {
  const [found] = await testDb().select().from(callParticipants).where(eq(callParticipants.id, rowId))
  return found!
}

const ALL = ['camera', 'microphone', 'screen_share', 'screen_share_audio']
const post = (meeting: Meeting, member: Meeting['host'], path: string, body?: unknown) =>
  member.api.post(`/api/calls/${meeting.room.id}${path}`, body === undefined ? {} : { body })

describe.skipIf(!usesFakeLivekit())('in-call actions', () => {
  it('me/name renames the caller in the database and in LiveKit', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    expect((await post(meeting, meeting.guest, '/me/name', { displayName: '  Ada\u200B Lovelace ' })).status).toBe(204)
    expect((await row(meeting.guest.rowId)).displayName).toBe('Ada Lovelace')
    expect((await calls('updateParticipant')).map((c) => c.args)).toEqual([[meeting.room.id, meeting.guest.identity, { name: 'Ada Lovelace' }]])
  })

  it('me/hand raises (keeping the first time) and lowers the hand attribute', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    await post(meeting, meeting.participant, '/me/hand', { raised: true })
    const raisedAt = (await row(meeting.participant.rowId)).handRaisedAt!
    await post(meeting, meeting.participant, '/me/hand', { raised: true })
    expect((await row(meeting.participant.rowId)).handRaisedAt!.getTime()).toBe(raisedAt.getTime())
    await post(meeting, meeting.participant, '/me/hand', { raised: false })
    expect((await row(meeting.participant.rowId)).handRaisedAt).toBeNull()
    const hands = (await calls('updateParticipant')).map((c) => c.args[2].attributes.hand)
    expect(hands).toEqual([String(raisedAt.getTime()), String(raisedAt.getTime()), ''])
  })

  it('mute server-mutes the published track of one source', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    expect((await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/mute`, { source: 'microphone' })).status).toBe(204)
    expect((await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/mute`, { source: 'camera' })).status).toBe(204)
    // Nothing to mute: no screen share is published.
    expect((await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/mute`, { source: 'screen_share' })).status).toBe(204)
    expect((await calls('mutePublishedTrack')).map((c) => c.args)).toEqual([
      [meeting.room.id, meeting.participant.identity, `TR_microphone_${meeting.participant.identity}`],
      [meeting.room.id, meeting.participant.identity, `TR_camera_${meeting.participant.identity}`],
    ])
  })

  it('permissions rewrite the complete permission object and mute a revoked source', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    expect((await post(meeting, meeting.host, `/participants/${meeting.guest.identity}/permissions`, { microphone: false })).status).toBe(204)
    expect(await row(meeting.guest.rowId)).toMatchObject({ micAllowed: false, cameraAllowed: true })
    const [update] = await calls('updateParticipant')
    expect(update!.args[2]).toEqual({
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
        canPublishSources: ['camera', 'screen_share', 'screen_share_audio'],
        canUpdateMetadata: false,
        hidden: false,
      },
    })
    expect((await calls('mutePublishedTrack')).map((c) => c.args[2])).toEqual([`TR_microphone_${meeting.guest.identity}`])
    await post(meeting, meeting.host, `/participants/${meeting.guest.identity}/permissions`, { microphone: true, camera: false })
    expect((await calls('updateParticipant')).at(-1)!.args[2].permission.canPublishSources).toEqual(['microphone', 'screen_share', 'screen_share_audio'])
  })

  it('ask-unmute sends the hint to the target only', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    expect((await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/ask-unmute`)).status).toBe(204)
    expect((await calls('sendData')).map((c) => c.args)).toEqual([
      [meeting.room.id, '{"type":"ask-unmute"}', { topic: 'blinq.srv.v1', destinationIdentities: [meeting.participant.identity] }],
    ])
    expect(await calls('mutePublishedTrack')).toEqual([])
  })

  it('volume sets the vol attribute for everyone', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    await post(meeting, meeting.host, `/participants/${meeting.participant.identity}/volume`, { level: 25 })
    expect((await row(meeting.participant.rowId)).volumeLevel).toBe(25)
    expect((await calls('updateParticipant'))[0]!.args[2].attributes).toMatchObject({ vol: '25', role: 'participant', kind: 'user' })
  })

  it('remove makes the row final, revokes tokens and closes the person pending requests', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    const secondTab = await testDb()
      .insert(callParticipants)
      .values({
        lkIdentity: 'p_SecondTab0000000',
        roomId: meeting.room.id,
        meetingId: meeting.meetingId,
        userId: meeting.participant.userId,
        clientId: 'second-tab-0000000000',
        displayName: 'Tab 2',
        status: 'waiting',
      })
      .returning()
    const started = Date.now()
    expect((await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/remove`)).status).toBe(204)
    expect((await row(meeting.participant.rowId)).status).toBe('removed')
    expect((await row(secondTab[0]!.id)).status).toBe('removed')
    const [removal] = await calls('removeParticipant')
    expect(removal!.args.slice(0, 2)).toEqual([meeting.room.id, meeting.participant.identity])
    const revokeAt = Date.parse(removal!.args[2].revokeTokensIssuedBefore)
    expect(revokeAt).toBeGreaterThanOrEqual(started)
    const [entry] = await testDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'call.remove'), eq(auditLog.targetId, meeting.participant.rowId)))
    expect(entry).toMatchObject({ actorParticipantId: meeting.cohost.rowId, actorUserId: meeting.cohost.userId })
  })

  it('role persists co-hosts with accounts and changes attributes and permissions', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    await post(meeting, meeting.host, `/participants/${meeting.participant.identity}/role`, { role: 'cohost' })
    expect((await row(meeting.participant.rowId)).roomRole).toBe('cohost')
    const members = () =>
      testDb()
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, meeting.room.id), eq(roomMembers.userId, meeting.participant.userId!)))
    expect(await members()).toHaveLength(1)
    const [update] = await calls('updateParticipant')
    expect(update!.args[2].attributes.role).toBe('cohost')
    expect(update!.args[2].permission.canPublishSources).toEqual(ALL)
    await post(meeting, meeting.host, `/participants/${meeting.participant.identity}/role`, { role: 'participant' })
    expect(await members()).toHaveLength(0)
    // Guests are promoted on the live row only.
    await post(meeting, meeting.host, `/participants/${meeting.guest.identity}/role`, { role: 'cohost' })
    expect((await row(meeting.guest.rowId)).roomRole).toBe('cohost')
    expect(await testDb().select().from(roomMembers).where(eq(roomMembers.roomId, meeting.room.id))).toHaveLength(2)
  })

  it('name and lower-hand change the target only', async () => {
    const meeting = await liveMeeting()
    await post(meeting, meeting.participant, '/me/hand', { raised: true })
    const calls = await track(meeting)
    await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/name`, { displayName: 'Speaker' })
    await post(meeting, meeting.cohost, `/participants/${meeting.participant.identity}/lower-hand`)
    expect(await row(meeting.participant.rowId)).toMatchObject({ displayName: 'Speaker', handRaisedAt: null })
    const updates = await calls('updateParticipant')
    expect(updates.map((c) => c.args[1])).toEqual([meeting.participant.identity, meeting.participant.identity])
    expect(updates[0]!.args[2]).toEqual({ name: 'Speaker' })
    expect(updates[1]!.args[2].attributes.hand).toBe('')
  })

  it('mute-all mutes participant microphones; preventSelfUnmute turns self-unmute off for the room', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    expect((await post(meeting, meeting.cohost, '/mute-all', { preventSelfUnmute: true })).status).toBe(204)
    const muted = new Set((await calls('mutePublishedTrack')).map((c) => c.args[1]))
    expect(muted).toEqual(new Set([meeting.participant.identity, meeting.participant2.identity, meeting.guest.identity]))
    const [room] = await testDb().select().from(rooms).where(eq(rooms.id, meeting.room.id))
    expect(room!.allowSelfUnmute).toBe(false)
    expect((await row(meeting.guest.rowId)).micAllowed).toBe(false)
    expect((await row(meeting.cohost2.rowId)).micAllowed).toBe(true)
    const permissions = (await calls('updateParticipant')).filter((c) => c.args[2].permission)
    expect(new Set(permissions.map((c) => c.args[1]))).toEqual(muted)
    for (const call of permissions) expect(call.args[2].permission.canPublishSources).not.toContain('microphone')
    expect(JSON.parse((await calls('updateRoomMetadata')).at(-1)!.args[1]).allowSelfUnmute).toBe(false)

    // "Give voice" overrides the room policy for one person.
    await post(meeting, meeting.host, `/participants/${meeting.guest.identity}/permissions`, { microphone: true })
    expect((await calls('updateParticipant')).at(-1)!.args[2].permission.canPublishSources).toContain('microphone')
  })

  it('live settings re-apply permissions for the screen-share and self-unmute policies', async () => {
    const meeting = await liveMeeting()
    const calls = await track(meeting)
    const res = await meeting.host.api.patch(`/api/calls/${meeting.room.id}/settings`, { body: { screenSharePolicy: 'hosts' } })
    expect(res.status).toBe(200)
    expect(res.body.state.screenSharePolicy).toBe('hosts')
    const updates = (await calls('updateParticipant')).filter((c) => c.args[2].permission)
    expect(new Set(updates.map((c) => c.args[1]))).toEqual(
      new Set([meeting.participant.identity, meeting.participant2.identity, meeting.guest.identity]),
    )
    for (const call of updates) expect(call.args[2].permission.canPublishSources).toEqual(['camera', 'microphone'])

    await meeting.host.api.patch(`/api/calls/${meeting.room.id}/settings`, { body: { allowSelfUnmute: false } })
    expect((await row(meeting.participant.rowId)).micAllowed).toBe(false)
    await meeting.host.api.patch(`/api/calls/${meeting.room.id}/settings`, { body: { allowSelfUnmute: true } })
    expect((await row(meeting.participant.rowId)).micAllowed).toBe(true)
  })

  it('lock resets when the meeting ends; end deletes the LiveKit room and closes everything', async () => {
    const meeting = await liveMeeting()
    const requestId = await waitingRequest(meeting)
    const calls = await track(meeting)
    expect((await meeting.cohost.api.patch(`/api/calls/${meeting.room.id}/settings`, { body: { locked: true } })).status).toBe(200)
    expect((await row(requestId)).status).toBe('left')
    const late = await waitingRequest(meeting)
    expect((await post(meeting, meeting.host, '/end')).status).toBe(204)
    const [room] = await testDb().select().from(rooms).where(eq(rooms.id, meeting.room.id))
    expect(room!.locked).toBe(false)
    const [ended] = await testDb().select().from(meetings).where(eq(meetings.id, meeting.meetingId))
    expect(ended!.endedAt).not.toBeNull()
    expect((await row(meeting.participant.rowId)).status).toBe('left')
    expect((await row(late)).status).toBe('left')
    expect((await calls()).at(-1)!.method).toBe('deleteRoom')
  })

  it('lists participants with their allowances and the lobby for moderators', async () => {
    const meeting = await liveMeeting()
    const requestId = await waitingRequest(meeting)
    const list = await meeting.guest.api.get(`/api/calls/${meeting.room.id}/participants`)
    expect(list.status).toBe(200)
    expect(list.body.items.map((i: { role: string }) => i.role)).toEqual(['host', 'cohost', 'cohost', 'participant', 'participant', 'participant'])
    expect(list.body.items.find((i: { identity: string }) => i.identity === meeting.guest.identity)).toEqual({
      identity: meeting.guest.identity,
      displayName: expect.any(String),
      role: 'participant',
      kind: 'guest',
      micAllowed: true,
      cameraAllowed: true,
      volumeLevel: 100,
      handRaisedAt: null,
      joinedAt: expect.any(String),
    })
    const lobby = await meeting.cohost.api.get(`/api/calls/${meeting.room.id}/lobby`)
    expect(lobby.body.items).toEqual([{ requestId, displayName: expect.any(String), kind: 'guest', requestedAt: expect.any(String) }])
  })

  it('GET lobby leaves stale requests out without writing anything (F-046)', async () => {
    const meeting = await liveMeeting()
    const fresh = await waitingRequest(meeting)
    const stale = await waitingRequest(meeting)
    await testDb()
      .update(callParticipants)
      .set({ requestedAt: new Date(Date.now() - 61 * 60_000) })
      .where(eq(callParticipants.id, stale))
    const lobby = await meeting.cohost.api.get(`/api/calls/${meeting.room.id}/lobby`)
    expect(lobby.body.items.map((entry: { requestId: string }) => entry.requestId)).toEqual([fresh])
    expect((await row(stale)).status).toBe('waiting') // the maintenance closes it, not a read
  })

  it('admit-all admits in order up to capacity', async () => {
    const meeting = await liveMeeting()
    await testDb().update(rooms).set({ maxParticipants: 8 }).where(eq(rooms.id, meeting.room.id))
    const first = await waitingRequest(meeting)
    const second = await waitingRequest(meeting)
    const third = await waitingRequest(meeting)
    const res = await post(meeting, meeting.cohost, '/lobby/admit-all')
    expect(res.body).toEqual({ admitted: 2 })
    expect((await row(first)).status).toBe('admitted')
    expect((await row(second)).status).toBe('admitted')
    expect((await row(third)).status).toBe('waiting')
  })

  it('sends lobby.changed hints to connected moderators only', async () => {
    const meeting = await liveMeeting({ waitingRoom: true })
    await sendWebhook('participant_joined', meeting.room, { identity: meeting.host.identity })
    expect((await participantRow(meeting.host.identity))!.status).toBe('joined')
    const calls = await track(meeting)
    const guest = await guestMember(meeting.room, meeting.meetingId)
    await post(meeting, meeting.cohost, `/lobby/${await waitingRequest(meeting)}/deny`)
    const hints = (await calls('sendData')).map((c) => c.args)
    expect(hints).toContainEqual([
      meeting.room.id,
      '{"type":"lobby.changed"}',
      { topic: 'blinq.srv.v1', destinationIdentities: expect.arrayContaining([meeting.host.identity, meeting.cohost.identity]) },
    ])
    for (const hint of hints) {
      expect(hint[2].destinationIdentities).not.toContain(meeting.participant.identity)
      expect(hint[2].destinationIdentities).not.toContain(guest.identity)
      expect(hint[1]).not.toMatch(/token|eyJ/)
    }
  })
})
