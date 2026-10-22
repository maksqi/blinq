/**
 * The `participant_joined` verdict (rooms-backend, docs/SECURITY.md §4), pure so it can be unit-tested.
 *
 * `joinVerdict(row, context)` accepts the connection of an `admitted` or `joined` row of the room's live meeting, and
 * of a row of that meeting that `left` less than `RESUME_GRACE_MS` ago after a connection of its own (F-039): a full
 * LiveKit reconnect opens a new connection with the same token, and the old connection's `participant_left` may arrive
 * first. Everything else is removed: unknown identities, other rooms, deleted rooms, older meetings, waiting rows,
 * removed and denied rows, rows that left without ever connecting and rows closed by a revocation (which clears
 * `joinedAt`, see calls/revocation.ts).
 */
import { RESUME_GRACE_MS } from '../join/resume'
import type { ParticipantRow } from './meetings'

export type JoinVerdict = { accept: true; reconnect: boolean } | { accept: false; reason: string }

export function joinVerdict(
  row: Pick<ParticipantRow, 'roomId' | 'meetingId' | 'status' | 'joinedAt' | 'leftAt'> | undefined,
  context: { roomId: string; roomDeleted: boolean; liveMeetingId: string | null; now: Date },
): JoinVerdict {
  if (!row) return { accept: false, reason: 'unknown identity' }
  if (row.roomId !== context.roomId) return { accept: false, reason: 'other room' }
  if (context.roomDeleted) return { accept: false, reason: 'room deleted' }
  if (!context.liveMeetingId || row.meetingId !== context.liveMeetingId) {
    return { accept: false, reason: 'not in the live meeting' }
  }
  if (row.status === 'admitted' || row.status === 'joined') return { accept: true, reconnect: false }
  if (row.status === 'left' && reconnectable(row, context.now)) return { accept: true, reconnect: true }
  return { accept: false, reason: `status ${row.status}` }
}

/** A row that left after a connection of its own, recently enough for that connection's token to come back. */
export function reconnectable(row: Pick<ParticipantRow, 'joinedAt' | 'leftAt'>, now: Date): boolean {
  return row.joinedAt !== null && row.leftAt !== null && now.getTime() - row.leftAt.getTime() <= RESUME_GRACE_MS
}
