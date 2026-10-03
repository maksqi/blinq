/**
 * Meetings (rooms-backend, docs/ARCHITECTURE.md §6.3). One live meeting per room (partial unique index), a fresh
 * random epoch per meeting, one LiveKit room per meeting (name = `rooms.id`).
 *
 * - `withRoomLock(roomId, fn)`: a transaction holding a per-room advisory lock. Joins, admissions, key rotation and
 *   meeting ends run under it, so capacity, the lobby cap, meeting creation and meeting ends never race. Waiters do
 *   not hold a pool connection (`withAdvisoryLocks` polls), so many parallel joins of one room cannot starve the
 *   rest of the app (F-046); after `ROOM_LOCK_WAIT_MS` they answer 503 `SERVICE_UNAVAILABLE`. Never nest two of
 *   them for the same room (the inner one would wait for the outer one until it times out).
 * - `findLiveMeeting(db, roomId)`, `effectiveMaxParticipants(room, settings)`.
 * - `createMeeting(tx, room, now)`: inserts the meeting (the unique partial index settles races: the loser reuses the
 *   winner), attaches requests that waited before the meeting existed, and creates the LiveKit room with metadata from
 *   the `publishRoomState` builder. Any leftover LiveKit room of the same name is deleted first, so nobody from an
 *   earlier meeting can stay connected with an old epoch. The LiveKit calls stay inside the room lock on purpose
 *   (decision, F-046): the meeting row and its LiveKit room must appear together (a join that sees the meeting
 *   gets a token for a room that exists) and a failed creation must roll the meeting and the first join back.
 * - `endMeeting(roomId, options)`: ends the live meeting (DB first: meeting, rows, lock reset, ephemeral archive), then
 *   deletes the LiveKit room, closes waiting requests with `ended` and publishes `recording.changed` for active
 *   recordings. Returns false when no live meeting matched. A webhook passes the LiveKit room sid so a late
 *   `room_finished` of an earlier room never ends a newer meeting.
 * - `endMeetingsOfOwner(userId)`: for account deletion (Stage 03).
 */
import { randomBytes } from 'node:crypto'
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { Paginated } from '#shared/schemas/common'
import type { MeetingSummary } from '#shared/schemas/rooms'
import type { Settings } from '#shared/schemas/settings'
import { useDb, type Db, type Tx } from '../../database/client'
import { callParticipants, meetings, recordings, rooms } from '../../database/schema'
import { AdvisoryLockTimeoutError, withAdvisoryLocks } from '../../utils/advisory-lock'
import { apiError } from '../../utils/api-error'
import { eventBus } from '../../utils/event-bus'
import { logger } from '../../utils/logger'
import { buildRoomMetadata } from '../livekit/metadata'
import { roomService } from '../livekit/room-service'

export type RoomRow = typeof rooms.$inferSelect
export type MeetingRow = typeof meetings.$inferSelect
export type ParticipantRow = typeof callParticipants.$inferSelect

export const ROOM_HARD_MAX_PARTICIPANTS = 25
export const EMPTY_TIMEOUT_SEC = 300
export const DEPARTURE_TIMEOUT_SEC = 20

/** How long a join, admission or meeting end waits for the room lock before answering 503 (decision). */
export const ROOM_LOCK_WAIT_MS = 15_000

export async function withRoomLock<T>(roomId: string, fn: (tx: Tx) => Promise<T>, db: Db = useDb()): Promise<T> {
  try {
    return await withAdvisoryLocks(db, [`blinq:room:${roomId}`], fn, { waitMs: ROOM_LOCK_WAIT_MS })
  } catch (error) {
    if (error instanceof AdvisoryLockTimeoutError) throw apiError('SERVICE_UNAVAILABLE', 503)
    throw error
  }
}

export async function findLiveMeeting(db: Db | Tx, roomId: string): Promise<MeetingRow | null> {
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.roomId, roomId), isNull(meetings.endedAt)))
    .limit(1)
  return meeting ?? null
}

export function effectiveMaxParticipants(room: Pick<RoomRow, 'maxParticipants'>, settings: Settings): number {
  return Math.min(room.maxParticipants, settings['limits.maxParticipantsPerRoom'], ROOM_HARD_MAX_PARTICIPANTS)
}

export function newEpoch(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Runs inside `withRoomLock`: every query uses `tx`, and `settings` are loaded by the caller beforehand, because a
 * second pool connection taken while the lock is held could wait behind other lock waiters that hold the pool.
 */
export async function createMeeting(tx: Tx, room: RoomRow, settings: Settings, now: Date = new Date()): Promise<MeetingRow> {
  const [inserted] = await tx
    .insert(meetings)
    .values({ roomId: room.id, epoch: newEpoch(), startedAt: now })
    .onConflictDoNothing({ target: meetings.roomId, where: sql`ended_at is null` })
    .returning()
  if (!inserted) {
    const winner = await findLiveMeeting(tx, room.id)
    if (!winner) throw new Error('meeting insert conflicted without a live meeting')
    return winner
  }

  await tx
    .update(callParticipants)
    .set({ meetingId: inserted.id })
    .where(and(eq(callParticipants.roomId, room.id), isNull(callParticipants.meetingId), eq(callParticipants.status, 'waiting')))

  const service = roomService()
  await service.deleteRoom(room.id)
  const { sid } = await service.createRoom({
    name: room.id,
    maxParticipants: effectiveMaxParticipants(room, settings),
    emptyTimeoutSec: EMPTY_TIMEOUT_SEC,
    departureTimeoutSec: DEPARTURE_TIMEOUT_SEC,
    // A new meeting starts without a recording; later changes go through publishRoomState.
    metadata: JSON.stringify(buildRoomMetadata(room, inserted, null)),
  })
  const [meeting] = await tx.update(meetings).set({ livekitSid: sid }).where(eq(meetings.id, inserted.id)).returning()
  await tx.update(rooms).set({ lastActiveAt: now }).where(eq(rooms.id, room.id))
  return meeting ?? inserted
}

export interface EndMeetingOptions {
  reason: 'ended_by_host' | 'finished' | 'room_deleted' | 'admin' | 'stale' | 'owner_deleted'
  /** Webhooks: end only the meeting whose LiveKit room has this sid. */
  livekitSid?: string
  /** False when LiveKit already closed the room (room_finished). */
  deleteLivekitRoom?: boolean
  now?: Date
}

export async function endMeeting(roomId: string, options: EndMeetingOptions): Promise<boolean> {
  const now = options.now ?? new Date()
  const ended = await withRoomLock(roomId, async (tx) => {
    const meeting = await findLiveMeeting(tx, roomId)
    if (!meeting) return null
    if (options.livekitSid && meeting.livekitSid && meeting.livekitSid !== options.livekitSid) return null
    await tx.update(meetings).set({ endedAt: now }).where(eq(meetings.id, meeting.id))
    const waiting = await tx
      .update(callParticipants)
      .set({ status: 'left', leftAt: now })
      .where(and(eq(callParticipants.meetingId, meeting.id), eq(callParticipants.status, 'waiting')))
      .returning({ id: callParticipants.id })
    await tx
      .update(callParticipants)
      .set({ status: 'left', leftAt: now })
      .where(and(eq(callParticipants.meetingId, meeting.id), inArray(callParticipants.status, ['admitted', 'joined'])))
    const [room] = await tx.select({ ephemeral: rooms.ephemeral }).from(rooms).where(eq(rooms.id, roomId))
    await tx
      .update(rooms)
      .set({
        locked: false,
        lastActiveAt: now,
        // Instant meetings are archived after their meeting.
        ...(room?.ephemeral ? { deletedAt: sql`coalesce(${rooms.deletedAt}, ${now.toISOString()}::timestamptz)` } : {}),
      })
      .where(eq(rooms.id, roomId))
    const active = await tx
      .select({ id: recordings.id })
      .from(recordings)
      .where(and(eq(recordings.roomId, roomId), eq(recordings.status, 'recording'), isNull(recordings.endedAt)))
    return { meeting, waiting, active }
  })
  if (!ended) return false

  if (options.deleteLivekitRoom !== false) {
    try {
      await roomService().deleteRoom(roomId)
    } catch (error) {
      // The meeting is over in the database; the next meeting deletes any leftover room before creating its own.
      logger.warn('LiveKit deleteRoom failed', { roomId, err: error })
    }
  }
  const bus = eventBus()
  for (const row of ended.waiting) bus.publish({ type: 'lobby.decided', requestId: row.id, decision: 'ended' })
  for (const recording of ended.active) bus.publish({ type: 'recording.changed', roomId, recordingId: recording.id })
  bus.publish({ type: 'room.state', roomId })
  logger.info('meeting ended', { roomId, meetingId: ended.meeting.id, reason: options.reason })
  return true
}

export async function endMeetingsOfOwner(userId: string): Promise<number> {
  const live = await useDb()
    .select({ roomId: meetings.roomId })
    .from(meetings)
    .innerJoin(rooms, eq(rooms.id, meetings.roomId))
    .where(and(eq(rooms.ownerId, userId), isNull(meetings.endedAt)))
  let endedCount = 0
  for (const { roomId } of live) if (await endMeeting(roomId, { reason: 'owner_deleted' })) endedCount++
  return endedCount
}

export async function listMeetings(
  roomId: string,
  page: { page: number; pageSize: number },
): Promise<Paginated<MeetingSummary>> {
  const db = useDb()
  const [total] = await db.select({ value: count() }).from(meetings).where(eq(meetings.roomId, roomId))
  const rows = await db
    .select()
    .from(meetings)
    .where(eq(meetings.roomId, roomId))
    .orderBy(desc(meetings.startedAt))
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize)
  return {
    items: rows.map((m) => ({
      id: m.id,
      startedAt: m.startedAt.toISOString(),
      endedAt: m.endedAt?.toISOString() ?? null,
      peakParticipants: m.peakParticipants,
    })),
    page: page.page,
    pageSize: page.pageSize,
    total: total?.value ?? 0,
  }
}
