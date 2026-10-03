/**
 * `cli reset-password <email>` (server-core, docs/SECURITY.md §4): account recovery for operators.
 * Reads the new password from stdin (never argv), checks the policy, stores it with `must_change_password`, revokes
 * every session, clears the email's login backoff and writes `system.reset_password` to the audit log.
 * Sessions cached by a running server stay valid for at most 30 s (the cache bound).
 */
import { eq } from 'drizzle-orm'
import { emailSchema } from '#shared/schemas/common'
import { useDb } from '../../database/client'
import { connectWithRetry } from '../../database/migrate'
import { authIdentities, users } from '../../database/schema'
import { env } from '../../utils/env'
import { clearAccountThrottle } from '../../utils/limiter'
import { checkPasswordPolicy, hashPassword } from '../../utils/password'
import { audit } from '../audit/audit'
import { PromptAbortedError, readPassword } from './read-password'
import { revokeAllForUser } from './sessions'

export class ResetPasswordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResetPasswordError'
  }
}

export interface ResetPasswordResult {
  userId: string
  revokedSessions: number
  disabled: boolean
}

export async function resetPassword(email: string, password: string, now: Date = new Date()): Promise<ResetPasswordResult> {
  const parsed = emailSchema.safeParse(email)
  if (!parsed.success) throw new ResetPasswordError('That is not a valid email address.')
  const policy = checkPasswordPolicy(password)
  if (!policy.ok) {
    const reason = { too_short: 'shorter than 12 characters', too_long: 'longer than 256 characters', common: 'too common' }
    throw new ResetPasswordError(`The new password is ${reason[policy.reason]}.`)
  }
  const address = parsed.data
  const passwordHash = await hashPassword(password)

  const user = await useDb().transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: now })
      .where(eq(users.email, address))
      .returning({ id: users.id, disabledAt: users.disabledAt })
    if (!row) throw new ResetPasswordError(`No account uses ${address}.`)
    await tx
      .insert(authIdentities)
      .values({ userId: row.id, provider: 'password', subject: row.id, email: address })
      .onConflictDoNothing()
    await audit(
      null,
      { action: 'system.reset_password', targetType: 'user', targetId: row.id, details: { via: 'cli' } },
      { db: tx, now },
    )
    return row
  })

  const revokedSessions = await revokeAllForUser(user.id)
  await clearAccountThrottle(address)
  return { userId: user.id, revokedSessions, disabled: user.disabledAt !== null }
}

/** CLI entry. Returns the exit code. */
export async function runResetPassword(email: string): Promise<number> {
  const config = env()
  try {
    const password = await readPassword({ prompt: 'New password: ' })
    if (process.stdin.isTTY) {
      const again = await readPassword({ prompt: 'Repeat the new password: ' })
      if (again !== password) throw new ResetPasswordError('The passwords do not match.')
    }
    const probe = await connectWithRetry(config.DATABASE_URL)
    await probe.end({ timeout: 1 })
    const result = await resetPassword(email, password)
    process.stdout.write(
      `[blinq] password reset for ${email.trim().toLowerCase()}: ${result.revokedSessions} session(s) revoked; ` +
        'a password change is required at the next sign-in.\n',
    )
    if (result.disabled) process.stdout.write('[blinq] note: this account is disabled; an admin must enable it.\n')
    return 0
  } catch (error) {
    if (error instanceof PromptAbortedError) {
      process.stderr.write('[blinq] reset-password aborted.\n')
      return 130
    }
    if (error instanceof ResetPasswordError) {
      process.stderr.write(`[blinq] reset-password failed: ${error.message}\n`)
      return 1
    }
    throw error
  }
}
