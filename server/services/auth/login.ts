/**
 * `POST /api/auth/login` (auth, docs/API.md §3).
 *
 * 1. At most `LOGIN_MAX_IN_FLIGHT` attempts per network (IPv4 address or IPv6 /64) run at once; more answer 429
 *    `RATE_LIMITED` (`Retry-After: 1`) before touching the database (F-016). Finished attempts free their slot, so
 *    successful sign-ins from one shared address (an office NAT, the E2E proxy) never add up.
 * 2. The `login` backoff (`throttle.ts`) reserves the attempt atomically: it is refused with 429 while a key waits,
 *    otherwise it already counts as a failure, so parallel guesses see each other.
 * 3. The `password` provider verifies the credentials. Unknown emails pay the argon2 cost and get exactly the same
 *    401 `AUTH_INVALID_CREDENTIALS` as a wrong password; both stay counted on every key. A full hashing queue answers
 *    429 and gives the attempt back.
 * 4. Only after a correct password are disabled and unverified states revealed (`completeSignIn`); such refusals give
 *    the attempt back (a right password is not a guess).
 * 5. Success clears the account keys (email and network + email) and gives the attempt back on the network key.
 */
import type { H3Event } from 'h3'
import type { AuthUser } from '#shared/schemas/auth'
import { apiError } from '../../utils/api-error'
import { getClientIp, limiterKeysForIp } from '../../utils/client-ip'
import { createConcurrencyLimit, throwRateLimited } from '../../utils/limiter'
import { passwordProvider } from './providers'
import { auditLoginFailure, completeSignIn } from './sign-in'
import { loginAttemptKeys, loginThrottle } from './throttle'

/** Decision: a few parallel sign-ins per network are normal (a shared NAT); a flood is not. */
export const LOGIN_MAX_IN_FLIGHT = 8
const inFlight = createConcurrencyLimit(LOGIN_MAX_IN_FLIGHT)

export async function loginWithPassword(event: H3Event, input: { email: string; password: string }): Promise<AuthUser> {
  const email = input.email.trim().toLowerCase()
  const ip = getClientIp(event)
  const release = inFlight.tryAcquire(limiterKeysForIp(ip).net)
  if (!release) throwRateLimited(event, 1_000)
  try {
    return await attemptLogin(event, email, input.password, ip)
  } finally {
    release()
  }
}

async function attemptLogin(event: H3Event, email: string, password: string, ip: string | null): Promise<AuthUser> {
  const keys = loginAttemptKeys(email, ip)
  const attempt = await loginThrottle.reserve(event, keys)

  let result: Awaited<ReturnType<typeof passwordProvider.authenticate>>
  try {
    result = await passwordProvider.authenticate({ email, password })
  } catch (error) {
    await loginThrottle.release(attempt)
    throw error
  }
  if (!result) {
    await auditLoginFailure(event, { email, reason: 'invalid_credentials', method: 'password' })
    throw apiError('AUTH_INVALID_CREDENTIALS', 401)
  }

  let user: AuthUser
  try {
    user = await completeSignIn(event, { userId: result.userId, method: 'password' })
  } catch (error) {
    await loginThrottle.release(attempt)
    throw error
  }
  // Every key except the network's belongs to this account.
  await loginThrottle.succeeded(
    attempt,
    keys.filter((spec) => spec.key !== limiterKeysForIp(ip).net).map((spec) => spec.key),
  )
  return user
}
