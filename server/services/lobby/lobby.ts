/**
 * Waiting room (rooms-backend, docs/API.md §6–7). Requests are `call_participants` rows with status `waiting`
 * (`meeting_id` is null until the meeting starts). Decisions publish `lobby.decided` on the bus; the owner's SSE
 * stream turns them into `WaitingEvent`s. Moderators get a `lobby.changed` hint whenever the lobby changes.
 *
 * - `notifyLobbyChanged(roomId, meetingId)`: bus `lobby.changed` + hint to connected hosts and co-hosts.
 * - `listLobby(roomId, meetingId, now)` → `LobbyEntry[]` ordered by request time.
 * - `admitRequest(caller, requestId, now)`, `denyRequest(caller, requestId, now)`, `admitAll(caller, now)`:
 *   admissions re-check capacity under the room lock (409 `ROOM_FULL`); an unknown or already decided request is
 *   404 `NOT_FOUND`. Admission applies the room's current self-unmute policy to the row.
 * - `closeWaiting(where, now)`: closes requests without a decision (`left`) and tells their streams.
 * - `closeStaleWaiting(now, roomId?)`: requests older than `WAITING_TTL_MS` (1 h) are closed.
 * - `loadOwnedRequest(event, requestId)`: the request row when the caller owns it (the same user, or the guest
 *   session behind the room's guest cookie), else 403 `FORBIDDEN`; unknown ids are 404 `NOT_FOUND`.
 * - `cancelRequest(event, requestId, now)`, `streamWaitingEvents(event, requestId)` (at most 2 open streams per
 *   request, the oldest is closed; at most 50 per network, then 429 `RATE_LIMITED`).
 */
import { and, asc, count, eq, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { WaitingEvent } from '#shared/schemas/join'
import type { LobbyEntry } from '#shared/schemas/calls'
import { useDb, type Db, type Tx } from '../../database/client'
import { callParticipants } from '../../database/schema'
import { apiError } from '../../utils/api-error'
import { getAuth } from '../../utils/auth'
import { getClientIp, limiterKeysForIp } from '../../utils/client-ip'
import { readGuestToken } from '../../utils/cookies'
import { eventBus, subscribeTo } from '../../utils/event-bus'
import { throwRateLimited } from '../../utils/limiter'
import { logger } from '../../utils/logger'
import { createSseStream, createSseStreamGroups } from '../../utils/sse'
import { findGuestSession } from '../session/callers'
import { getSettings } from '../settings/settings'
import { kindOf } from '../calls/live'
import { hintModerators } from '../livekit/hints'
import { buildJoinGrant } from '../join/grant'
import { capacityCheck } from '../join/checks'
import {
  effectiveMaxParticipants,
  findLiveMeeting,
  withRoomLock,
  type ParticipantRow,
} from '../meetings/meetings'
import { findRoomById, isUuid } from '../rooms/queries'
import { waitingEventFor } from './events'

export const WAITING_TTL_MS = 3_600_000

export async function notifyLobbyChanged(roomId: string, meetingId: string | null): Promise<void> {
  eventBus().publish({ type: 'lobby.changed', roomId })
  await hintModerators(roomId, meetingId, 'lobby.changed')
}

function waitingFor(roomId: string, meetingId: string): SQL {
  return and(
    eq(callParticipants.roomId, roomId),
    eq(callParticipants.status, 'waiting'),
    or(eq(callParticipants.meetingId, meetingId), isNull(callParticipants.meetingId)),
  )!
}

export async function closeWaiting(where: SQL, now: Date, db: Db | Tx = useDb()): Promise<string[]> {
  const closed = await db
    .update(callParticipants)
    .set({ status: 'left', leftAt: now })
    .where(and(eq(callParticipants.status, 'waiting'), where))
    .returning({ id: callParticipants.id })
  return closed.map((row) => row.id)
}

export function publishClosed(requestIds: string[], decision: 'ended' | 'denied' | 'removed' = 'ended'): void {
  const bus = eventBus()
  for (const requestId of requestIds) bus.publish({ type: 'lobby.decided', requestId, decision })
}

export async function closeStaleWaiting(now: Date = new Date(), roomId?: string): Promise<number> {
  const cutoff = new Date(now.getTime() - WAITING_TTL_MS)
  const closed = await closeWaiting(
    and(lt(callParticipants.requestedAt, cutoff), roomId ? eq(callParticipants.roomId, roomId) : undefined)!,
    now,
  )
  publishClosed(closed)
  return closed.length
}

/** Read-only (F-046): stale requests are left out here and closed by the rooms maintenance or the next decision. */
export async function listLobby(roomId: string, meetingId: string, now: Date = new Date()): Promise<LobbyEntry[]> {
  const cutoff = new Date(now.getTime() - WAITING_TTL_MS)
  const rows = await useDb()
    .select()
    .from(callParticipants)
    .where(and(waitingFor(roomId, meetingId), gte(callParticipants.requestedAt, cutoff)))
    .orderBy(asc(callParticipants.requestedAt), asc(callParticipants.id))
  return rows.map((row) => ({
    requestId: row.id,
    displayName: row.displayName,
    kind: kindOf(row),
    requestedAt: row.requestedAt.toISOString(),
  }))
}

async function activeCount(tx: Db | Tx, meetingId: string): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(callParticipants)
    .where(and(eq(callParticipants.meetingId, meetingId), inArray(callParticipants.status, ['admitted', 'joined'])))
  return row?.value ?? 0
}

async function admitUnderLock(
  caller: ParticipantRow,
  pick: (tx: Tx, meetingId: string, available: number) => Promise<string[]>,
  now: Date,
): Promise<string[]> {
  // Loaded before taking the lock: everything under it uses the transaction's connection only.
  const settings = await getSettings()
  return withRoomLock(caller.roomId, async (tx) => {
    const meeting = await findLiveMeeting(tx, caller.roomId)
    const room = await findRoomById(caller.roomId, { db: tx })
    if (!meeting || !room || meeting.id !== caller.meetingId) throw apiError('NOT_FOUND', 404)
    const max = effectiveMaxParticipants(room, settings)
    const available = Math.max(0, max - (await activeCount(tx, meeting.id)))
    const ids = await pick(tx, meeting.id, available)
    if (ids.length === 0) return []
    const admitted = await tx
      .update(callParticipants)
      .set({
        status: 'admitted',
        admittedAt: now,
        admittedByParticipantId: caller.id,
        meetingId: meeting.id,
        micAllowed: room.allowSelfUnmute,
      })
      .where(and(inArray(callParticipants.id, ids), waitingFor(caller.roomId, meeting.id)))
      .returning({ id: callParticipants.id })
    return admitted.map((row) => row.id)
  })
}

export async function admitRequest(caller: ParticipantRow, requestId: string, now: Date = new Date()): Promise<void> {
  if (!isUuid(requestId)) throw apiError('NOT_FOUND', 404)
  await closeStaleWaiting(now, caller.roomId)
  const admitted = await admitUnderLock(
    caller,
    async (tx, meetingId, available) => {
      const [row] = await tx
        .select({ id: callParticipants.id })
        .from(callParticipants)
        .where(and(eq(callParticipants.id, requestId), waitingFor(caller.roomId, meetingId)))
        .limit(1)
      if (!row) throw apiError('NOT_FOUND', 404)
      if (capacityCheck(0, available)) throw apiError('ROOM_FULL', 409)
      return [row.id]
    },
    now,
  )
  // Another moderator may have decided in the meantime.
  if (admitted.length === 0) throw apiError('NOT_FOUND', 404)
  for (const id of admitted) eventBus().publish({ type: 'lobby.decided', requestId: id, decision: 'admitted' })
  await notifyLobbyChanged(caller.roomId, caller.meetingId)
}

export async function admitAll(caller: ParticipantRow, now: Date = new Date()): Promise<number> {
  await closeStaleWaiting(now, caller.roomId)
  const admitted = await admitUnderLock(
    caller,
    async (tx, meetingId, available) => {
      if (available === 0) return []
      const rows = await tx
        .select({ id: callParticipants.id })
        .from(callParticipants)
        .where(waitingFor(caller.roomId, meetingId))
        .orderBy(asc(callParticipants.requestedAt), asc(callParticipants.id))
        .limit(available)
      return rows.map((row) => row.id)
    },
    now,
  )
  for (const id of admitted) eventBus().publish({ type: 'lobby.decided', requestId: id, decision: 'admitted' })
  if (admitted.length) await notifyLobbyChanged(caller.roomId, caller.meetingId)
  return admitted.length
}

export async function denyRequest(caller: ParticipantRow, requestId: string, now: Date = new Date()): Promise<void> {
  if (!isUuid(requestId) || !caller.meetingId) throw apiError('NOT_FOUND', 404)
  const [row] = await useDb()
    .update(callParticipants)
    .set({ status: 'denied', leftAt: now, admittedByParticipantId: caller.id, meetingId: caller.meetingId })
    .where(and(eq(callParticipants.id, requestId), waitingFor(caller.roomId, caller.meetingId)))
    .returning({ id: callParticipants.id })
  if (!row) throw apiError('NOT_FOUND', 404)
  eventBus().publish({ type: 'lobby.decided', requestId: row.id, decision: 'denied' })
  await notifyLobbyChanged(caller.roomId, caller.meetingId)
}

// ---- Request owner: SSE and cancel -------------------------------------------------------------------------------

export async function loadOwnedRequest(event: H3Event, requestId: string): Promise<ParticipantRow> {
  if (!isUuid(requestId)) throw apiError('NOT_FOUND', 404)
  const [row] = await useDb().select().from(callParticipants).where(eq(callParticipants.id, requestId)).limit(1)
  if (!row) throw apiError('NOT_FOUND', 404)
  if (row.userId) {
    const { user } = await getAuth(event)
    if (user?.id === row.userId) return row
    throw apiError('FORBIDDEN', 403)
  }
  if (row.guestSessionId) {
    const room = await findRoomById(row.roomId, { includeDeleted: true })
    const token = room ? readGuestToken(event, room.slug) : null
    const guest = token ? await findGuestSession(token, row.roomId) : null
    if (guest && guest.id === row.guestSessionId) return row
  }
  throw apiError('FORBIDDEN', 403)
}

export async function cancelRequest(event: H3Event, requestId: string, now: Date = new Date()): Promise<void> {
  const row = await loadOwnedRequest(event, requestId)
  const closed = await closeWaiting(eq(callParticipants.id, row.id), now)
  if (closed.length === 0) return
  publishClosed(closed)
  await notifyLobbyChanged(row.roomId, row.meetingId)
}

export async function currentWaitingEvent(requestId: string): Promise<WaitingEvent> {
  const db = useDb()
  const [row] = await db.select().from(callParticipants).where(eq(callParticipants.id, requestId)).limit(1)
  const room = row ? await findRoomById(row.roomId, { includeDeleted: true }) : null
  if (!row || !room) return { event: 'ended', data: {} }
  const meeting = await findLiveMeeting(db, room.id)
  const kind = waitingEventFor(row, {
    liveMeetingId: meeting?.id ?? null,
    roomLocked: room.locked,
    roomDeleted: room.deletedAt !== null,
  })
  switch (kind.event) {
    case 'status':
      return { event: 'status', data: { status: 'waiting' } }
    case 'admitted': {
      const { status: _status, ...grant } = await buildJoinGrant(room, meeting!, row)
      return { event: 'admitted', data: grant }
    }
    case 'denied':
      return { event: 'denied', data: { reason: kind.reason } }
    default:
      return { event: 'ended', data: {} }
  }
}

/**
 * Caps on open waiting-room streams (decision, F-019): a request keeps its 2 newest streams (a reloaded tab replaces
 * the stream of the old page; the oldest is closed), and one network (IPv4 address or IPv6 /64) holds at most 50,
 * the size of a full lobby; beyond that 429 `RATE_LIMITED`.
 */
export const WAITING_STREAMS_PER_REQUEST = 2
export const WAITING_STREAMS_PER_NETWORK = 50
export const WAITING_STREAMS_RETRY_AFTER_MS = 10_000
const streamsByRequest = createSseStreamGroups()
const streamsByNetwork = createSseStreamGroups()

export async function streamWaitingEvents(event: H3Event, requestId: string): Promise<void> {
  const row = await loadOwnedRequest(event, requestId)
  while (streamsByRequest.count(row.id) >= WAITING_STREAMS_PER_REQUEST) streamsByRequest.oldest(row.id)!.close()
  const network = limiterKeysForIp(getClientIp(event)).net
  if (streamsByNetwork.count(network) >= WAITING_STREAMS_PER_NETWORK) {
    throwRateLimited(event, WAITING_STREAMS_RETRY_AFTER_MS)
  }
  const stream = createSseStream(event)
  streamsByRequest.add(row.id, stream)
  streamsByNetwork.add(network, stream)
  let chain: Promise<void> = Promise.resolve()
  const deliver = async () => {
    if (stream.closed) return
    const next = await currentWaitingEvent(row.id)
    if (stream.closed) return
    stream.send(next.event, next.data)
    if (next.event !== 'status') stream.close()
  }
  const refresh = () => {
    chain = chain.then(deliver).catch((error: unknown) => {
      logger.warn('waiting-room stream failed', { requestId: row.id, err: error })
      stream.close()
    })
  }
  // Subscribe before reading the current state, so no decision can slip in between.
  stream.onClose(
    subscribeTo('lobby.decided', (decided) => {
      if (decided.requestId === row.id) refresh()
    }),
  )
  refresh()
  return stream.start()
}
