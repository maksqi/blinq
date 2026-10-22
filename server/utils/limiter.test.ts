import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent, H3Error } from 'h3'
import { describe, expect, it } from 'vitest'
import {
  backoffDelayMs,
  consumeOr429,
  createConcurrencyLimit,
  createLimiter,
  emailThrottleKey,
  getLimiter,
  LOGIN_FAILURE_WINDOW_MS,
  loginAttemptKeys,
  nextFailureCount,
  planAttempt,
  planRefund,
  RATE_LIMITS,
  retryAfterSeconds,
  roomPasswordThrottleKey,
  type ThrottleRow,
} from './limiter'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

function event() {
  const req = new IncomingMessage(new Socket())
  return createEvent(req, new ServerResponse(req))
}

describe('createLimiter (sliding window)', () => {
  it('allows `limit` hits per window and reports the wait', () => {
    const c = clock()
    const limiter = createLimiter({ name: 't', limit: 3, windowMs: 60_000, now: c.now })
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 })
    c.advance(10_000)
    limiter.consume('a')
    c.advance(10_000)
    expect(limiter.consume('a')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 })
    expect(limiter.consume('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 40_000 })
    // Other keys are independent.
    expect(limiter.consume('b').allowed).toBe(true)
  })

  it('slides: old hits leave the window one by one', () => {
    const c = clock()
    const limiter = createLimiter({ name: 't', limit: 2, windowMs: 1_000, now: c.now })
    limiter.consume('k')
    c.advance(400)
    limiter.consume('k')
    expect(limiter.consume('k').allowed).toBe(false)
    c.advance(600) // the first hit is exactly one window old
    expect(limiter.consume('k').allowed).toBe(true)
    expect(limiter.consume('k')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 400 })
  })

  it('does not count rejected attempts', () => {
    const c = clock()
    const limiter = createLimiter({ name: 't', limit: 1, windowMs: 1_000, now: c.now })
    limiter.consume('k')
    for (let i = 0; i < 5; i++) limiter.consume('k')
    c.advance(1_000)
    expect(limiter.consume('k').allowed).toBe(true)
  })

  it('peeks without consuming, resets and forgets idle keys', () => {
    const c = clock()
    const limiter = createLimiter({ name: 't', limit: 1, windowMs: 1_000, now: c.now })
    expect(limiter.peek('k').allowed).toBe(true)
    limiter.consume('k')
    expect(limiter.peek('k').allowed).toBe(false)
    limiter.reset('k')
    expect(limiter.peek('k').allowed).toBe(true)
    limiter.consume('x')
    limiter.consume('y')
    c.advance(5_000)
    limiter.consume('z')
    expect(limiter.size).toBe(1)
  })

  it('caps the number of tracked keys', () => {
    const c = clock()
    const limiter = createLimiter({ name: 't', limit: 5, windowMs: 60_000, now: c.now, maxKeys: 10 })
    for (let i = 0; i < 30; i++) limiter.consume(`k${i}`)
    expect(limiter.size).toBeLessThanOrEqual(11)
  })

  it('rejects invalid options', () => {
    expect(() => createLimiter({ name: 'x', limit: 0, windowMs: 1 })).toThrow(RangeError)
    expect(() => createLimiter({ name: 'x', limit: 1, windowMs: 0 })).toThrow(RangeError)
  })
})

describe('shared limiters', () => {
  it('match docs/API.md and are singletons', () => {
    expect(RATE_LIMITS['auth-ip']).toEqual({ limit: 10, windowMs: 60_000 })
    expect(RATE_LIMITS['reset-email']).toEqual({ limit: 3, windowMs: 3_600_000 })
    expect(RATE_LIMITS['join-ip']).toEqual({ limit: 30, windowMs: 60_000 })
    expect(RATE_LIMITS['room-create']).toEqual({ limit: 20, windowMs: 3_600_000 })
    expect(RATE_LIMITS['call-actions']).toEqual({ limit: 120, windowMs: 60_000 })
    expect(RATE_LIMITS['recording-chunks']).toEqual({ limit: 8, windowMs: 1_000 })
    expect(getLimiter('join-ip')).toBe(getLimiter('join-ip'))
    expect(getLimiter('join-ip').limit).toBe(30)
  })
})

describe('consumeOr429', () => {
  it('throws RATE_LIMITED with Retry-After once the limit is reached', () => {
    const c = clock()
    const limiter = createLimiter({ name: 't', limit: 1, windowMs: 90_500, now: c.now })
    const e = event()
    consumeOr429(e, limiter, 'k')
    let thrown: unknown
    try {
      consumeOr429(e, limiter, 'k')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(H3Error)
    const error = thrown as H3Error<{ code: string; details: { retryAfter: number } }>
    expect(error.statusCode).toBe(429)
    expect(error.data?.code).toBe('RATE_LIMITED')
    expect(error.data?.details.retryAfter).toBe(91)
    expect(String(e.node.res.getHeader('retry-after'))).toBe('91')
  })

  it('rounds Retry-After up to whole seconds, at least 1', () => {
    expect(retryAfterSeconds(1)).toBe(1)
    expect(retryAfterSeconds(1_000)).toBe(1)
    expect(retryAfterSeconds(1_001)).toBe(2)
    expect(retryAfterSeconds(0)).toBe(1)
  })
})

describe('backoff', () => {
  it('gives 5 free failures, then 2^(n-5) seconds capped at 900 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([0, 0, 0, 0, 0, 0])
    expect(backoffDelayMs(6)).toBe(2_000)
    expect(backoffDelayMs(7)).toBe(4_000)
    expect(backoffDelayMs(10)).toBe(32_000)
    expect(backoffDelayMs(14)).toBe(512_000)
    expect(backoffDelayMs(15)).toBe(900_000)
    expect(backoffDelayMs(1_000)).toBe(900_000)
  })

  it('decides over all keys of an attempt: the longest running wait wins', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const row = (key: string, waitMs: number | null, failures = 6): ThrottleRow => ({
      key,
      failures,
      nextAllowedAt: waitMs === null ? null : new Date(now.getTime() + waitMs),
      updatedAt: now,
    })
    expect(planAttempt([], [], now)).toEqual({ allowed: true, reservation: { keys: [] } })
    expect(planAttempt([{ key: 'a' }, { key: 'b' }], [row('a', null), row('b', -1)], now).allowed).toBe(true)
    expect(planAttempt([{ key: 'a' }, { key: 'b' }], [row('a', 2_000), row('b', 8_000)], now)).toEqual({
      allowed: false,
      retryAfterMs: 8_000,
    })
  })

  it('reserves an allowed attempt as one more failure on every key, with the wait it starts', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const earlier = new Date(now.getTime() - 60_000)
    const plan = planAttempt(
      [{ key: 'a' }, { key: 'b' }],
      [{ key: 'a', failures: 5, nextAllowedAt: null, updatedAt: earlier }],
      now,
    )
    expect(plan).toEqual({
      allowed: true,
      reservation: {
        keys: [
          {
            key: 'a',
            failures: 6,
            nextAllowedAt: new Date(now.getTime() + 2_000),
            updatedAt: now,
            previousNextAllowedAt: null,
            previousUpdatedAt: earlier,
          },
          { key: 'b', failures: 1, nextAllowedAt: null, updatedAt: now, previousNextAllowedAt: null, previousUpdatedAt: null },
        ],
      },
    })
  })

  it('applies a conditional key only while its guard key has live failures (F-017)', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const keys = [{ key: 'pair' }, { key: 'account', onlyAfterFailuresOf: 'pair' }]
    const account: ThrottleRow = { key: 'account', failures: 30, nextAllowedAt: new Date(now.getTime() + 600_000), updatedAt: now }
    const clean = planAttempt(keys, [account], now)
    expect(clean.allowed).toBe(true)
    // The bypassed key still counts the failure and keeps (never shortens) its running wait.
    const reserved = clean.allowed ? clean.reservation.keys.find((entry) => entry.key === 'account') : undefined
    expect(reserved?.failures).toBe(31)
    expect(reserved?.nextAllowedAt).toEqual(new Date(now.getTime() + 900_000))
    const dirty: ThrottleRow = { key: 'pair', failures: 1, nextAllowedAt: null, updatedAt: now }
    expect(planAttempt(keys, [account, dirty], now)).toEqual({ allowed: false, retryAfterMs: 600_000 })
    // Guard failures older than 24 h do not count.
    const stale: ThrottleRow = { ...dirty, updatedAt: new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS - 1) }
    expect(planAttempt(keys, [account, stale], now).allowed).toBe(true)
    // Listed both ways, a key is unconditional.
    expect(planAttempt([...keys, { key: 'account' }], [account], now).allowed).toBe(false)
  })

  it('refunds one reserved attempt and undoes its wait unless a later attempt replaced it', () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const earlier = new Date(now.getTime() - 60_000)
    const reserved = {
      key: 'a',
      failures: 6,
      nextAllowedAt: new Date(now.getTime() + 2_000),
      updatedAt: now,
      previousNextAllowedAt: null,
      previousUpdatedAt: earlier,
    }
    expect(planRefund({ failures: 6, nextAllowedAt: reserved.nextAllowedAt, updatedAt: now }, reserved)).toEqual({
      failures: 5,
      nextAllowedAt: null,
      updatedAt: earlier,
    })
    const later = new Date(now.getTime() + 500)
    const replaced = { failures: 7, nextAllowedAt: new Date(now.getTime() + 4_500), updatedAt: later }
    expect(planRefund(replaced, reserved)).toEqual({ failures: 6, nextAllowedAt: replaced.nextAllowedAt, updatedAt: later })
    expect(planRefund({ failures: 0, nextAllowedAt: null, updatedAt: now }, reserved).failures).toBe(0)
  })

  it('forgets failures older than 24 hours', () => {
    const now = new Date('2026-01-02T00:00:00Z')
    expect(nextFailureCount(undefined, now)).toBe(1)
    expect(nextFailureCount({ failures: 7, updatedAt: new Date('2026-01-01T12:00:00Z') }, now)).toBe(8)
    expect(nextFailureCount({ failures: 7, updatedAt: new Date('2025-12-31T23:59:59Z') }, now)).toBe(1)
  })

  it('builds throttle keys per email and IP (/64 for IPv6)', () => {
    expect(emailThrottleKey('  Admin@Example.TEST ')).toBe('email:admin@example.test')
    expect(loginAttemptKeys('a@example.test', '203.0.113.9').map((spec) => spec.key)).toEqual([
      'ip:203.0.113.9',
      'ip:203.0.113.9|email:a@example.test',
      'email:a@example.test',
    ])
    expect(loginAttemptKeys('a@example.test', '2001:db8:5:6::77')[1]).toEqual({ key: 'net:2001:db8:5:6::/64|email:a@example.test' })
    expect(roomPasswordThrottleKey('r1', '203.0.113.9')).toBe('room:r1:ip:203.0.113.9')
  })
})

describe('createConcurrencyLimit', () => {
  it('caps running tasks per key and frees a slot once per release', () => {
    const limit = createConcurrencyLimit(2)
    const a = limit.tryAcquire('k')
    const b = limit.tryAcquire('k')
    expect(a && b).toBeTruthy()
    expect(limit.tryAcquire('k')).toBeNull()
    expect(limit.tryAcquire('other')).not.toBeNull()
    a!()
    a!() // idempotent
    expect(limit.active('k')).toBe(1)
    expect(limit.tryAcquire('k')).not.toBeNull()
    expect(() => createConcurrencyLimit(0)).toThrow(RangeError)
  })
})
