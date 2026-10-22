import { createEvent, H3Error } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  backoffDelayMs,
  createLoginThrottle,
  emailThrottleKey,
  loginAttemptKeys,
  memoryThrottleStore,
  type AttemptKey,
} from './throttle'

const SECOND = 1_000
const T0 = new Date('2026-09-28T10:00:00Z')

function event() {
  const req = new IncomingMessage(new Socket())
  return createEvent(req, new ServerResponse(req))
}

function setup() {
  const store = memoryThrottleStore()
  return { store, throttle: createLoginThrottle(store) }
}

/** A wrong password: reserved, and nothing else (the failure stays counted). */
async function fail(throttle: ReturnType<typeof setup>['throttle'], keys: AttemptKey[], now = T0) {
  await throttle.reserve(event(), keys, now)
}

/** `count` wrong passwords 20 minutes apart (longer than any wait they start), the last one at `end`. */
async function failMany(throttle: ReturnType<typeof setup>['throttle'], keys: AttemptKey[], count: number, end = T0) {
  for (let i = count - 1; i >= 0; i--) await fail(throttle, keys, new Date(end.getTime() - i * 20 * 60 * SECOND))
}

async function refusal(promise: Promise<unknown>): Promise<H3Error> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(H3Error)
  return error as H3Error
}

describe('backoff curve', () => {
  it('allows 5 free failures, then doubles from 2 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffDelayMs)).toEqual([0, 0, 0, 0, 0, 0])
    expect(backoffDelayMs(6)).toBe(2 * SECOND)
    expect(backoffDelayMs(7)).toBe(4 * SECOND)
    expect(backoffDelayMs(8)).toBe(8 * SECOND)
    expect(backoffDelayMs(14)).toBe(512 * SECOND)
  })

  it('is capped at 900 s and never becomes a lockout', () => {
    expect(backoffDelayMs(15)).toBe(900 * SECOND)
    expect(backoffDelayMs(1_000)).toBe(900 * SECOND)
  })
})

describe('login attempt keys', () => {
  it('uses the network, the network + account pair and the account (conditional on the pair)', () => {
    expect(loginAttemptKeys(' Alice@Example.TEST ', '203.0.113.9')).toEqual([
      { key: 'ip:203.0.113.9' },
      { key: 'ip:203.0.113.9|email:alice@example.test' },
      { key: 'email:alice@example.test', onlyAfterFailuresOf: 'ip:203.0.113.9|email:alice@example.test' },
    ])
  })

  it('aggregates IPv6 clients by /64 (net: keys)', () => {
    const a = loginAttemptKeys('a@example.test', '2001:db8:1:2::5')
    const b = loginAttemptKeys('a@example.test', '2001:db8:1:2:ffff:1:2:3')
    expect(a[0]!.key).toBe('net:2001:db8:1:2::/64')
    expect(b).toEqual(a)
    expect(loginAttemptKeys('a@example.test', '2001:db8:1:3::5')[0]!.key).toBe('net:2001:db8:1:3::/64')
  })
})

describe('login throttle', () => {
  const keys = loginAttemptKeys('victim@example.test', '198.51.100.20')

  it('blocks after the free failures with a Retry-After, then lets the next attempt through', async () => {
    const { store, throttle } = setup()
    for (let i = 0; i < 6; i++) {
      expect(store.peek(keys, T0).allowed).toBe(true)
      await fail(throttle, keys) // the 6th failure starts a 2 s wait
    }
    expect(store.peek(keys, T0)).toEqual({ allowed: false, retryAfterMs: 2 * SECOND })
    expect(store.peek(keys, new Date(T0.getTime() + 2 * SECOND)).allowed).toBe(true)

    const e = event()
    const error = await refusal(throttle.reserve(e, keys, T0))
    expect(error.statusCode).toBe(429)
    expect(error.data).toEqual({ code: 'RATE_LIMITED', details: { retryAfter: 2 } })
    expect(e.node.res.getHeader('retry-after')).toBe(2)
    // A refused attempt is not counted.
    expect(store.rows.get(keys[0]!.key)?.failures).toBe(6)
  })

  it('counts parallel attempts before any password is checked: the 7th of 40 waits (F-016)', async () => {
    const { store, throttle } = setup()
    const results = await Promise.allSettled(Array.from({ length: 40 }, () => throttle.reserve(event(), keys, T0)))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6)
    for (const r of results.filter((r) => r.status === 'rejected')) {
      expect(((r as PromiseRejectedResult).reason as H3Error).statusCode).toBe(429)
    }
    expect(store.rows.get(keys[0]!.key)?.failures).toBe(6)
  })

  it('waits 2^(n-5) s after the n-th failure', async () => {
    const { store, throttle } = setup()
    await failMany(throttle, keys, 8)
    expect(store.peek(keys, T0)).toEqual({ allowed: false, retryAfterMs: 8 * SECOND })
  })

  it('never locks the account owner out from a network that has not failed for it (F-017)', async () => {
    const { store, throttle } = setup()
    const attackers = Array.from({ length: 12 }, (_, i) => loginAttemptKeys('victim@example.test', `203.0.113.${i + 1}`))
    for (const attacker of attackers) await fail(throttle, attacker)
    expect(store.rows.get(emailThrottleKey('victim@example.test'))?.failures).toBe(12)
    // The email key waits, but only for networks that already failed for the account.
    expect(store.peek(attackers[0]!, T0).allowed).toBe(false)
    const owner = loginAttemptKeys('victim@example.test', '198.51.100.77')
    expect(store.peek(owner, T0).allowed).toBe(true)
    // A wrong password from the owner's network counts; then that network waits too.
    await fail(throttle, owner)
    expect(store.peek(owner, T0).allowed).toBe(false)
  })

  it('counts unknown and known accounts alike', async () => {
    const { store, throttle } = setup()
    for (let i = 0; i < 6; i++) await fail(throttle, loginAttemptKeys('nobody@example.test', `198.51.100.${i + 1}`))
    expect(store.rows.get(emailThrottleKey('nobody@example.test'))?.failures).toBe(6)
    expect(store.peek(loginAttemptKeys('nobody@example.test', '198.51.100.1'), T0).allowed).toBe(false)
  })

  it('on success forgets the account keys and gives the attempt back on the network key', async () => {
    const { store, throttle } = setup()
    await failMany(throttle, keys, 7, new Date(T0.getTime() - 3_600_000))
    const network = keys[0]!.key
    const before = store.rows.get(network)!
    const later = new Date(T0.getTime() + 60 * SECOND)
    const attempt = await throttle.reserve(event(), keys, later)
    await throttle.succeeded(attempt, [keys[1]!.key, keys[2]!.key])
    expect(store.rows.has(emailThrottleKey('victim@example.test'))).toBe(false)
    expect(store.rows.has(keys[1]!.key)).toBe(false)
    // The network keeps its earlier failures, wait and age: a successful login never counts against it.
    expect(store.rows.get(network)).toEqual(before)
  })

  it('a success on a clean network leaves nothing behind, even from a shared address', async () => {
    const { store, throttle } = setup()
    for (let i = 0; i < 20; i++) {
      const own = loginAttemptKeys(`user-${i}@example.test`, '198.51.100.20')
      const attempt = await throttle.reserve(event(), own, T0)
      await throttle.succeeded(attempt, [own[1]!.key, own[2]!.key])
    }
    expect(store.rows.size).toBe(0)
  })

  it('release gives an undecided attempt back on every key', async () => {
    const { store, throttle } = setup()
    await failMany(throttle, keys, 5)
    const attempt = await throttle.reserve(event(), keys, T0) // the 6th: would start a wait
    expect(store.peek(keys, T0).allowed).toBe(false)
    await throttle.release(attempt)
    expect(store.peek(keys, T0).allowed).toBe(true)
    for (const spec of keys) expect(store.rows.get(spec.key)?.failures).toBe(5)
  })

  it('forgets failures older than 24 hours', async () => {
    const { store, throttle } = setup()
    await failMany(throttle, keys, 10)
    const later = new Date(T0.getTime() + 25 * 3_600_000)
    await fail(throttle, keys, later)
    expect(store.rows.get(keys[0]!.key)?.failures).toBe(1)
    expect(store.peek(keys, later).allowed).toBe(true)
  })
})
