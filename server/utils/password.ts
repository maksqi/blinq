/**
 * Password hashing and policy (server-core, docs/SECURITY.md §4).
 *
 * - `hashPassword(password)`: argon2id (`algorithm: 2`, m=19456 KiB, t=2, p=1), at most 4 concurrent hashes and 16
 *   waiting ones; beyond that both functions throw 429 `RATE_LIMITED` (`passwordHashingBusy()`).
 * - `verifyPassword(hash, password)`: parameters come from the PHC string; false for malformed hashes.
 * - `verifyAgainstDummy(password)`: same cost as a real verify, always false. Call it for unknown emails so response
 *   times do not reveal which accounts exist.
 * - `passwordNeedsRehash(hash)`: true when the hash was made with other parameters (rehash after a successful login).
 * - `checkPasswordPolicy(password)`: 12..256 characters and not a common password (bundled denylist, padded and
 *   leetspeak variants, repeats, sequences, keyboard walks). Map failures to `AUTH_PASSWORD_WEAK`.
 * - `warmUpPasswordHashing()`: precomputes the dummy hash (called by a server plugin at startup).
 */
import { hash, parseOptions, verify } from '@node-rs/argon2'
import { apiError } from './api-error'
import { COMMON_PASSWORDS } from './common-passwords'
import { randomToken } from './crypto'
import { createSemaphore, SemaphoreFullError } from './semaphore'

/** OWASP argon2id profile. `algorithm: 2` = Argon2id (the package's `Algorithm` is a const enum). */
export const ARGON2_PARAMS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

/**
 * Concurrent hashes are capped to keep login floods from exhausting CPU and memory (decision: 4), and so is the queue
 * behind them (decision: 16, F-016): about 100 ms of waiting at most, then new work is refused at once with 429
 * `RATE_LIMITED` (`Retry-After: 1`) instead of slowing every sign-in down.
 */
export const HASHING_CONCURRENCY = 4
export const HASHING_MAX_WAITING = 16
const hashing = createSemaphore(HASHING_CONCURRENCY, { maxWaiting: HASHING_MAX_WAITING })

export const HASHING_BUSY_RETRY_AFTER_SECONDS = 1

export function passwordHashingBusy() {
  return apiError('RATE_LIMITED', 429, { retryAfter: HASHING_BUSY_RETRY_AFTER_SECONDS })
}

/** True while the hashing queue is full: callers can refuse at once, before any other work (a login flood). */
export function passwordHashingSaturated(): boolean {
  return hashing.waiting >= HASHING_MAX_WAITING
}

async function withHashingSlot<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await hashing.run(task)
  } catch (error) {
    if (error instanceof SemaphoreFullError) throw passwordHashingBusy()
    throw error
  }
}

export interface HashPasswordOptions {
  /** Tests only: cheaper argon2 cost. Production code never passes this. */
  testParams?: { memoryCost: number; timeCost: number }
}

export async function hashPassword(password: string, options: HashPasswordOptions = {}): Promise<string> {
  const params = options.testParams ? { ...ARGON2_PARAMS, ...options.testParams } : ARGON2_PARAMS
  return withHashingSlot(() => hash(password, params))
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  return withHashingSlot(async () => {
    try {
      return await verify(hashed, password)
    } catch {
      return false
    }
  })
}

let dummyHash: Promise<string> | undefined

export function warmUpPasswordHashing(): Promise<string> {
  // Random plaintext: no password can ever match the dummy.
  dummyHash ??= hash(randomToken(), ARGON2_PARAMS)
  return dummyHash
}

export async function verifyAgainstDummy(password: string): Promise<false> {
  const dummy = await warmUpPasswordHashing()
  await verifyPassword(dummy, password)
  return false
}

export function passwordNeedsRehash(hashed: string): boolean {
  try {
    const current = parseOptions(hashed)
    return (
      current.algorithm !== ARGON2_PARAMS.algorithm ||
      current.memoryCost !== ARGON2_PARAMS.memoryCost ||
      current.timeCost !== ARGON2_PARAMS.timeCost ||
      current.parallelism !== ARGON2_PARAMS.parallelism
    )
  } catch {
    return true
  }
}

// ---- Policy -------------------------------------------------------------------------------------------------------

export type PasswordPolicyReason = 'too_short' | 'too_long' | 'common'
export type PasswordPolicyResult = { ok: true } | { ok: false; reason: PasswordPolicyReason }

const DENYLIST = new Set(COMMON_PASSWORDS)
const KEYBOARD_WALKS = [
  'qwertyuiopasdfghjklzxcvbnm',
  'mnbvcxzlkjhgfdsapoiuytrewq',
  'qazwsxedcrfvtgbyhnujmikolp',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p',
  '1q2w3e4r5t6y7u8i9o0p',
  'zaq1xsw2cde3vfr4bgt5nhy6mju7',
  '1234567890qwertyuiop',
]
const LEET: Record<string, string> = { '@': 'a', '4': 'a', '0': 'o', '1': 'i', '3': 'e', $: 's', '5': 's', '7': 't' }

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: 'too_short' }
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, reason: 'too_long' }
  if (isCommonPassword(password)) return { ok: false, reason: 'common' }
  return { ok: true }
}

export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase()
  if (DENYLIST.has(lower) || DENYLIST.has(unleet(lower))) return true
  // A short unit repeated ("aaaaaaaaaaaa", "abcabcabcabc", "121212121212").
  if (/^(.{1,4})\1+$/su.test(lower)) return true
  if (isSequence(lower)) return true
  if (KEYBOARD_WALKS.some((walk) => walk.includes(lower))) return true
  // A common word padded with digits or symbols ("password2024!", "!!letmein123").
  const core = lower.replace(/^[\d\W_]+|[\d\W_]+$/gu, '')
  return core.length >= 4 && core !== lower && (DENYLIST.has(core) || DENYLIST.has(unleet(core)))
}

function unleet(text: string): string {
  return text.replace(/[@40135$7]/g, (c) => LEET[c] ?? c)
}

/** Ascending or descending runs: "abcdefghijkl", "123456789012" (digits wrap), "zyxwvutsrqpo". */
function isSequence(text: string): boolean {
  if (/^\d+$/.test(text)) {
    const steps = new Set<number>()
    for (let i = 1; i < text.length; i++) steps.add((Number(text[i]) - Number(text[i - 1]) + 10) % 10)
    return steps.size === 1 && (steps.has(1) || steps.has(9))
  }
  if (/^[a-z]+$/.test(text)) {
    const steps = new Set<number>()
    for (let i = 1; i < text.length; i++) steps.add(text.charCodeAt(i) - text.charCodeAt(i - 1))
    return steps.size === 1 && (steps.has(1) || steps.has(-1))
  }
  return false
}
