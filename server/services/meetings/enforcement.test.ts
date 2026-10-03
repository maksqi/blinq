import { describe, expect, it } from 'vitest'
import { RESUME_GRACE_MS } from '../join/resume'
import { joinVerdict } from './enforcement'

const NOW = new Date('2026-10-03T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const context = { roomId: 'room-1', roomDeleted: false, liveMeetingId: 'meeting-1', now: NOW }
const row = (overrides: Partial<Parameters<typeof joinVerdict>[0] & object> = {}) => ({
  roomId: 'room-1',
  meetingId: 'meeting-1',
  status: 'admitted' as const,
  joinedAt: null as Date | null,
  leftAt: null as Date | null,
  ...overrides,
})

describe('joinVerdict', () => {
  it('accepts admitted and joined rows of the live meeting', () => {
    expect(joinVerdict(row(), context)).toEqual({ accept: true, reconnect: false })
    expect(joinVerdict(row({ status: 'joined', joinedAt: ago(5_000) }), context)).toEqual({ accept: true, reconnect: false })
  })

  it('takes back a row whose own connection left within the grace period: a full LiveKit reconnect (F-039)', () => {
    const left = row({ status: 'left', joinedAt: ago(60_000), leftAt: ago(2_000) })
    expect(joinVerdict(left, context)).toEqual({ accept: true, reconnect: true })
    expect(joinVerdict({ ...left, leftAt: ago(RESUME_GRACE_MS) }, context).accept).toBe(true)
    expect(joinVerdict({ ...left, leftAt: ago(RESUME_GRACE_MS + 1) }, context)).toEqual({ accept: false, reason: 'status left' })
    // Never connected (a closed request), or closed by a revocation (joinedAt cleared): removed.
    expect(joinVerdict({ ...left, joinedAt: null }, context)).toEqual({ accept: false, reason: 'status left' })
    expect(joinVerdict({ ...left, leftAt: null }, context).accept).toBe(false)
  })

  it('removes everything else', () => {
    expect(joinVerdict(undefined, context)).toEqual({ accept: false, reason: 'unknown identity' })
    expect(joinVerdict(row({ roomId: 'room-2' }), context)).toEqual({ accept: false, reason: 'other room' })
    expect(joinVerdict(row(), { ...context, roomDeleted: true })).toEqual({ accept: false, reason: 'room deleted' })
    expect(joinVerdict(row({ meetingId: 'meeting-0' }), context)).toEqual({ accept: false, reason: 'not in the live meeting' })
    expect(joinVerdict(row(), { ...context, liveMeetingId: null })).toEqual({ accept: false, reason: 'not in the live meeting' })
    for (const status of ['removed', 'denied', 'waiting'] as const) {
      expect(joinVerdict(row({ status, joinedAt: ago(10_000), leftAt: ago(1_000) }), context)).toEqual({
        accept: false,
        reason: `status ${status}`,
      })
    }
  })
})
