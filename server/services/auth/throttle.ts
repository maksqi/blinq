/**
 * Login backoff (auth, docs/API.md §1.2 limiter `login`) over the `login_throttle` table.
 *
 * Keys per attempt (`loginAttemptKeys`): the network (`ip:<v4>` or `net:<v6 /64>`), the network + account pair and the
 * account (`email:<address>`). 5 free failures per key, then `2^(n-5)` s, capped at 900 s; failures older than 24 h no
 * longer count; never a hard lockout (decision on the numbers, server-core `backoffDelayMs`). The account key only
 * slows networks that already failed for that account, so nobody can lock the owner out from elsewhere (F-017).
 * Unknown emails count exactly like known ones, so 429s reveal nothing.
 *
 * Every attempt is reserved before the password is checked (F-016): it counts as a failure up front, atomically, so
 * parallel guesses see each other. Then:
 * - wrong credentials: nothing more (the failure is already counted);
 * - right credentials: `succeeded(attempt, clear)` forgets the account keys and gives the attempt back on the network
 *   key (an attacker's network stays slowed down, a successful login never counts against a shared one);
 * - not decided (hashing busy, unexpected error) or refused after a right password (disabled, unverified):
 *   `release(attempt)` gives it back everywhere.
 *
 * - `createLoginThrottle(store)`: the policy over any `ThrottleStore`; `memoryThrottleStore()` for unit tests.
 * - `loginThrottle`: the shared instance over the database store (server-core's `reserveAttempt`, `refundAttempt`,
 *   `clearLoginFailures`).
 */
import type { H3Event } from 'h3'
import {
  backoffDelayMs,
  clearLoginFailures,
  emailThrottleKey,
  loginAttemptKeys,
  planAttempt,
  planRefund,
  refundAttempt,
  reserveAttempt,
  throwRateLimited,
  type AttemptDecision,
  type AttemptKey,
  type AttemptReservation,
  type ThrottleRow,
} from '../../utils/limiter'

export { backoffDelayMs, emailThrottleKey, loginAttemptKeys }
export type { AttemptKey, AttemptReservation }

export interface ThrottleStore {
  /** Without `now`, the store reads the clock once the attempt holds its keys. */
  reserve(keys: AttemptKey[], now?: Date): Promise<AttemptDecision>
  refund(reservation: AttemptReservation, keys?: string[]): Promise<void>
  clear(keys: string[]): Promise<void>
}

export interface LoginThrottle {
  /** Throws 429 `RATE_LIMITED` with `Retry-After` while a key waits; otherwise counts the attempt as a failure. */
  reserve(event: H3Event, keys: AttemptKey[], now?: Date): Promise<AttemptReservation>
  /** The credentials were right: forgets the `clear` keys and gives the attempt back on the others. */
  succeeded(attempt: AttemptReservation, clear: string[]): Promise<void>
  /** The attempt was not decided, or was refused after right credentials: gives it back on every key. */
  release(attempt: AttemptReservation): Promise<void>
  clear(keys: string[]): Promise<void>
}

export function createLoginThrottle(store: ThrottleStore): LoginThrottle {
  return {
    async reserve(event, keys, now) {
      const decision = await store.reserve(keys, now)
      if (!decision.allowed) throwRateLimited(event, decision.retryAfterMs)
      return decision.reservation
    },
    async succeeded(attempt, clear) {
      await store.clear(clear)
      const rest = attempt.keys.map((entry) => entry.key).filter((key) => !clear.includes(key))
      if (rest.length) await store.refund(attempt, rest)
    },
    release: (attempt) => store.refund(attempt),
    clear: (keys) => store.clear(keys),
  }
}

export const databaseThrottleStore: ThrottleStore = {
  reserve: (keys, now) => reserveAttempt(keys, now),
  refund: (reservation, keys) => refundAttempt(reservation, keys),
  clear: (keys) => clearLoginFailures(keys),
}

/**
 * Same rules as the database store, in memory (each call is atomic: no await between read and write). `peek` decides
 * without reserving, for assertions.
 */
export function memoryThrottleStore(): ThrottleStore & {
  rows: Map<string, ThrottleRow>
  peek(keys: AttemptKey[], now: Date): AttemptDecision
} {
  const rows = new Map<string, ThrottleRow>()
  const plan = (keys: AttemptKey[], now: Date) =>
    planAttempt(
      keys,
      keys.flatMap((spec) => rows.get(spec.key) ?? []),
      now,
    )
  return {
    rows,
    peek: plan,
    async reserve(keys, now) {
      const decision = plan(keys, now ?? new Date())
      if (decision.allowed) {
        for (const entry of decision.reservation.keys) {
          rows.set(entry.key, {
            key: entry.key,
            failures: entry.failures,
            nextAllowedAt: entry.nextAllowedAt,
            updatedAt: entry.updatedAt,
          })
        }
      }
      return decision
    },
    async refund(reservation, keys) {
      for (const reserved of reservation.keys) {
        if (keys && !keys.includes(reserved.key)) continue
        const row = rows.get(reserved.key)
        if (!row) continue
        const next = planRefund(row, reserved)
        if (next.failures === 0) rows.delete(reserved.key)
        else rows.set(reserved.key, { key: reserved.key, ...next })
      }
    },
    async clear(keys) {
      for (const key of keys) rows.delete(key)
    },
  }
}

export const loginThrottle = createLoginThrottle(databaseThrottleStore)
