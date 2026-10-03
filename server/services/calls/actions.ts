/**
 * In-call actions (rooms-backend, docs/API.md §7). Handlers call `authorizeCall` first; every action then writes the
 * database, applies the change through the `RoomServiceAdapter`, runs `publishRoomState` when room state changed, and
 * writes an audit entry (actor = the caller's participant row). LiveKit failures answer 503 (livekit/errors.ts).
 *
 * Effects:
 * - `renameSelf` / `renameParticipant`: row name → LiveKit name. `setOwnHand` / `lowerHand`: `hand_raised_at` → `hand`
 *   attribute (raising twice keeps the first time, so the queue order holds).
 * - `muteParticipant`: server-mutes the published tracks of one source (screen share includes its audio).
 * - `setPermissions` ("give voice"): `mic_allowed` / `camera_allowed` → the complete permission object; a revoked
 *   source is muted at once. `askToUnmute`: the `ask-unmute` hint to the target only, never a forced unmute.
 * - `setVolume`: `volume_level` → `vol` attribute (everyone applies it).
 * - `removeParticipant`: every live row of that person in the meeting (other tabs too, never the caller's own) is
 *   `removed` (final for the meeting), their pending requests are closed as `removed`, and LiveKit removes the
 *   identities with `revokeTokensIssuedBefore` one minute ahead (LiveKit's own default leeway) (decision).
 * - `changeRole`: the row's role and permissions; users are persisted in (or removed from) `room_members`, guests
 *   only on the live row. A co-host demoted under the "hosts" share policy has a running screen share muted.
 * - `muteAll`: mutes the microphones of all participants (not hosts and co-hosts); `preventSelfUnmute` also turns
 *   the room's self-unmute off (metadata + every participant's microphone allowance) (decision).
 * - `updateLiveSettings`: `locked` (lock also closes the lobby: waiting requests get `denied { reason: 'locked' }`
 *   (decision)), `waitingRoom`, `screenSharePolicy`, `allowSelfUnmute`, `chatEnabled` → room row → live
 *   permissions → `publishRoomState` → `{ state }`. The lock resets when the meeting ends; the other settings are room
 *   settings and persist.
 * - `endCall`: ends the meeting for everyone (`deleteRoom`, waiters get `ended`).
 */
import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { z } from 'zod'
import type { CallParticipantInfo, liveSettingsSchema } from '#shared/schemas/calls'
import type { RoomMetadata } from '#shared/schemas/livekit'
import type { TrackSourceName } from '../../contracts'
import { useDb } from '../../database/client'
import { callParticipants, roomMembers, rooms } from '../../database/schema'
import { apiError } from '../../utils/api-error'
import { audit } from '../audit/audit'
import { renameGuestSession } from '../guests/guests'
import { withLivekit } from '../livekit/errors'
import { hintModerators, sendHint } from '../livekit/hints'
import { publishRoomState } from '../livekit/publish-room-state'
import { roomService } from '../livekit/room-service'
import { closeWaiting, notifyLobbyChanged, publishClosed } from '../lobby/lobby'
import { endMeeting, withRoomLock, type ParticipantRow } from '../meetings/meetings'
import type { CallContext } from './authorize'
import { applyLivePolicy, forEachRow, kindOf, LIVE_STATUSES, liveRows, muteSources, pushParticipantState } from './live'

export type LiveSettingsInput = z.infer<typeof liveSettingsSchema>

/** A removed identity's tokens stop working immediately and for the next minute of clock skew. */
export const REVOKE_LEEWAY_MS = 60_000

function targetOf(ctx: CallContext): ParticipantRow {
  if (!ctx.target) throw apiError('NOT_FOUND', 404)
  return ctx.target
}

export async function auditCall(
  event: H3Event,
  ctx: CallContext,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await audit(event, {
    action,
    actorUserId: ctx.caller.userId,
    actorParticipantId: ctx.caller.id,
    targetType: ctx.target ? 'participant' : 'room',
    targetId: ctx.target?.id ?? ctx.room.id,
    details: { roomId: ctx.room.id, ...(ctx.target ? { identity: ctx.target.lkIdentity } : {}), ...details },
  })
}

async function updateRow(id: string, set: Partial<typeof callParticipants.$inferInsert>): Promise<ParticipantRow> {
  const [row] = await useDb()
    .update(callParticipants)
    .set(set)
    .where(and(eq(callParticipants.id, id), inArray(callParticipants.status, [...LIVE_STATUSES])))
    .returning()
  if (!row) throw apiError('NOT_FOUND', 404)
  return row
}

export function toCallParticipantInfo(row: ParticipantRow): CallParticipantInfo {
  return {
    identity: row.lkIdentity,
    displayName: row.displayName,
    role: row.roomRole,
    kind: kindOf(row),
    micAllowed: row.micAllowed,
    cameraAllowed: row.cameraAllowed,
    volumeLevel: row.volumeLevel,
    handRaisedAt: row.handRaisedAt?.toISOString() ?? null,
    joinedAt: row.joinedAt?.toISOString() ?? null,
  }
}

const ROLE_ORDER = { host: 0, cohost: 1, participant: 2 } as const

export async function listParticipants(ctx: CallContext): Promise<CallParticipantInfo[]> {
  const rows = await liveRows(ctx.meetingId)
  rows.sort(
    (a, b) =>
      ROLE_ORDER[a.roomRole] - ROLE_ORDER[b.roomRole] ||
      (a.admittedAt?.getTime() ?? 0) - (b.admittedAt?.getTime() ?? 0) ||
      a.id.localeCompare(b.id),
  )
  return rows.map(toCallParticipantInfo)
}

// ---- Self ------------------------------------------------------------------------------------------------------------

export async function renameSelf(event: H3Event, ctx: CallContext, displayName: string): Promise<void> {
  const row = await updateRow(ctx.caller.id, { displayName })
  if (row.guestSessionId) await renameGuestSession(useDb(), row.guestSessionId, displayName)
  await withLivekit('updateParticipant', () => pushParticipantState(ctx.room, row, { name: true }))
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.rename_self')
}

export async function setOwnHand(ctx: CallContext, raised: boolean, now: Date = new Date()): Promise<void> {
  const row = await updateRow(ctx.caller.id, { handRaisedAt: raised ? (ctx.caller.handRaisedAt ?? now) : null })
  await withLivekit('updateParticipant', () => pushParticipantState(ctx.room, row, { attributes: true }))
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
}

// ---- Moderation ------------------------------------------------------------------------------------------------------

export async function muteParticipant(
  event: H3Event,
  ctx: CallContext,
  source: 'microphone' | 'camera' | 'screen_share',
): Promise<void> {
  const target = targetOf(ctx)
  const sources: TrackSourceName[] = source === 'screen_share' ? ['screen_share', 'screen_share_audio'] : [source]
  await withLivekit('mutePublishedTrack', () => muteSources(ctx.room.id, target.lkIdentity, sources))
  await auditCall(event, ctx, 'call.mute', { source })
}

export async function setPermissions(
  event: H3Event,
  ctx: CallContext,
  input: { microphone?: boolean; camera?: boolean },
): Promise<void> {
  const target = targetOf(ctx)
  const set: Partial<typeof callParticipants.$inferInsert> = {}
  if (input.microphone !== undefined) set.micAllowed = input.microphone
  if (input.camera !== undefined) set.cameraAllowed = input.camera
  const row = Object.keys(set).length ? await updateRow(target.id, set) : target
  const revoked: TrackSourceName[] = []
  if (row.roomRole === 'participant' && !row.micAllowed && input.microphone === false) revoked.push('microphone')
  if (row.roomRole === 'participant' && !row.cameraAllowed && input.camera === false) revoked.push('camera')
  await withLivekit('updateParticipant', async () => {
    await pushParticipantState(ctx.room, row, { permission: true })
    await muteSources(ctx.room.id, row.lkIdentity, revoked)
  })
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.permissions', { microphone: input.microphone ?? null, camera: input.camera ?? null })
}

export async function askToUnmute(event: H3Event, ctx: CallContext): Promise<void> {
  const target = targetOf(ctx)
  await sendHint(ctx.room.id, [target.lkIdentity], 'ask-unmute')
  await auditCall(event, ctx, 'call.ask_unmute')
}

export async function setVolume(event: H3Event, ctx: CallContext, level: number): Promise<void> {
  const row = await updateRow(targetOf(ctx).id, { volumeLevel: level })
  await withLivekit('updateParticipant', () => pushParticipantState(ctx.room, row, { attributes: true }))
  await auditCall(event, ctx, 'call.volume', { level })
}

export async function renameParticipant(event: H3Event, ctx: CallContext, displayName: string): Promise<void> {
  const row = await updateRow(targetOf(ctx).id, { displayName })
  if (row.guestSessionId) await renameGuestSession(useDb(), row.guestSessionId, displayName)
  await withLivekit('updateParticipant', () => pushParticipantState(ctx.room, row, { name: true }))
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.rename')
}

export async function lowerHand(event: H3Event, ctx: CallContext): Promise<void> {
  const row = await updateRow(targetOf(ctx).id, { handRaisedAt: null })
  await withLivekit('updateParticipant', () => pushParticipantState(ctx.room, row, { attributes: true }))
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.lower_hand')
}

export async function removeParticipant(event: H3Event, ctx: CallContext, now: Date = new Date()): Promise<void> {
  const target = targetOf(ctx)
  const person = target.userId
    ? eq(callParticipants.userId, target.userId)
    : target.guestSessionId
      ? eq(callParticipants.guestSessionId, target.guestSessionId)
      : eq(callParticipants.id, target.id)
  const db = useDb()
  const removed = await db
    .update(callParticipants)
    .set({ status: 'removed', leftAt: now })
    .where(
      and(
        eq(callParticipants.meetingId, ctx.meetingId),
        inArray(callParticipants.status, [...LIVE_STATUSES]),
        or(eq(callParticipants.id, target.id), person),
        ne(callParticipants.id, ctx.caller.id),
      ),
    )
    .returning()
  if (!removed.some((row) => row.id === target.id)) throw apiError('NOT_FOUND', 404)
  const closed = await db
    .update(callParticipants)
    .set({ status: 'removed', leftAt: now })
    .where(
      and(
        eq(callParticipants.roomId, ctx.room.id),
        eq(callParticipants.status, 'waiting'),
        or(eq(callParticipants.meetingId, ctx.meetingId), isNull(callParticipants.meetingId)),
        person,
      ),
    )
    .returning({ id: callParticipants.id })

  const revokeTokensIssuedBefore = new Date(now.getTime() + REVOKE_LEEWAY_MS)
  await withLivekit('removeParticipant', () =>
    forEachRow(removed, (row) => roomService().removeParticipant(ctx.room.id, row.lkIdentity, { revokeTokensIssuedBefore })),
  )
  publishClosed(
    closed.map((row) => row.id),
    'removed',
  )
  if (closed.length) await notifyLobbyChanged(ctx.room.id, ctx.meetingId)
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.remove', { identities: removed.map((row) => row.lkIdentity) })
}

export async function changeRole(event: H3Event, ctx: CallContext, role: 'cohost' | 'participant'): Promise<void> {
  const target = targetOf(ctx)
  const db = useDb()
  const row = await updateRow(target.id, { roomRole: role, ...(role === 'cohost' ? { micAllowed: true, cameraAllowed: true } : {}) })
  if (row.userId) {
    if (role === 'cohost') {
      await db.insert(roomMembers).values({ roomId: ctx.room.id, userId: row.userId, role: 'cohost' }).onConflictDoNothing()
    } else {
      await db.delete(roomMembers).where(and(eq(roomMembers.roomId, ctx.room.id), eq(roomMembers.userId, row.userId)))
    }
  }
  await withLivekit('updateParticipant', () => pushParticipantState(ctx.room, row, { attributes: true, permission: true }))
  // Under the "hosts" share policy a demoted co-host loses screen sharing: like any revoked source, a running share is
  // muted at once, whatever LiveKit does with the old publication (F-046).
  if (role === 'participant' && ctx.room.screenSharePolicy === 'hosts') {
    await withLivekit('mutePublishedTrack', () =>
      muteSources(ctx.room.id, row.lkIdentity, ['screen_share', 'screen_share_audio']),
    )
  }
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.role', { role })
}

export async function muteAll(event: H3Event, ctx: CallContext, preventSelfUnmute: boolean): Promise<void> {
  if (preventSelfUnmute) {
    await useDb().update(rooms).set({ allowSelfUnmute: false }).where(eq(rooms.id, ctx.room.id))
    await withLivekit('updateParticipant', () => applyLivePolicy(ctx.room.id, { allowSelfUnmute: false }))
    await withLivekit('updateRoomMetadata', () => publishRoomState(ctx.room.id))
  }
  const targets = (await liveRows(ctx.meetingId)).filter((row) => row.roomRole === 'participant' && row.id !== ctx.caller.id)
  await withLivekit('mutePublishedTrack', () =>
    forEachRow(targets, (row) => muteSources(ctx.room.id, row.lkIdentity, ['microphone'])),
  )
  await hintModerators(ctx.room.id, ctx.meetingId, 'participant.changed')
  await auditCall(event, ctx, 'call.mute_all', { preventSelfUnmute, participants: targets.length })
}

export function liveSettingsActions(patch: LiveSettingsInput): Array<'call.lock' | 'call.settings'> {
  const actions: Array<'call.lock' | 'call.settings'> = []
  if (patch.locked !== undefined) actions.push('call.lock')
  if (Object.entries(patch).some(([key, value]) => key !== 'locked' && value !== undefined)) actions.push('call.settings')
  return actions
}

export async function updateLiveSettings(
  event: H3Event,
  ctx: CallContext,
  patch: LiveSettingsInput,
  now: Date = new Date(),
): Promise<RoomMetadata> {
  const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as LiveSettingsInput
  const before = ctx.room
  if (Object.keys(changes).length) {
    const closed = await withRoomLock(ctx.room.id, async (tx) => {
      await tx.update(rooms).set(changes).where(eq(rooms.id, ctx.room.id))
      if (changes.locked !== true || before.locked) return []
      // Locking lets nobody new in, including people still waiting.
      return closeWaiting(eq(callParticipants.roomId, ctx.room.id), now, tx)
    })
    if (closed.length) {
      publishClosed(closed, 'denied')
      await notifyLobbyChanged(ctx.room.id, ctx.meetingId)
    }
    await withLivekit('updateParticipant', () =>
      applyLivePolicy(ctx.room.id, {
        allowSelfUnmute: changes.allowSelfUnmute !== undefined && changes.allowSelfUnmute !== before.allowSelfUnmute ? changes.allowSelfUnmute : undefined,
        screenSharePolicy:
          changes.screenSharePolicy !== undefined && changes.screenSharePolicy !== before.screenSharePolicy
            ? changes.screenSharePolicy
            : undefined,
      }),
    )
  }
  const state = await withLivekit('updateRoomMetadata', () => publishRoomState(ctx.room.id))
  if (!state) throw apiError('NOT_FOUND', 404)
  if (Object.keys(changes).length) await auditCall(event, ctx, 'call.settings', { changes })
  return state
}

export async function endCall(event: H3Event, ctx: CallContext): Promise<void> {
  await endMeeting(ctx.room.id, { reason: 'ended_by_host' })
  await auditCall(event, ctx, 'call.end')
}
