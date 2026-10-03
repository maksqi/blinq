import { describe, expect, it } from 'vitest'
import {
  capacityCheck,
  finalStatusCheck,
  guestCheck,
  initialAllowances,
  inviteCheck,
  isModerator,
  LOBBY_MAX_WAITING,
  lobbyCapacityCheck,
  lobbyNeeded,
  lockCheck,
  passwordNeeded,
  sharesNetwork,
} from './checks'

describe('join checks', () => {
  it('requires a valid invite from everyone except hosts and co-hosts (signed-in users too)', () => {
    expect(inviteCheck('host', undefined, null)).toBeNull()
    expect(inviteCheck('cohost', undefined, null)).toBeNull()
    expect(inviteCheck('participant', undefined, null)).toBe('ROOM_INVITE_REQUIRED')
    expect(inviteCheck('participant', 'token', null)).toBe('ROOM_INVITE_INVALID')
    for (const state of ['revoked', 'expired', 'exhausted'] as const) {
      expect(inviteCheck('participant', 'token', state)).toBe('ROOM_INVITE_INVALID')
    }
    expect(inviteCheck('participant', 'token', 'valid')).toBeNull()
  })

  it('lets guests in only when the server and the room allow them', () => {
    expect(guestCheck(false, { serverAllowsGuests: false, roomAllowsGuests: false })).toBeNull()
    expect(guestCheck(true, { serverAllowsGuests: true, roomAllowsGuests: true })).toBeNull()
    expect(guestCheck(true, { serverAllowsGuests: false, roomAllowsGuests: true })).toBe('ROOM_GUESTS_NOT_ALLOWED')
    expect(guestCheck(true, { serverAllowsGuests: true, roomAllowsGuests: false })).toBe('ROOM_GUESTS_NOT_ALLOWED')
  })

  it('lets hosts and co-hosts bypass the lock, the password and the waiting room', () => {
    expect(isModerator('host') && isModerator('cohost') && !isModerator('participant')).toBe(true)
    expect(lockCheck('participant', true)).toBe('ROOM_LOCKED')
    expect(lockCheck('participant', false)).toBeNull()
    expect(lockCheck('cohost', true)).toBeNull()
    expect(passwordNeeded('participant', true)).toBe(true)
    expect(passwordNeeded('participant', false)).toBe(false)
    expect(passwordNeeded('host', true)).toBe(false)
    expect(lobbyNeeded('participant', true)).toBe(true)
    expect(lobbyNeeded('participant', false)).toBe(false)
    expect(lobbyNeeded('cohost', true)).toBe(false)
  })

  it('treats removed and denied as final, removed first', () => {
    expect(finalStatusCheck([])).toBeNull()
    expect(finalStatusCheck(['left', 'joined'])).toBeNull()
    expect(finalStatusCheck(['denied'])).toBe('JOIN_DENIED')
    expect(finalStatusCheck(['denied', 'removed'])).toBe('JOIN_REMOVED')
  })

  it('enforces capacity and the lobby cap', () => {
    expect(capacityCheck(24, 25)).toBeNull()
    expect(capacityCheck(25, 25)).toBe('ROOM_FULL')
    expect(capacityCheck(3, 2)).toBe('ROOM_FULL')
    expect(LOBBY_MAX_WAITING).toBe(50)
    expect(lobbyCapacityCheck(49)).toBeNull()
    expect(lobbyCapacityCheck(50)).toBe('LOBBY_FULL')
  })

  it('matches the network of removed or denied rows: same IPv4, same IPv6 /64, never an unknown IP (F-018)', () => {
    expect(sharesNetwork('203.0.113.7', ['198.51.100.1', '203.0.113.7'])).toBe(true)
    expect(sharesNetwork('203.0.113.8', ['203.0.113.7'])).toBe(false)
    expect(sharesNetwork('2001:db8:1:2::beef', ['2001:db8:1:2::1'])).toBe(true)
    expect(sharesNetwork('2001:db8:1:3::1', ['2001:db8:1:2::1'])).toBe(false)
    expect(sharesNetwork('::ffff:203.0.113.7', ['203.0.113.7'])).toBe(true)
    expect(sharesNetwork(null, ['203.0.113.7'])).toBe(false)
    expect(sharesNetwork('203.0.113.7', [])).toBe(false)
    expect(sharesNetwork('203.0.113.7', ['not-an-ip'])).toBe(false)
    expect(sharesNetwork('not-an-ip', ['not-an-ip'])).toBe(false)
  })

  it('starts participants without a microphone when self-unmute is off', () => {
    expect(initialAllowances('participant', { allowSelfUnmute: true })).toEqual({ micAllowed: true, cameraAllowed: true })
    expect(initialAllowances('participant', { allowSelfUnmute: false })).toEqual({ micAllowed: false, cameraAllowed: true })
    expect(initialAllowances('cohost', { allowSelfUnmute: false })).toEqual({ micAllowed: true, cameraAllowed: true })
  })
})
