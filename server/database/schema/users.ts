import { boolean, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, tstz, updatedAt } from './_columns'

export const userRole = pgEnum('user_role', ['admin', 'user'])

/** Accounts. Emails are stored lowercased (normalized in code). */
export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text().notNull(),
    displayName: text().notNull(),
    role: userRole().notNull().default('user'),
    /** argon2id hash; null for accounts that only sign in through an external provider (OIDC, later). */
    passwordHash: text(),
    mustChangePassword: boolean().notNull().default(false),
    emailVerifiedAt: tstz(),
    disabledAt: tstz(),
    lastLoginAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email), index('users_role_idx').on(t.role)],
)

/** Sign-in identities per provider. `password` today, `oidc:<providerId>` later — no schema change needed. */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    subject: text().notNull(),
    email: text(),
    createdAt: createdAt(),
    lastUsedAt: tstz(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject_unique').on(t.provider, t.subject),
    index('auth_identities_user_idx').on(t.userId),
  ],
)

/** Server-side sessions. `id` is sha256(token) in hex; the raw token lives only in the cookie. */
export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authMethod: text().notNull().default('password'),
    createdAt: createdAt(),
    /** Idle expiry is computed from this. */
    lastSeenAt: tstz().notNull().defaultNow(),
    /** Absolute expiry. */
    expiresAt: tstz().notNull(),
    ip: text(),
    userAgent: text(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)

/** Account invites created by admins. Token hash only; the raw token is shown once / emailed. */
export const userInvites = pgTable(
  'user_invites',
  {
    id: pk(),
    tokenHash: text().notNull(),
    /** Required for admin-role invites; optional otherwise (if set, the invite is bound to this email). */
    email: text(),
    role: userRole().notNull().default('user'),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tstz().notNull(),
    usedAt: tstz(),
    usedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_invites_token_hash_unique').on(t.tokenHash),
    // FKs with ON DELETE SET NULL: deleting a user must not scan every invite.
    index('user_invites_created_by_idx').on(t.createdBy),
    index('user_invites_used_by_idx').on(t.usedBy),
  ],
)

export const emailTokenPurpose = pgEnum('email_token_purpose', ['verify_email', 'reset_password'])

/** Email verification and password reset tokens (hashed, single use, expiring). */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: emailTokenPurpose().notNull(),
    tokenHash: text().notNull(),
    expiresAt: tstz().notNull(),
    usedAt: tstz(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('email_tokens_token_hash_unique').on(t.tokenHash), index('email_tokens_user_idx').on(t.userId)],
)

/**
 * Login backoff state. Keys: `email:<address>`, `ip:<address>`, `net:<ipv6 /64>`.
 * Exponential backoff instead of hard lockout (attackers must not be able to lock out the admin).
 */
export const loginThrottle = pgTable('login_throttle', {
  key: text().primaryKey(),
  failures: integer().notNull().default(0),
  nextAllowedAt: tstz(),
  updatedAt: updatedAt(),
})
