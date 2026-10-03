/**
 * Rate limiting and brute-force backoff (server-core, docs/API.md §1.2, docs/SECURITY.md §4).
 *
 * In-memory sliding-window limiters (single node; swap the store for multi-node later):
 * - `createLimiter({ name, limit, windowMs })` → `limiter.consume(key)` → `{ allowed, remaining, retryAfterMs }`.
 * - `getLimiter(name)`: the shared instance of a documented limiter (`RATE_LIMITS`: auth-ip, reset-email, join-ip,
 *   room-create, call-actions, recording-chunks). Use it instead of creating duplicates.
 * - `consumeOr429(event, limiterOrName, key)`: throws 429 `RATE_LIMITED` with `Retry-After` (seconds).
 * - `throwRateLimited(event, retryAfterMs)`: the same error for custom checks (e.g. the login backoff).
 *
 * Keys: per-IP limits use `limiterKeysForIp(getClientIp(event)).net` (IPv6 /64); users `userLimiterKey(id)`;
 * participants `participant:<rowId>`; recordings `recording:<id>`; emails `emailThrottleKey(email)`.
 *
 * Concurrency caps: `createConcurrencyLimit(max)` → `tryAcquire(key)` returns a release function or null (in-flight
 * attempts per IP, for example).
 *
 * Exponential backoff in table `login_throttle` (never a hard lockout):
 * - `backoffDelayMs(failures)`: 5 free failures, then `2^(n-5)` s, capped at 900 s.
 * - `reserveAttempt(keys)`: atomically refuses an attempt while a key waits, or counts it as a failure up front
 *   (F-016: parallel attempts see each other). The caller then `refundAttempt`s keys when the credentials were right,
 *   or `clearLoginFailures`s them; a wrong password needs nothing more.
 * - Keys: `loginAttemptKeys(email, ip)` (network, network + account, and the account key, which only applies to
 *   networks that already failed for it: F-017); room passwords `roomPasswordThrottleKey(roomId, ip)`.
 *   `clearAccountThrottle(email)` forgets an account's keys (password resets).
 * - Failures older than 24 h no longer count (decision); `maintenance:cleanup` deletes those rows.
 */
import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import { setResponseHeader, type H3Event } from 'h3'
import { useDb } from '../database/client'
import { loginThrottle } from '../database/schema'
import { apiError } from './api-error'
import { limiterKeysForIp } from './client-ip'

// ---- In-memory sliding window ---------------------------------------------------------------------------------------

export interface LimiterOptions {
  name: string
  limit: number
  windowMs: number
  /** Injectable clock (ms), for tests. */
  now?: () => number
  /** Soft cap on tracked keys; the oldest keys are dropped beyond it. */
  maxKeys?: number
}

export interface LimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export interface Limiter {
  readonly name: string
  readonly limit: number
  readonly windowMs: number
  consume(key: string): LimitResult
  peek(key: string): LimitResult
  reset(key?: string): void
  readonly size: number
}

export function createLimiter(options: LimiterOptions): Limiter {
  const { name, limit, windowMs, now = Date.now, maxKeys = 50_000 } = options
  if (!Number.isInteger(limit) || limit < 1 || !(windowMs > 0)) throw new RangeError(`Invalid limiter ${name}`)
  const hits = new Map<string, number[]>()
  let lastSweep = now()

  const live = (key: string, at: number) => {
    const list = hits.get(key)
    if (!list) return undefined
    while (list.length && list[0]! <= at - windowMs) list.shift()
    if (!list.length) hits.delete(key)
    return list.length ? list : undefined
  }

  const sweep = (at: number) => {
    lastSweep = at
    for (const key of [...hits.keys()]) live(key, at)
    for (const key of hits.keys()) {
      if (hits.size <= maxKeys) break
      hits.delete(key)
    }
  }

  const result = (list: number[] | undefined, at: number): LimitResult => {
    const count = list?.length ?? 0
    if (count < limit) return { allowed: true, remaining: limit - count, retryAfterMs: 0 }
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, list![0]! + windowMs - at) }
  }

  return {
    name,
    limit,
    windowMs,
    consume(key) {
      const at = now()
      if (at - lastSweep > windowMs || hits.size > maxKeys) sweep(at)
      const list = live(key, at)
      const before = result(list, at)
      if (!before.allowed) return before
      if (list) list.push(at)
      else hits.set(key, [at])
      return { allowed: true, remaining: before.remaining - 1, retryAfterMs: 0 }
    },
    peek(key) {
      const at = now()
      return result(live(key, at), at)
    },
    reset(key) {
      if (key === undefined) hits.clear()
      else hits.delete(key)
    },
    get size() {
      return hits.size
    },
  }
}

/** Documented limits (docs/API.md §1.2). */
export const RATE_LIMITS = {
  'auth-ip': { limit: 10, windowMs: 60_000 },
  'reset-email': { limit: 3, windowMs: 3_600_000 },
  'join-ip': { limit: 30, windowMs: 60_000 },
  'room-create': { limit: 20, windowMs: 3_600_000 },
  'call-actions': { limit: 120, windowMs: 60_000 },
  'recording-chunks': { limit: 8, windowMs: 1_000 },
} as const satisfies Record<string, { limit: number; windowMs: number }>

export type LimiterName = keyof typeof RATE_LIMITS

const sharedLimiters = new Map<LimiterName, Limiter>()

export function getLimiter(name: LimiterName): Limiter {
  let limiter = sharedLimiters.get(name)
  if (!limiter) {
    limiter = createLimiter({ name, ...RATE_LIMITS[name] })
    sharedLimiters.set(name, limiter)
  }
  return limiter
}

export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

export function throwRateLimited(event: H3Event, retryAfterMs: number): never {
  const seconds = retryAfterSeconds(retryAfterMs)
  setResponseHeader(event, 'Retry-After', seconds)
  throw apiError('RATE_LIMITED', 429, { retryAfter: seconds })
}

export function consumeOr429(event: H3Event, limiter: Limiter | LimiterName, key: string): void {
  const instance = typeof limiter === 'string' ? getLimiter(limiter) : limiter
  const outcome = instance.consume(key)
  if (!outcome.allowed) throwRateLimited(event, outcome.retryAfterMs)
}

export function userLimiterKey(userId: string): string {
  return `user:${userId}`
}

// ---- Concurrency caps -----------------------------------------------------------------------------------------------

export interface ConcurrencyLimit {
  readonly max: number
  /** A release function (idempotent), or null while `key` already runs `max` tasks. */
  tryAcquire(key: string): (() => void) | null
  active(key: string): number
}

export function createConcurrencyLimit(max: number): ConcurrencyLimit {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('Concurrency limit must be a positive integer')
  const running = new Map<string, number>()
  return {
    max,
    tryAcquire(key) {
      const current = running.get(key) ?? 0
      if (current >= max) return null
      running.set(key, current + 1)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (running.get(key) ?? 1) - 1
        if (left > 0) running.set(key, left)
        else running.delete(key)
      }
    },
    active: (key) => running.get(key) ?? 0,
  }
}

// ---- Exponential backoff (login, room passwords, password changes) --------------------------------------------------

export const BACKOFF_FREE_FAILURES = 5
export const BACKOFF_MAX_MS = 900_000
export const LOGIN_FAILURE_WINDOW_MS = 24 * 3_600_000

/** Wait required after `failures` consecutive failures: 0 for the first 5, then 2^(n-5) s, at most 900 s. */
export function backoffDelayMs(failures: number): number {
  if (failures <= BACKOFF_FREE_FAILURES) return 0
  return Math.min(BACKOFF_MAX_MS, 2 ** (failures - BACKOFF_FREE_FAILURES) * 1000)
}

/** Pure: the failure count after one more failure (older failures expire after 24 h). */
export function nextFailureCount(row: { failures: number; updatedAt: Date } | undefined, now: Date): number {
  if (!row || now.getTime() - row.updatedAt.getTime() > LOGIN_FAILURE_WINDOW_MS) return 1
  return row.failures + 1
}

/** One key of an attempt. */
export interface AttemptKey {
  key: string
  /**
   * Makes this key's wait conditional: it applies only while the key named here already has failures in the window.
   * The account-wide email key uses it, so strangers driving it up never lock out a network that has not failed for
   * that account (F-017, docs/SECURITY.md §4: no lockout).
   */
  onlyAfterFailuresOf?: string
}

export interface ThrottleRow {
  key: string
  failures: number
  nextAllowedAt: Date | null
  updatedAt: Date
}

/** One reserved key: what the attempt wrote and what it replaced (so a refund can undo it). */
export interface ReservedKey {
  key: string
  failures: number
  nextAllowedAt: Date | null
  updatedAt: Date
  previousNextAllowedAt: Date | null
  previousUpdatedAt: Date | null
}

export interface AttemptReservation {
  keys: ReservedKey[]
}

export type AttemptDecision =
  | { allowed: false; retryAfterMs: number }
  | { allowed: true; reservation: AttemptReservation }

function liveFailures(row: ThrottleRow | undefined, now: Date): number {
  return row && now.getTime() - row.updatedAt.getTime() <= LOGIN_FAILURE_WINDOW_MS ? row.failures : 0
}

/** Pure: one entry per key; a key listed both conditionally and unconditionally is unconditional. */
export function normalizeAttemptKeys(keys: AttemptKey[]): AttemptKey[] {
  const byKey = new Map<string, AttemptKey>()
  for (const spec of keys) {
    const seen = byKey.get(spec.key)
    if (!seen || (seen.onlyAfterFailuresOf && !spec.onlyAfterFailuresOf)) byKey.set(spec.key, spec)
  }
  return [...byKey.values()]
}

/**
 * Pure: decides an attempt over the stored rows of its keys. A running wait on any key → `{ allowed: false }`.
 * Otherwise the attempt is reserved: it already counts as one more failure on every key (with the wait that failure
 * starts), before the password is even checked. The caller refunds it when the credentials turn out right.
 */
export function planAttempt(keys: AttemptKey[], rows: ThrottleRow[], now: Date): AttemptDecision {
  const specs = normalizeAttemptKeys(keys)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  let wait = 0
  for (const spec of specs) {
    const until = byKey.get(spec.key)?.nextAllowedAt
    const remaining = until ? until.getTime() - now.getTime() : 0
    if (remaining <= 0) continue
    if (spec.onlyAfterFailuresOf && liveFailures(byKey.get(spec.onlyAfterFailuresOf), now) === 0) continue
    wait = Math.max(wait, remaining)
  }
  if (wait > 0) return { allowed: false, retryAfterMs: wait }
  return {
    allowed: true,
    reservation: {
      keys: specs.map((spec) => {
        const row = byKey.get(spec.key)
        const failures = nextFailureCount(row, now)
        const delay = backoffDelayMs(failures)
        const previous = row?.nextAllowedAt ?? null
        // A new wait never shortens a longer one that is already running.
        const next = delay > 0 ? new Date(Math.max(now.getTime() + delay, previous?.getTime() ?? 0)) : previous
        return {
          key: spec.key,
          failures,
          nextAllowedAt: next,
          updatedAt: now,
          previousNextAllowedAt: previous,
          previousUpdatedAt: row?.updatedAt ?? null,
        }
      }),
    },
  }
}

const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null)

/**
 * Pure: a row after giving one reserved attempt back. The wait and timestamp the attempt wrote are undone unless a
 * later attempt replaced them, so successful logins neither start waits nor keep old failures alive.
 */
export function planRefund(
  row: Pick<ThrottleRow, 'failures' | 'nextAllowedAt' | 'updatedAt'>,
  reserved: ReservedKey,
): Pick<ThrottleRow, 'failures' | 'nextAllowedAt' | 'updatedAt'> {
  return {
    failures: Math.max(0, row.failures - 1),
    nextAllowedAt: sameTime(row.nextAllowedAt, reserved.nextAllowedAt) ? reserved.previousNextAllowedAt : row.nextAllowedAt,
    updatedAt:
      reserved.previousUpdatedAt && sameTime(row.updatedAt, reserved.updatedAt) ? reserved.previousUpdatedAt : row.updatedAt,
  }
}

export function emailThrottleKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`
}

/**
 * Keys of a password login (decision, F-016/F-017):
 * - the network (`ip:<v4>` / `net:<v6 /64>`): always applies, also across emails (spraying);
 * - the network + account pair (`<network>|email:<address>`; it starts like an IP key, so IP retention deletes it);
 * - the account (`email:<address>`): applies only to networks whose pair key already has failures. A distributed
 *   guesser gets one try per network once the account backs off; the owner on a clean network is never locked out.
 */
export function loginAttemptKeys(email: string, ip: string | null): AttemptKey[] {
  const net = limiterKeysForIp(ip).net
  const account = emailThrottleKey(email)
  const pair = `${net}|${account}`
  return [{ key: net }, { key: pair }, { key: account, onlyAfterFailuresOf: pair }]
}

export function roomPasswordThrottleKey(roomId: string, ip: string | null): string {
  return `room:${roomId}:${limiterKeysForIp(ip).net}`
}

const lockThrottleKey = (key: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`blinq:throttle:${key}`}, 0))`

/**
 * Atomically decides and reserves an attempt (`planAttempt`) in `login_throttle`. Per-key advisory locks (also for
 * rows that do not exist yet), taken in sorted order, make parallel attempts on a key run one after another: the 7th of
 * 40 parallel wrong passwords already sees six reserved failures and waits. Without an explicit `now`, the clock is
 * read once the locks are held, so time spent waiting for them never inflates `Retry-After`.
 */
export async function reserveAttempt(keys: AttemptKey[], now?: Date): Promise<AttemptDecision> {
  const specs = normalizeAttemptKeys(keys)
  if (!specs.length) return { allowed: true, reservation: { keys: [] } }
  const names = specs.map((spec) => spec.key)
  return useDb().transaction(async (tx) => {
    for (const key of [...names].sort()) await tx.execute(lockThrottleKey(key))
    const rows = await tx.select().from(loginThrottle).where(inArray(loginThrottle.key, names))
    const decision = planAttempt(specs, rows, now ?? new Date())
    if (!decision.allowed) return decision
    for (const entry of decision.reservation.keys) {
      const values = { failures: entry.failures, nextAllowedAt: entry.nextAllowedAt, updatedAt: entry.updatedAt }
      await tx
        .insert(loginThrottle)
        .values({ key: entry.key, ...values })
        .onConflictDoUpdate({ target: loginThrottle.key, set: values })
    }
    return decision
  })
}

/** Gives a reserved attempt back on `keys` (default: all of them), as `planRefund` describes. Rows at 0 are deleted. */
export async function refundAttempt(reservation: AttemptReservation, keys?: string[]): Promise<void> {
  const db = useDb()
  // Raw sql fragments get ISO strings: the postgres-js driver does not serialize Date parameters there.
  const iso = (date: Date | null) => date?.toISOString() ?? null
  for (const reserved of reservation.keys) {
    if (keys && !keys.includes(reserved.key)) continue
    const [row] = await db
      .update(loginThrottle)
      .set({
        failures: sql`greatest(${loginThrottle.failures} - 1, 0)`,
        nextAllowedAt: sql`case when ${loginThrottle.nextAllowedAt} is not distinct from ${iso(reserved.nextAllowedAt)}::timestamptz
          then ${iso(reserved.previousNextAllowedAt)}::timestamptz else ${loginThrottle.nextAllowedAt} end`,
        updatedAt: sql`case when ${iso(reserved.previousUpdatedAt)}::timestamptz is not null
          and ${loginThrottle.updatedAt} = ${iso(reserved.updatedAt)}::timestamptz
          then ${iso(reserved.previousUpdatedAt)}::timestamptz else ${loginThrottle.updatedAt} end`,
      })
      .where(eq(loginThrottle.key, reserved.key))
      .returning({ failures: loginThrottle.failures })
    if (row?.failures === 0) {
      await db.delete(loginThrottle).where(and(eq(loginThrottle.key, reserved.key), eq(loginThrottle.failures, 0)))
    }
  }
}

export async function clearLoginFailures(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)]
  if (unique.length) await useDb().delete(loginThrottle).where(inArray(loginThrottle.key, unique))
}

/**
 * Forgets every login failure of an account: its email key and its network pair keys (password reset by mail or by
 * an admin, `cli reset-password`). The network keys stay, as after a successful login.
 */
export async function clearAccountThrottle(email: string): Promise<void> {
  const account = emailThrottleKey(email)
  const pattern = `%|${account.replace(/[\\%_]/g, (c) => `\\${c}`)}`
  await useDb()
    .delete(loginThrottle)
    .where(or(eq(loginThrottle.key, account), like(loginThrottle.key, pattern)))
}
