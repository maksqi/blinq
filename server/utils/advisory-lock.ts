/**
 * Transaction-scoped advisory locks without parking pool connections (server-core, F-046).
 *
 *   await withAdvisoryLocks(useDb(), ['blinq:room:<id>'], async (tx) => { ... }, { waitMs: 15_000 })
 *
 * A blocking `pg_advisory_xact_lock` keeps its pool connection while it waits, so enough waiters on one hot key (ten
 * parallel joins of one room, a flood of logins for one address) hold the whole pool (10 connections) and every other
 * request stalls behind them. Here each try takes the locks with `pg_try_advisory_xact_lock` (keys sorted, all or
 * none); when one is taken, the transaction ends at once, which frees the connection and the locks it got, and the
 * call retries after a short, jittered, growing pause (`lockRetryDelayMs`). After `waitMs` it gives up with
 * `AdvisoryLockTimeoutError`. Lock ids are `hashtextextended(key, 0)`, the same ids blocking callers use.
 */
import { sql } from 'drizzle-orm'
import type { Db, Tx } from '../database/client'

export class AdvisoryLockTimeoutError extends Error {
  constructor(readonly keys: readonly string[]) {
    super('Timed out waiting for a lock')
    this.name = 'AdvisoryLockTimeoutError'
  }
}

export interface AdvisoryLockOptions {
  /** How long to keep retrying (default 10 s). */
  waitMs?: number
  /** Injectable for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

/** Pause before retry `attempt` (0-based): 5 ms doubling up to 100 ms, times a jitter factor in [0.5, 1). */
export function lockRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  return Math.min(100, 5 * 2 ** Math.min(attempt, 5)) * (0.5 + random() / 2)
}

const NOT_LOCKED = Symbol('not locked')

export async function withAdvisoryLocks<T>(
  db: Db,
  keys: readonly string[],
  fn: (tx: Tx) => Promise<T>,
  options: AdvisoryLockOptions = {},
): Promise<T> {
  const sorted = [...new Set(keys)].sort()
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (options.waitMs ?? 10_000)
  for (let attempt = 0; ; attempt++) {
    const outcome = await db.transaction(async (tx): Promise<{ value: T } | typeof NOT_LOCKED> => {
      for (const key of sorted) {
        const [row] = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as locked`,
        )
        if (!row?.locked) return NOT_LOCKED
      }
      return { value: await fn(tx) }
    })
    if (outcome !== NOT_LOCKED) return outcome.value
    if (now() >= deadline) throw new AdvisoryLockTimeoutError(sorted)
    await sleep(lockRetryDelayMs(attempt, options.random))
  }
}
