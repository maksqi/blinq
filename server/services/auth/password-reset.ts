/**
 * Password reset by email (auth, docs/API.md §3).
 *
 * - `requestPasswordReset(event, email, options)`: SMTP off → 503 `SERVICE_UNAVAILABLE`. Otherwise the caller always
 *   answers 202: the `reset-email` limiter (3 per hour per address) drops extra requests silently. Everything that
 *   depends on the account (lookup, token, mail, audit) runs after the response, in `issuePasswordReset`, so the
 *   response time is the same for known and unknown addresses (F-024). Jobs for one address run one after another, so
 *   a new request always replaces older links.
 * - `issuePasswordReset(email, { ip, now })`: only an existing, enabled account gets a mail with
 *   `/reset-password#<token>` (1 h, single use; replaces older links). Audit `auth.password_reset_requested`.
 * - `confirmPasswordReset(event, { token, newPassword })`: the policy is checked before the token is spent; then the
 *   token is consumed and the password set in one transaction (`must_change_password = false`; a working reset link
 *   also proves the address, so it counts as verified). Every session is revoked (`user.revoked`), the account's
 *   login backoff is cleared, audit `auth.password_reset`. It does not sign in (decision).
 */
import type { H3Event } from 'h3'
import { useDb } from '../../database/client'
import { apiError } from '../../utils/api-error'
import { getClientIp } from '../../utils/client-ip'
import { clearAccountThrottle, emailThrottleKey, getLimiter } from '../../utils/limiter'
import { logger } from '../../utils/logger'
import { audit } from '../audit/audit'
import { passwordResetMessage } from '../mail/messages'
import { isSmtpConfigured, sendMailInBackground } from '../mail/transport'
import { revokeAllForUser } from '../session/sessions'
import { findUserByEmail, setPassword } from '../users/users'
import { consumeEmailToken, issueEmailToken, RESET_PASSWORD_TTL_MS } from './email-tokens'
import { assertPasswordAllowed } from './password-policy'

/** Starts work that must not delay the response; failures are logged by label only (never the address). */
export type BackgroundRunner = (label: string, job: () => Promise<unknown>) => void

export const runInBackground: BackgroundRunner = (label, job) => {
  job().catch((error: unknown) => logger.error('background job failed', { job: label, err: error }))
}

const jobsByAddress = new Map<string, Promise<unknown>>()

/** Runs `job` after every earlier job for the same address has finished. */
function afterEarlierJobs(address: string, job: () => Promise<unknown>): Promise<unknown> {
  const run = (jobsByAddress.get(address) ?? Promise.resolve()).catch(() => undefined).then(job)
  jobsByAddress.set(address, run)
  const forget = () => {
    if (jobsByAddress.get(address) === run) jobsByAddress.delete(address)
  }
  run.then(forget, forget)
  return run
}

export async function requestPasswordReset(
  event: H3Event,
  email: string,
  options: { now?: Date; background?: BackgroundRunner } = {},
): Promise<void> {
  if (!isSmtpConfigured()) throw apiError('SERVICE_UNAVAILABLE', 503)
  const key = emailThrottleKey(email)
  if (!getLimiter('reset-email').consume(key).allowed) return
  // The socket may be gone when the job runs: take the IP now.
  const ip = getClientIp(event)
  const now = options.now ?? new Date()
  const background = options.background ?? runInBackground
  background('reset-password', () => afterEarlierJobs(key, () => issuePasswordReset(email, { ip, now })))
}

/** The account-dependent part of a reset request. Returns whether a mail was queued. */
export async function issuePasswordReset(email: string, context: { ip: string | null; now: Date }): Promise<boolean> {
  const user = await findUserByEmail(email)
  if (!user || user.disabledAt) return false
  const token = await issueEmailToken(user.id, 'reset_password', { now: context.now, replace: true })
  await audit(
    null,
    { action: 'auth.password_reset_requested', actorUserId: null, targetType: 'user', targetId: user.id },
    { now: context.now, ip: context.ip },
  )
  sendMailInBackground(
    passwordResetMessage({
      to: user.email,
      displayName: user.displayName,
      token,
      expiresInMinutes: RESET_PASSWORD_TTL_MS / 60_000,
    }),
    'reset-password',
  )
  return true
}

export async function confirmPasswordReset(
  event: H3Event,
  input: { token: string; newPassword: string },
  now: Date = new Date(),
): Promise<void> {
  assertPasswordAllowed(input.newPassword)
  const user = await useDb().transaction(async (tx) => {
    const { userId } = await consumeEmailToken(input.token, 'reset_password', { now, db: tx })
    const row = await setPassword(userId, input.newPassword, {
      mustChangePassword: false,
      markEmailVerified: true,
      now,
      db: tx,
    })
    await audit(
      event,
      { action: 'auth.password_reset', actorUserId: userId, targetType: 'user', targetId: userId },
      { db: tx, now },
    )
    return row
  })
  await revokeAllForUser(user.id)
  await clearAccountThrottle(user.email)
}
