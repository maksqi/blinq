/**
 * Identity-backed providers (auth): the building block for OIDC. The provider-specific part (`verify`) checks the
 * external proof (for OIDC: the authorization-code callback and ID token, via openid-client later) and returns the
 * verified subject; this module maps it to a local user through `auth_identities (provider, subject)`.
 *
 *   const google = createIdentityProvider('oidc:google', (callback) => verifyOidcCallback(callback))
 *   registerAuthProvider(google)
 *   const user = await signInWithProvider(event, 'oidc:google', callbackParams)
 *
 * Unknown subjects resolve to null: there is no just-in-time account creation (decision; accounts come from invites,
 * registration or admins, and `linkIdentity()` attaches an external identity to an existing user).
 */
import { and, eq } from 'drizzle-orm'
import { useDb, type Db, type Tx } from '../../../database/client'
import { authIdentities } from '../../../database/schema'
import type { AuthProvider, AuthProviderId, VerifiedIdentity } from './types'

export function createIdentityProvider<Input>(
  id: Exclude<AuthProviderId, 'password'>,
  verify: (input: Input) => Promise<VerifiedIdentity | null>,
  options: { now?: () => Date } = {},
): AuthProvider<Input> {
  const now = options.now ?? (() => new Date())
  return {
    id,
    async authenticate(input) {
      const verified = await verify(input)
      if (!verified?.subject) return null
      const [row] = await useDb()
        .update(authIdentities)
        .set({ lastUsedAt: now(), ...(verified.email ? { email: verified.email.toLowerCase() } : {}) })
        .where(and(eq(authIdentities.provider, id), eq(authIdentities.subject, verified.subject)))
        .returning({ userId: authIdentities.userId })
      return row ? { userId: row.userId } : null
    },
  }
}

/** Attaches an external identity to a user. Idempotent for the same user; another user's identity is a conflict. */
export async function linkIdentity(
  input: { userId: string; provider: Exclude<AuthProviderId, 'password'>; subject: string; email?: string | null },
  db: Db | Tx = useDb(),
): Promise<boolean> {
  const inserted = await db
    .insert(authIdentities)
    .values({
      userId: input.userId,
      provider: input.provider,
      subject: input.subject,
      email: input.email?.toLowerCase() ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: authIdentities.id })
  if (inserted.length) return true
  const [existing] = await db
    .select({ userId: authIdentities.userId })
    .from(authIdentities)
    .where(and(eq(authIdentities.provider, input.provider), eq(authIdentities.subject, input.subject)))
  return existing?.userId === input.userId
}
