/**
 * Pure join rules (rooms-backend, docs/API.md §6). `POST /api/join/:slug` applies them in this order, stopping at the
 * first failure:
 *   proof → (resume) → invite → guests allowed → lock → password → removed/denied in the live meeting → capacity →
 *   waiting room (also for participants on the network of a removed or denied row: `sharesNetwork`).
 * Hosts and co-hosts skip the invite, the lock, the password (decision) and the waiting room. Capacity applies to
 * everyone. `inviteCheck`, `guestCheck`, `lockCheck`, `finalStatusCheck`, `capacityCheck` and `lobbyCapacityCheck`
 * return the error code or null; `passwordNeeded`, `lobbyNeeded` and `sharesNetwork` decide whether a step applies.
 */
import type { ParticipantRole } from '#shared/schemas/livekit'
import { limiterKeysForIp, normalizeIp } from '../../utils/client-ip'
import type { InviteState } from '../invites/policy'

export const LOBBY_MAX_WAITING = 50

export function isModerator(role: ParticipantRole): boolean {
  return role === 'host' || role === 'cohost'
}

export function inviteCheck(
  role: ParticipantRole,
  inviteToken: string | undefined,
  state: InviteState | null,
): 'ROOM_INVITE_REQUIRED' | 'ROOM_INVITE_INVALID' | null {
  if (isModerator(role)) return null
  if (!inviteToken) return 'ROOM_INVITE_REQUIRED'
  return state === 'valid' ? null : 'ROOM_INVITE_INVALID'
}

export function guestCheck(
  isGuest: boolean,
  policy: { serverAllowsGuests: boolean; roomAllowsGuests: boolean },
): 'ROOM_GUESTS_NOT_ALLOWED' | null {
  if (!isGuest) return null
  return policy.serverAllowsGuests && policy.roomAllowsGuests ? null : 'ROOM_GUESTS_NOT_ALLOWED'
}

export function lockCheck(role: ParticipantRole, locked: boolean): 'ROOM_LOCKED' | null {
  return locked && !isModerator(role) ? 'ROOM_LOCKED' : null
}

export function passwordNeeded(role: ParticipantRole, hasPassword: boolean): boolean {
  return hasPassword && !isModerator(role)
}

/** `removed` wins over `denied`: both are final for the meeting. */
export function finalStatusCheck(statuses: readonly string[]): 'JOIN_REMOVED' | 'JOIN_DENIED' | null {
  if (statuses.includes('removed')) return 'JOIN_REMOVED'
  if (statuses.includes('denied')) return 'JOIN_DENIED'
  return null
}

export function capacityCheck(activeParticipants: number, maxParticipants: number): 'ROOM_FULL' | null {
  return activeParticipants >= maxParticipants ? 'ROOM_FULL' : null
}

export function lobbyNeeded(role: ParticipantRole, waitingRoom: boolean): boolean {
  return waitingRoom && !isModerator(role)
}

export function lobbyCapacityCheck(waiting: number): 'LOBBY_FULL' | null {
  return waiting >= LOBBY_MAX_WAITING ? 'LOBBY_FULL' : null
}

/**
 * Whether `ip` is on the network of one of `refused` (the IPs of removed or denied rows of the live meeting): the
 * same IPv4 address or the same IPv6 /64, like the limiters. A participant who matches goes through the waiting room
 * even when the room has none (F-018). An unknown IP matches nothing.
 */
export function sharesNetwork(ip: string | null, refused: readonly string[]): boolean {
  const net = normalizeIp(ip) ? limiterKeysForIp(ip).net : null
  return net !== null && refused.some((other) => normalizeIp(other) !== null && limiterKeysForIp(other).net === net)
}

/**
 * Allowances of a new participant row: moderators may publish everything; participants may use the camera, and the
 * microphone only while the room allows self-unmute (a moderator can "give voice" later).
 */
export function initialAllowances(role: ParticipantRole, room: { allowSelfUnmute: boolean }) {
  return { micAllowed: isModerator(role) || room.allowSelfUnmute, cameraAllowed: true }
}
