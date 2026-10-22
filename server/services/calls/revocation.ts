/**
 * `user.revoked` (rooms-backend, docs/SECURITY.md §4): a user who was disabled, deleted or lost every session is taken
 * out of live calls. Their connected identities are removed from LiveKit with their tokens revoked, their rows become
 * `left` (not final: after signing in again they may rejoin through the API) without a `joinedAt`, so the webhook
 * never takes them back as a reconnect, and their pending requests are closed (`ended`).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { useDb } from '../../database/client'
import { callParticipants } from '../../database/schema'
import { logger } from '../../utils/logger'
import { hintModerators } from '../livekit/hints'
import { roomService } from '../livekit/room-service'
import { notifyLobbyChanged, publishClosed } from '../lobby/lobby'
import { REVOKE_LEEWAY_MS } from './actions'

export async function removeUserFromLiveCalls(userId: string, now: Date = new Date()): Promise<number> {
  const db = useDb()
  const rows = await db
    .select()
    .from(callParticipants)
    .where(and(eq(callParticipants.userId, userId), inArray(callParticipants.status, ['waiting', 'admitted', 'joined'])))
  if (rows.length === 0) return 0
  // `joinedAt: null`: a revoked row is never taken back as a LiveKit reconnect (meetings/enforcement.ts).
  const closed = await db
    .update(callParticipants)
    .set({ status: 'left', leftAt: now, joinedAt: null })
    .where(
      and(
        inArray(
          callParticipants.id,
          rows.map((row) => row.id),
        ),
        inArray(callParticipants.status, ['waiting', 'admitted', 'joined']),
      ),
    )
    .returning({ id: callParticipants.id })
  const closedIds = new Set(closed.map((row) => row.id))
  const revokeTokensIssuedBefore = new Date(now.getTime() + REVOKE_LEEWAY_MS)
  const touched = new Map<string, string | null>()
  for (const row of rows) {
    if (!closedIds.has(row.id)) continue
    touched.set(row.roomId, row.meetingId)
    if (row.status === 'waiting') {
      publishClosed([row.id])
      continue
    }
    try {
      await roomService().removeParticipant(row.roomId, row.lkIdentity, { revokeTokensIssuedBefore })
    } catch (error) {
      logger.warn('removing a revoked user from LiveKit failed', { roomId: row.roomId, identity: row.lkIdentity, err: error })
    }
  }
  for (const [roomId, meetingId] of touched) {
    await notifyLobbyChanged(roomId, meetingId)
    await hintModerators(roomId, meetingId, 'participant.changed')
  }
  logger.info('revoked user removed from live calls', { userId, rows: closedIds.size })
  return closedIds.size
}
