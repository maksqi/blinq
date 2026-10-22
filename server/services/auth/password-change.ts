/**
 * `POST /api/auth/password` (auth, docs/API.md §3; exempt from the forced-password-change guard).
 *
 * The current password is verified (wrong → 401 `AUTH_INVALID_CREDENTIALS`, with the same backoff as `login` on the
 * keys `pwchange:<userId>` and the caller's IP, so a stolen session cannot be used to guess it), the new one must pass the
 * policy and differ from the current one (400 `AUTH_PASSWORD_WEAK`). Then: new hash, `must_change_password = false`,
 * every other session revoked, the current session rotated (new cookie), `user.revoked` published so live call
 * identities of the user are removed, audit `auth.password_changed`.
 */
import { getRequestHeader, type H3Event } from 'h3'
import type { AuthUser } from '#shared/schemas/auth'
import { apiError } from '../../utils/api-error'
import { getAuth } from '../../utils/auth'
import { getClientIp, limiterKeysForIp } from '../../utils/client-ip'
import { setSessionCookie } from '../../utils/cookies'
import { eventBus } from '../../utils/event-bus'
import { verifyPassword } from '../../utils/password'
import { audit } from '../audit/audit'
import { revokeAllForUser, rotateSession } from '../session/sessions'
import { findUserById, setPassword, toAuthUser } from '../users/users'
import { assertPasswordAllowed } from './password-policy'
import { loginThrottle } from './throttle'

export async function changePassword(
  event: H3Event,
  input: { currentPassword: string; newPassword: string },
  now: Date = new Date(),
): Promise<AuthUser> {
  const { user, session } = await getAuth(event)
  if (!user || !session) throw apiError('UNAUTHENTICATED', 401)
  // Own key per account (not the email's login key, which strangers can drive up), plus the caller's IP. The attempt
  // is reserved before the check, like a login, so parallel guesses see each other (F-016).
  const accountKey = passwordChangeThrottleKey(user.id)
  const attempt = await loginThrottle.reserve(event, [{ key: accountKey }, { key: limiterKeysForIp(getClientIp(event)).net }], now)

  let verified: boolean
  try {
    const row = await findUserById(user.id)
    verified = !!row?.passwordHash && (await verifyPassword(row.passwordHash, input.currentPassword))
  } catch (error) {
    await loginThrottle.release(attempt)
    throw error
  }
  if (!verified) throw apiError('AUTH_INVALID_CREDENTIALS', 401)
  await loginThrottle.succeeded(attempt, [accountKey])
  assertPasswordAllowed(input.newPassword, { current: input.currentPassword })

  const updated = await setPassword(user.id, input.newPassword, { mustChangePassword: false, now })
  await revokeAllForUser(user.id, { exceptSessionId: session.id })
  const token = await rotateSession(
    session.id,
    { ip: getClientIp(event), userAgent: getRequestHeader(event, 'user-agent') ?? null },
    now,
  )
  if (!token) throw apiError('UNAUTHENTICATED', 401)
  setSessionCookie(event, token)
  eventBus().publish({ type: 'user.revoked', userId: user.id })
  await audit(
    event,
    { action: 'auth.password_changed', actorUserId: user.id, targetType: 'user', targetId: user.id },
    { now },
  )
  return toAuthUser(updated)
}

export function passwordChangeThrottleKey(userId: string): string {
  return `pwchange:${userId}`
}
