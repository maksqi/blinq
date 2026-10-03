/**
 * LiveKit webhook events (rooms-backend, docs/API.md §10, docs/SECURITY.md §4). Rooms missing from this database are
 * ignored: the dev LiveKit sends every agent's webhooks to every port.
 *
 * - `participant_joined` is the enforcement backstop for leaked or stale tokens: an identity whose row is not
 *   `admitted`/`joined` in the room's live meeting (unknown identities, removed, denied, left, older meetings, deleted
 *   rooms) is removed at once, with its tokens revoked (`joinVerdict`, enforcement.ts). The one exception is a full
 *   LiveKit reconnect (F-039): a row that left after its own connection less than `RESUME_GRACE_MS` ago is taken
 *   back. An accepted row becomes `joined` (with LiveKit's join time, which identifies the connection), the meeting's
 *   peak count is updated, and the row's current name, attributes and permissions are pushed (they may have changed
 *   after the token was minted).
 * - `participant_left` marks the row `left`, unless it belongs to an earlier connection of a resumed row. When the
 *   last connection of a recorder leaves, `recording.changed` is published (recording-server finalizes).
 * - `room_started` records the LiveKit room sid; `room_finished` ends the meeting of that sid.
 * `handleWebhookEvent(event)` deduplicates by event id first.
 */
import { and, count, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { WebhookEvent } from 'livekit-server-sdk'
import { useDb } from '../../database/client'
import { callParticipants, meetings, recordings } from '../../database/schema'
import { eventBus } from '../../utils/event-bus'
import { logger } from '../../utils/logger'
import { LIVE_STATUSES, pushParticipantState } from '../calls/live'
import { RESUME_GRACE_MS } from '../join/resume'
import { roomService } from '../livekit/room-service'
import { webhookDeduper } from '../livekit/webhook'
import { findRoomById } from '../rooms/queries'
import { joinVerdict } from './enforcement'
import { endMeeting, findLiveMeeting, type ParticipantRow, type RoomRow } from './meetings'

export const ENFORCEMENT_REVOKE_LEEWAY_MS = 60_000

type WebhookParticipant = NonNullable<WebhookEvent['participant']>

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored'

function joinedAtOf(participant: WebhookParticipant | undefined): Date | null {
  if (!participant) return null
  const ms = Number(participant.joinedAtMs) || Number(participant.joinedAt) * 1000
  return ms > 0 ? new Date(ms) : null
}

function isLive(row: Pick<ParticipantRow, 'status'>): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(row.status)
}

async function enforceRemoval(room: RoomRow, identity: string, now: Date, reason: string): Promise<void> {
  logger.warn('LiveKit participant removed by enforcement', { roomId: room.id, identity, reason })
  await roomService().removeParticipant(room.id, identity, {
    revokeTokensIssuedBefore: new Date(now.getTime() + ENFORCEMENT_REVOKE_LEEWAY_MS),
  })
}

async function onParticipantJoined(room: RoomRow, participant: WebhookParticipant | undefined, now: Date) {
  const identity = participant?.identity
  if (!identity) return
  const db = useDb()
  const meeting = await findLiveMeeting(db, room.id)
  const [row] = await db.select().from(callParticipants).where(eq(callParticipants.lkIdentity, identity)).limit(1)
  const verdict = joinVerdict(row, {
    roomId: room.id,
    roomDeleted: room.deletedAt !== null,
    liveMeetingId: meeting?.id ?? null,
    now,
  })
  if (!verdict.accept || !row || !meeting) {
    return enforceRemoval(room, identity, now, verdict.accept ? 'no meeting' : verdict.reason)
  }
  if (verdict.reconnect) logger.info('LiveKit participant reconnected', { roomId: room.id, identity })

  // The row may have changed since it was read: only a still live (or still reconnectable) row is taken.
  const reconnectableAgain = and(
    eq(callParticipants.status, 'left'),
    isNotNull(callParticipants.joinedAt),
    gte(callParticipants.leftAt, new Date(now.getTime() - RESUME_GRACE_MS)),
  )
  const [joined] = await db
    .update(callParticipants)
    .set({ status: 'joined', joinedAt: joinedAtOf(participant) ?? now, leftAt: null })
    .where(
      and(
        eq(callParticipants.id, row.id),
        or(inArray(callParticipants.status, [...LIVE_STATUSES]), verdict.reconnect ? reconnectableAgain : undefined),
      ),
    )
    .returning()
  if (!joined) return enforceRemoval(room, identity, now, 'status changed')

  await db
    .update(meetings)
    .set({
      peakParticipants: sql`greatest(${meetings.peakParticipants}, (select count(*)::int from ${callParticipants} where ${callParticipants.meetingId} = ${meeting.id} and ${callParticipants.status} = 'joined'))`,
    })
    .where(eq(meetings.id, meeting.id))
  try {
    await pushParticipantState(room, joined, { name: true, attributes: true, permission: true })
  } catch (error) {
    logger.warn('syncing a joined participant failed', { roomId: room.id, identity, err: error })
  }
}

async function onParticipantLeft(room: RoomRow, participant: WebhookParticipant | undefined, now: Date) {
  const identity = participant?.identity
  if (!identity) return
  const db = useDb()
  const [row] = await db.select().from(callParticipants).where(eq(callParticipants.lkIdentity, identity)).limit(1)
  if (!row || row.roomId !== room.id || !isLive(row) || !row.joinedAt) return
  const leftSession = joinedAtOf(participant)
  // A resumed row keeps its identity: a late "left" of the previous connection must not end the new one.
  if (leftSession && leftSession.getTime() !== row.joinedAt.getTime()) return
  const [left] = await db
    .update(callParticipants)
    .set({ status: 'left', leftAt: now })
    .where(
      and(
        eq(callParticipants.id, row.id),
        inArray(callParticipants.status, [...LIVE_STATUSES]),
        eq(callParticipants.joinedAt, row.joinedAt),
      ),
    )
    .returning()
  if (!left?.userId || !left.meetingId) return

  const [others] = await db
    .select({ value: count() })
    .from(callParticipants)
    .where(
      and(
        eq(callParticipants.meetingId, left.meetingId),
        eq(callParticipants.userId, left.userId),
        inArray(callParticipants.status, [...LIVE_STATUSES]),
      ),
    )
  if ((others?.value ?? 0) > 0) return
  const active = await db
    .select({ id: recordings.id })
    .from(recordings)
    .where(
      and(
        eq(recordings.roomId, room.id),
        eq(recordings.meetingId, left.meetingId),
        eq(recordings.createdBy, left.userId),
        eq(recordings.status, 'recording'),
        isNull(recordings.endedAt),
      ),
    )
  for (const recording of active) eventBus().publish({ type: 'recording.changed', roomId: room.id, recordingId: recording.id })
}

async function onRoomStarted(room: RoomRow, sid: string | undefined) {
  if (!sid) return
  await useDb()
    .update(meetings)
    .set({ livekitSid: sid })
    .where(and(eq(meetings.roomId, room.id), isNull(meetings.endedAt), isNull(meetings.livekitSid)))
}

async function dispatch(event: WebhookEvent, now: Date): Promise<WebhookOutcome> {
  const room = event.room?.name ? await findRoomById(event.room.name, { includeDeleted: true }) : null
  if (!room) return 'ignored'
  switch (event.event) {
    case 'participant_joined':
      await onParticipantJoined(room, event.participant, now)
      return 'processed'
    case 'participant_left':
      await onParticipantLeft(room, event.participant, now)
      return 'processed'
    case 'room_started':
      await onRoomStarted(room, event.room?.sid)
      return 'processed'
    case 'room_finished':
      await endMeeting(room.id, { reason: 'finished', livekitSid: event.room?.sid || undefined, deleteLivekitRoom: false, now })
      return 'processed'
    default:
      return 'ignored'
  }
}

export async function handleWebhookEvent(event: WebhookEvent, now: Date = new Date()): Promise<WebhookOutcome> {
  const deduper = webhookDeduper()
  if (event.id && !deduper.claim(event.id)) return 'duplicate'
  try {
    return await dispatch(event, now)
  } catch (error) {
    if (event.id) deduper.release(event.id)
    throw error
  }
}
