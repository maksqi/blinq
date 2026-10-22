/**
 * Joining a room (rooms-backend, docs/API.md §6, docs/SECURITY.md §3–4).
 *
 * - `getJoinInfo(event, slug, input)` → `JoinInfo`: checks the proof and a supplied invite (never consumes it).
 * - `joinRoom(event, slug, input)` → `{ status: 200, body: JoinGrant }` or `{ status: 202, body: JoinWaiting }`.
 *   Order (checks.ts): proof → resume → invite → guests allowed → lock → password (backoff reserved before the check)
 *   → removed/denied in the live meeting → capacity → waiting room (participants on the network of a removed or
 *   denied row wait too, even without a waiting room: F-018). Everything from the removed/denied check on runs under
 *   the room lock, together with the invite use, the guest session, meeting creation (first admitted join: epoch +
 *   LiveKit room) and the row insert, so concurrent joins can neither exceed limits nor start two meetings.
 * - `proofMatches(room, proof)`: `sha256(proof)` against `join_proof_hash` in constant time (`hashToken` stores the
 *   hex digest of the base64url proof exactly as sent, like every other token).
 * A wrong proof reveals nothing about the room (403 `ROOM_KEY_INVALID`); unknown or deleted slugs are 404.
 */
import { and, count, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { z } from 'zod'
import { slugSchema } from '#shared/schemas/common'
import type { JoinInfo, joinInfoSchema, JoinResponse, joinRequestSchema } from '#shared/schemas/join'
import { useDb, type Tx } from '../../database/client'
import { callParticipants } from '../../database/schema'
import { apiError } from '../../utils/api-error'
import { getAuth } from '../../utils/auth'
import { getClientIp, limiterKeysForIp } from '../../utils/client-ip'
import { setGuestCookie } from '../../utils/cookies'
import { hashToken, safeEqual } from '../../utils/crypto'
import {
  clearLoginFailures,
  consumeOr429,
  refundAttempt,
  reserveAttempt,
  roomPasswordThrottleKey,
  throwRateLimited,
} from '../../utils/limiter'
import { verifyPassword } from '../../utils/password'
import { getSettings } from '../settings/settings'
import { createGuestSession, guestSessionForRequest, renameGuestSession } from '../guests/guests'
import { consumeInvite, findInviteByToken } from '../invites/invites'
import { inviteState, inviteUsableForInfo } from '../invites/policy'
import { withLivekit } from '../livekit/errors'
import { activeRecording } from '../livekit/publish-room-state'
import { newIdentity } from '../livekit/token'
import { notifyLobbyChanged } from '../lobby/lobby'
import {
  createMeeting,
  effectiveMaxParticipants,
  findLiveMeeting,
  withRoomLock,
  type MeetingRow,
  type ParticipantRow,
  type RoomRow,
} from '../meetings/meetings'
import { findRoomById, findRoomBySlug, roleOfUser } from '../rooms/queries'
import {
  capacityCheck,
  finalStatusCheck,
  guestCheck,
  initialAllowances,
  inviteCheck,
  lobbyCapacityCheck,
  lobbyNeeded,
  lockCheck,
  passwordNeeded,
  sharesNetwork,
} from './checks'
import { buildJoinGrant } from './grant'
import { pickResumable } from './resume'

export type JoinInfoInput = z.infer<typeof joinInfoSchema>
export type JoinRequestInput = z.infer<typeof joinRequestSchema>
export type JoinOutcome = { status: 200 | 202; body: JoinResponse }

type Who = { userId: string } | { guestSessionId: string }

export function proofMatches(room: Pick<RoomRow, 'joinProofHash'>, proof: string): boolean {
  return safeEqual(hashToken(proof), room.joinProofHash)
}

async function joinableRoom(event: H3Event, slug: string, proof: string): Promise<RoomRow> {
  consumeOr429(event, 'join-ip', limiterKeysForIp(getClientIp(event)).net)
  const room = slugSchema.safeParse(slug).success ? await findRoomBySlug(slug) : null
  if (!room) throw apiError('ROOM_NOT_FOUND', 404)
  if (!proofMatches(room, proof)) throw apiError('ROOM_KEY_INVALID', 403)
  return room
}

export async function getJoinInfo(event: H3Event, slug: string, input: JoinInfoInput, now = new Date()): Promise<JoinInfo> {
  const room = await joinableRoom(event, slug, input.proof)
  const { user } = await getAuth(event)
  const role = user ? await roleOfUser(room, user.id) : 'participant'
  // Moderators need no invite, so a stale one in their link does not matter (decision).
  if (input.inviteToken && role === 'participant') {
    const invite = await findInviteByToken(room.id, input.inviteToken)
    if (!inviteUsableForInfo(invite ? inviteState(invite, now) : null)) throw apiError('ROOM_INVITE_INVALID', 403)
  }
  const settings = await getSettings()
  const db = useDb()
  const meeting = await findLiveMeeting(db, room.id)
  return {
    roomId: room.id,
    name: room.name,
    needsPassword: passwordNeeded(role, room.passwordHash !== null),
    waitingRoom: lobbyNeeded(role, room.waitingRoom),
    recordingActive: meeting ? (await activeRecording(db, room.id, meeting.id)) !== null : false,
    yourRole: role,
    signedIn: user !== null,
    guestsAllowed: settings['guests.allowed'] && room.allowGuests,
    muteOnJoin: room.muteOnJoin,
  }
}

function whoCondition(who: Who) {
  return 'userId' in who ? eq(callParticipants.userId, who.userId) : eq(callParticipants.guestSessionId, who.guestSessionId)
}

async function tryResume(
  room: RoomRow,
  who: Who,
  clientId: string,
  now: Date,
): Promise<{ kind: 'grant'; row: ParticipantRow; meeting: MeetingRow } | { kind: 'waiting'; row: ParticipantRow } | null> {
  return withRoomLock(room.id, async (tx) => {
    const meeting = await findLiveMeeting(tx, room.id)
    const candidates = await tx
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.roomId, room.id),
          whoCondition(who),
          eq(callParticipants.clientId, clientId),
          inArray(callParticipants.status, ['waiting', 'admitted', 'joined', 'left']),
        ),
      )
      .orderBy(desc(callParticipants.createdAt))
      .limit(5)
    const pick = pickResumable(candidates, { liveMeetingId: meeting?.id ?? null, clientId, now })
    if (!pick) return null
    if (pick.kind === 'waiting') return { kind: 'waiting', row: pick.row }
    // The row waits for its new connection: events of the previous connection no longer apply (webhooks.ts).
    const [row] = await tx
      .update(callParticipants)
      .set({ status: 'admitted', joinedAt: null, leftAt: null })
      .where(eq(callParticipants.id, pick.row.id))
      .returning()
    return { kind: 'grant', row: row!, meeting: meeting! }
  })
}

async function checkRoomPassword(event: H3Event, room: RoomRow, password: string | undefined, now: Date): Promise<void> {
  if (!password) throw apiError('ROOM_PASSWORD_REQUIRED', 403)
  const key = roomPasswordThrottleKey(room.id, getClientIp(event))
  // Reserved before the check (counted as a failure up front), so parallel guesses see each other (F-026).
  const decision = await reserveAttempt([{ key }], now)
  if (!decision.allowed) throwRateLimited(event, decision.retryAfterMs)
  let verified: boolean
  try {
    verified = await verifyPassword(room.passwordHash!, password)
  } catch (error) {
    await refundAttempt(decision.reservation)
    throw error
  }
  if (!verified) throw apiError('ROOM_PASSWORD_INVALID', 403)
  await clearLoginFailures([key])
}

async function finalStatuses(tx: Tx, meetingId: string, who: Who): Promise<string[]> {
  const rows = await tx
    .select({ status: callParticipants.status })
    .from(callParticipants)
    .where(
      and(
        eq(callParticipants.meetingId, meetingId),
        whoCondition(who),
        inArray(callParticipants.status, ['removed', 'denied']),
      ),
    )
  return rows.map((row) => row.status)
}

/** IPs of the people removed from or denied in the meeting (rows keep the IP they joined from). */
async function refusedIps(tx: Tx, meetingId: string): Promise<string[]> {
  const rows = await tx
    .select({ ip: callParticipants.ip })
    .from(callParticipants)
    .where(
      and(
        eq(callParticipants.meetingId, meetingId),
        inArray(callParticipants.status, ['removed', 'denied']),
        isNotNull(callParticipants.ip),
      ),
    )
  return rows.flatMap((row) => (row.ip ? [row.ip] : []))
}

async function countRows(tx: Tx, where: ReturnType<typeof and>): Promise<number> {
  const [row] = await tx.select({ value: count() }).from(callParticipants).where(where)
  return row?.value ?? 0
}

export async function joinRoom(event: H3Event, slug: string, input: JoinRequestInput, now = new Date()): Promise<JoinOutcome> {
  const room = await joinableRoom(event, slug, input.proof)
  const ip = getClientIp(event)
  const { user } = await getAuth(event)
  const guest = user ? null : await guestSessionForRequest(event, room, now)
  const who: Who | null = user ? { userId: user.id } : guest ? { guestSessionId: guest.id } : null
  const role = user ? await roleOfUser(room, user.id) : 'participant'

  if (who) {
    const resumed = await tryResume(room, who, input.clientId, now)
    if (resumed?.kind === 'waiting') return { status: 202, body: { status: 'waiting', requestId: resumed.row.id } }
    if (resumed) return { status: 200, body: await buildJoinGrant(room, resumed.meeting, resumed.row) }
  }

  const invite = role === 'participant' && input.inviteToken ? await findInviteByToken(room.id, input.inviteToken) : null
  const inviteError = inviteCheck(role, input.inviteToken, invite ? inviteState(invite, now) : null)
  if (inviteError) throw apiError(inviteError, 403)

  const settings = await getSettings()
  const guestError = guestCheck(!user, {
    serverAllowsGuests: settings['guests.allowed'],
    roomAllowsGuests: room.allowGuests,
  })
  if (guestError) throw apiError(guestError, 403)
  const displayName = user ? user.displayName : input.displayName
  if (!displayName) {
    throw apiError('VALIDATION_FAILED', 400, { issues: [{ path: 'displayName', message: 'Enter a name' }] })
  }

  const locked = lockCheck(role, room.locked)
  if (locked) throw apiError(locked, 403)
  if (passwordNeeded(role, room.passwordHash !== null)) await checkRoomPassword(event, room, input.password, now)

  const outcome = await withRoomLock(room.id, async (tx) => {
    // The room may have changed while the password was checked.
    const current = await findRoomById(room.id, { db: tx })
    if (!current) throw apiError('ROOM_NOT_FOUND', 404)
    if (!proofMatches(current, input.proof)) throw apiError('ROOM_KEY_INVALID', 403)
    const lockedNow = lockCheck(role, current.locked)
    if (lockedNow) throw apiError(lockedNow, 403)

    let meeting = await findLiveMeeting(tx, room.id)
    if (meeting && who) {
      const final = finalStatusCheck(await finalStatuses(tx, meeting.id, who))
      if (final) throw apiError(final, 403)
    }
    const active = meeting
      ? await countRows(
          tx,
          and(eq(callParticipants.meetingId, meeting.id), inArray(callParticipants.status, ['admitted', 'joined'])),
        )
      : 0
    const full = capacityCheck(active, effectiveMaxParticipants(current, settings))
    if (full) throw apiError(full, 409)

    // A fresh cookie or a dropped session must not undo a removal (F-018): someone on the network of a removed or
    // denied participant asks the moderators first, even in a room without a waiting room. Never a refusal: a shared
    // network (an office NAT) holds innocent people too.
    const lobby =
      lobbyNeeded(role, current.waitingRoom) ||
      (role === 'participant' && meeting !== null && sharesNetwork(ip, await refusedIps(tx, meeting.id)))
    if (lobby) {
      const waiting = await countRows(
        tx,
        and(
          eq(callParticipants.roomId, room.id),
          eq(callParticipants.status, 'waiting'),
          meeting ? or(eq(callParticipants.meetingId, meeting.id), isNull(callParticipants.meetingId)) : isNull(callParticipants.meetingId),
        ),
      )
      const lobbyFull = lobbyCapacityCheck(waiting)
      if (lobbyFull) throw apiError(lobbyFull, 409)
    }

    if (invite && !(await consumeInvite(tx, room.id, invite.id, now))) throw apiError('ROOM_INVITE_INVALID', 403)

    let guestSessionId = guest?.id ?? null
    let guestCookie: { token: string; expiresAt: Date } | null = null
    if (!user) {
      if (guest) {
        if (guest.displayName !== displayName) await renameGuestSession(tx, guest.id, displayName)
      } else {
        const created = await createGuestSession(tx, { roomId: room.id, displayName, ip, now })
        guestSessionId = created.session.id
        guestCookie = { token: created.token, expiresAt: created.session.expiresAt }
      }
    }

    if (!lobby && !meeting) {
      const room = current
      meeting = await withLivekit('createRoom', () => createMeeting(tx, room, settings, now))
    }
    const [row] = await tx
      .insert(callParticipants)
      .values({
        lkIdentity: newIdentity(),
        roomId: room.id,
        meetingId: meeting?.id ?? null,
        userId: user?.id ?? null,
        guestSessionId,
        clientId: input.clientId,
        displayName,
        roomRole: role,
        status: lobby ? 'waiting' : 'admitted',
        ...initialAllowances(role, current),
        requestedAt: now,
        admittedAt: lobby ? null : now,
        ip,
      })
      .returning()
    return { row: row!, meeting, guestCookie, lobby, room: current }
  })

  if (outcome.guestCookie) {
    setGuestCookie(event, room.slug, outcome.guestCookie.token, { expiresAt: outcome.guestCookie.expiresAt, now })
  }
  if (outcome.lobby) {
    await notifyLobbyChanged(room.id, outcome.meeting?.id ?? null)
    return { status: 202, body: { status: 'waiting', requestId: outcome.row.id } }
  }
  return { status: 200, body: await buildJoinGrant(outcome.room, outcome.meeting!, outcome.row) }
}
