/**
 * `cli bootstrap` (server-core, docs/SECURITY.md §4). Runs before the server starts, under the migration advisory
 * lock, and is idempotent:
 * - `system.bootstrapDone` set → nothing to do;
 * - an admin already exists → only mark bootstrap done;
 * - otherwise create the admin from ADMIN_EMAIL / ADMIN_PASSWORD (`must_change_password`, verified email, a
 *   `password` auth identity), mark bootstrap done and write `system.bootstrap` to the audit log.
 * Missing, weak or placeholder credentials are refused only while bootstrap is pending (exit 1). There is no
 * "first user becomes admin" rule.
 */
import { count, eq, sql } from 'drizzle-orm'
import { emailSchema } from '#shared/schemas/common'
import { useDb } from '../../database/client'
import { connectWithRetry, MIGRATION_LOCK_ID } from '../../database/migrate'
import { authIdentities, users } from '../../database/schema'
import { env } from '../../utils/env'
import { checkPasswordPolicy, hashPassword } from '../../utils/password'
import { audit } from '../audit/audit'
import { getSystemFlag, setSystemFlag } from '../settings/settings'

export const BOOTSTRAP_FLAG = 'system.bootstrapDone'
export const BOOTSTRAP_DISPLAY_NAME = 'Administrator'

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootstrapError'
  }
}

export type BootstrapOutcome =
  | { status: 'created'; userId: string; email: string }
  | { status: 'marked' }
  | { status: 'already_done' }

const PLACEHOLDER = /^(?:change-?me|changeme|replace-?me|example|placeholder|secret|password)|change-?me|replace-?me|placeholder/i

export function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER.test(value.trim())
}

/** Pure: validated credentials or a BootstrapError that says what to fix. */
export function validateBootstrapCredentials(email: string | undefined, password: string | undefined) {
  if (!email || !password) {
    throw new BootstrapError('No administrator exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then start again.')
  }
  const parsed = emailSchema.safeParse(email)
  if (!parsed.success) throw new BootstrapError('ADMIN_EMAIL is not a valid email address.')
  if (isPlaceholderSecret(password)) {
    throw new BootstrapError('ADMIN_PASSWORD still has a placeholder value. Choose a real password (at least 12 characters).')
  }
  const policy = checkPasswordPolicy(password)
  if (!policy.ok) {
    const reason = {
      too_short: 'is shorter than 12 characters',
      too_long: 'is longer than 256 characters',
      common: 'is too common',
    }[policy.reason]
    throw new BootstrapError(`ADMIN_PASSWORD ${reason}. Choose a stronger password.`)
  }
  return { email: parsed.data, password }
}

export async function bootstrap(options: { email?: string; password?: string; now?: Date } = {}): Promise<BootstrapOutcome> {
  const now = options.now ?? new Date()
  return useDb().transaction(async (tx) => {
    // Same lock as migrations: concurrent starters run one after another.
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`)
    if (await getSystemFlag(BOOTSTRAP_FLAG, tx)) return { status: 'already_done' } as const

    const [admins] = await tx.select({ n: count() }).from(users).where(eq(users.role, 'admin'))
    if ((admins?.n ?? 0) > 0) {
      await setSystemFlag(BOOTSTRAP_FLAG, { at: now.toISOString(), reason: 'admin_exists' }, tx, now)
      return { status: 'marked' } as const
    }

    const credentials = validateBootstrapCredentials(options.email, options.password)
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, credentials.email))
    if (taken) {
      throw new BootstrapError('A non-admin account already uses ADMIN_EMAIL. Set ADMIN_EMAIL to a new address.')
    }
    const [user] = await tx
      .insert(users)
      .values({
        email: credentials.email,
        displayName: BOOTSTRAP_DISPLAY_NAME,
        role: 'admin',
        passwordHash: await hashPassword(credentials.password),
        mustChangePassword: true,
        emailVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: users.id })
    const userId = user!.id
    await tx.insert(authIdentities).values({ userId, provider: 'password', subject: userId, email: credentials.email })
    await setSystemFlag(BOOTSTRAP_FLAG, { at: now.toISOString(), userId }, tx, now)
    await audit(
      null,
      { action: 'system.bootstrap', targetType: 'user', targetId: userId, details: { email: credentials.email } },
      { db: tx, now },
    )
    return { status: 'created', userId, email: credentials.email } as const
  })
}

/** CLI entry: waits for the database, bootstraps, prints one line. Returns the exit code. */
export async function runBootstrap(): Promise<number> {
  const config = env()
  const probe = await connectWithRetry(config.DATABASE_URL)
  await probe.end({ timeout: 1 })
  try {
    const outcome = await bootstrap({ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD })
    const message = {
      created: `created the admin account ${outcome.status === 'created' ? outcome.email : ''} (password change required at first sign-in)`,
      marked: 'an admin already exists; bootstrap marked as done',
      already_done: 'nothing to do (already done)',
    }[outcome.status]
    process.stdout.write(`[blinq] bootstrap: ${message}\n`)
    return 0
  } catch (error) {
    if (error instanceof BootstrapError) {
      process.stderr.write(`[blinq] bootstrap failed: ${error.message}\n`)
      return 1
    }
    throw error
  }
}
