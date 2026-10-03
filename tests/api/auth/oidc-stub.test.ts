/**
 * OIDC readiness (decision: in-process against the test database): a stub identity provider signs in a user who has no
 * password through `auth_identities` and the same session path as passwords (auth_method = provider id, cookie,
 * last_login_at, audit, disabled check).
 */
import { and, eq } from 'drizzle-orm'
import { H3Error } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { authIdentities, sessions, users } from '../../../server/database/schema'
import { createIdentityProvider, linkIdentity, registerAuthProvider } from '../../../server/services/auth/providers'
import { signInWithProvider } from '../../../server/services/auth/sign-in'
import { validateSession } from '../../../server/services/session/sessions'
import { hashToken } from '../../../server/utils/crypto'
import {
  createClient,
  expectApiError,
  fakeEvent,
  testDb,
  uniqueEmail,
  uniqueName,
  useServerEnvInProcess,
} from '../_harness'
import { auditRows } from './support'

useServerEnvInProcess()

interface StubCallback {
  /** What a verified ID token would carry. */
  sub: string
  /** A real provider verifies signatures, nonce and audience; the stub only checks this flag. */
  valid: boolean
}

/** The provider's injected clock (F-047). */
const STUB_NOW = new Date('2026-09-30T09:00:00Z')
const stub = createIdentityProvider<StubCallback>(
  'oidc:stub',
  async (callback) => (callback.valid ? { subject: callback.sub, email: null } : null),
  { now: () => STUB_NOW },
)

let unregister: (() => void) | undefined
afterEach(() => {
  unregister?.()
  unregister = undefined
})

async function passwordlessUser(options: { disabled?: boolean } = {}) {
  const [user] = await testDb()
    .insert(users)
    .values({
      email: uniqueEmail('oidc'),
      displayName: uniqueName('Oidc'),
      passwordHash: null,
      emailVerifiedAt: new Date(),
      disabledAt: options.disabled ? new Date() : null,
    })
    .returning()
  const subject = `stub-${user!.id}`
  await testDb().insert(authIdentities).values({ userId: user!.id, provider: 'oidc:stub', subject, email: user!.email })
  return { user: user!, subject }
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof H3Error) return (error.data as { code?: string }).code
    throw error
  }
  return undefined
}

function sessionTokenFrom(event: ReturnType<typeof fakeEvent>): string | undefined {
  const header = event.node.res.getHeader('set-cookie')
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [String(header)]
  return cookies.map((c) => c.match(/^blinq_session=([A-Za-z0-9_-]{43});/)?.[1]).find(Boolean)
}

describe('OIDC stub provider', () => {
  it('signs in a passwordless user through auth_identities and the shared session path', async () => {
    unregister = registerAuthProvider(stub)
    const { user, subject } = await passwordlessUser()
    const event = fakeEvent({
      method: 'POST',
      path: '/api/auth/oidc/callback',
      ip: '198.51.100.70',
      headers: { 'user-agent': 'stub-browser' },
    })

    const signedIn = await signInWithProvider(event, 'oidc:stub', { sub: subject, valid: true })
    expect(signedIn).toMatchObject({ id: user.id, email: user.email, role: 'user', mustChangePassword: false })

    const token = sessionTokenFrom(event)
    expect(token).toBeDefined()
    const [row] = await testDb()
      .select()
      .from(sessions)
      .where(eq(sessions.id, hashToken(token!)))
    expect(row).toMatchObject({
      userId: user.id,
      authMethod: 'oidc:stub',
      ip: '198.51.100.70',
      userAgent: 'stub-browser',
    })
    expect((await validateSession(token!))?.user.id).toBe(user.id)

    const [account] = await testDb().select().from(users).where(eq(users.id, user.id))
    expect(account!.lastLoginAt).not.toBeNull()
    const [identity] = await testDb()
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, 'oidc:stub'), eq(authIdentities.subject, subject)))
    expect(identity!.lastUsedAt).toEqual(STUB_NOW)
    const logins = await auditRows({ action: 'auth.login', targetId: user.id })
    expect(logins.map((r) => r.details)).toEqual([{ method: 'oidc:stub' }])

    // The session works over HTTP like any other.
    const api = createClient().setCookie('blinq_session', token!)
    expect((await api.get('/api/auth/me')).body.user.id).toBe(user.id)
  })

  it('refuses unverified callbacks and unknown subjects with AUTH_INVALID_CREDENTIALS, without a cookie', async () => {
    unregister = registerAuthProvider(stub)
    const { subject } = await passwordlessUser()
    for (const callback of [
      { sub: subject, valid: false },
      { sub: 'stub-unknown-subject', valid: true },
    ]) {
      const event = fakeEvent({ method: 'POST' })
      expect(await codeOf(signInWithProvider(event, 'oidc:stub', callback))).toBe('AUTH_INVALID_CREDENTIALS')
      expect(sessionTokenFrom(event)).toBeUndefined()
    }
  })

  it('applies the same account rules (disabled accounts cannot sign in)', async () => {
    unregister = registerAuthProvider(stub)
    const { subject } = await passwordlessUser({ disabled: true })
    const event = fakeEvent({ method: 'POST' })
    expect(await codeOf(signInWithProvider(event, 'oidc:stub', { sub: subject, valid: true }))).toBe(
      'AUTH_ACCOUNT_DISABLED',
    )
    expect(sessionTokenFrom(event)).toBeUndefined()
  })

  it('is unknown once unregistered', async () => {
    const { subject } = await passwordlessUser()
    await expect(signInWithProvider(fakeEvent(), 'oidc:stub', { sub: subject, valid: true })).rejects.toThrow(
      /Unknown auth provider/,
    )
  })

  it('a passwordless account cannot sign in with a password', async () => {
    const { user } = await passwordlessUser()
    const res = await createClient().post('/api/auth/login', {
      body: { email: user.email, password: 'any-password-at-all' },
    })
    expectApiError(res, 401, 'AUTH_INVALID_CREDENTIALS')
  })

  it('links identities idempotently and never to two users', async () => {
    const { user, subject } = await passwordlessUser()
    const other = await passwordlessUser()
    expect(await linkIdentity({ userId: user.id, provider: 'oidc:stub', subject })).toBe(true)
    expect(await linkIdentity({ userId: other.user.id, provider: 'oidc:stub', subject })).toBe(false)
  })
})
