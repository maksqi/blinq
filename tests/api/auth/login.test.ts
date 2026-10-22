/**
 * POST /api/auth/login: cookie and session on success, identical answers for wrong passwords and unknown emails,
 * exponential backoff (429 + Retry-After, never a lockout, race-free under parallel guesses), the bounded hashing
 * queue, disabled accounts, unverified accounts in domain mode.
 */
import { eq, like } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { loginThrottle as throttleTable, sessions, users } from '../../../server/database/schema'
import { limiterKeysForIp, normalizeIp } from '../../../server/utils/client-ip'
import { hashToken } from '../../../server/utils/crypto'
import { createClient, createUser, expectApiError, loginAs, searchMessages, testDb, uniqueEmail } from '../_harness'
import {
  auditRows,
  mailToken,
  resetRegistration,
  sessionCookie,
  setRegistration,
  signIn,
  sleep,
  uniqueDomainEmail,
} from './support'

const WRONG = 'definitely-not-the-password'

describe('POST /api/auth/login', () => {
  it('signs in: user in the body, session cookie, session row, last_login_at, audit', async () => {
    const user = await createUser()
    const api = createClient()
    const res = await signIn(api, `  ${user.email.toUpperCase()} `, user.password, {})
    expect(res.status, res.text).toBe(200)
    expect(res.body).toEqual({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: 'user',
        mustChangePassword: false,
        emailVerified: true,
      },
    })
    const cookie = sessionCookie(res)
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await api.get('/api/auth/me')).body.user.id).toBe(user.id)

    const [row] = await testDb()
      .select()
      .from(sessions)
      .where(eq(sessions.id, hashToken(cookie!.value)))
    expect(row).toMatchObject({ userId: user.id, authMethod: 'password', ip: normalizeIp(api.ip) })
    const [account] = await testDb().select().from(users).where(eq(users.id, user.id))
    expect(account!.lastLoginAt).not.toBeNull()
    expect((await auditRows({ action: 'auth.login', targetId: user.id })).length).toBe(1)
  })

  it('answers a wrong password and an unknown email identically', async () => {
    const user = await createUser()
    const wrong = await signIn(createClient(), user.email, WRONG)
    const unknown = await signIn(createClient(), uniqueEmail(), WRONG)
    expectApiError(wrong, 401, 'AUTH_INVALID_CREDENTIALS')
    expect(unknown.status).toBe(wrong.status)
    expect(unknown.text).toBe(wrong.text)
    for (const header of ['content-type', 'content-length', 'cache-control', 'set-cookie']) {
      expect(unknown.headers.get(header), header).toBe(wrong.headers.get(header))
    }
    expect(wrong.setCookies).toEqual([])
    const failures = await auditRows({ action: 'auth.login_failed' })
    expect(failures.some((r) => (r.details as { email?: string } | null)?.email === user.email)).toBe(true)
  })

  it('backs off after 5 free failures with 429 and Retry-After, and is never a lockout', async () => {
    const user = await createUser()
    const api = createClient()
    for (let i = 0; i < 6; i++) expectApiError(await signIn(api, user.email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')

    // Even the right password waits now, from this IP.
    const blocked = await signIn(api, user.email, user.password)
    expectApiError(blocked, 429, 'RATE_LIMITED')
    const retryAfter = Number(blocked.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(2)
    expect(blocked.body.data.details).toEqual({ retryAfter })

    await sleep(retryAfter * 1_000 + 300)
    expect((await signIn(api, user.email, user.password)).status).toBe(200)
    const keys = await testDb()
      .select()
      .from(throttleTable)
      .where(like(throttleTable.key, `%email:${user.email}`))
    expect(keys).toEqual([]) // success resets the account keys (email and network + email)
  })

  it('never locks the owner out: guesses from other networks leave a clean network alone (F-017)', async () => {
    const user = await createUser()
    // Strangers drive the account key far into backoff, from many networks.
    for (let i = 0; i < 8; i++) {
      expectApiError(await signIn(createClient(), user.email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')
    }
    const attacker = createClient()
    expectApiError(await signIn(attacker, user.email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')
    // A network that already failed for the account waits for the account backoff...
    expectApiError(await signIn(attacker, user.email, WRONG), 429, 'RATE_LIMITED')
    // ...but the owner, from a network that never failed for it, signs in at once.
    expect((await signIn(createClient(), user.email, user.password)).status).toBe(200)
  })

  it('counts unknown emails the same way, so 429s reveal nothing', async () => {
    const email = uniqueEmail('nobody')
    const api = createClient()
    for (let i = 0; i < 6; i++) expectApiError(await signIn(api, email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')
    expectApiError(await signIn(api, email, WRONG), 429, 'RATE_LIMITED')
    // Unknown and known accounts alike: a fresh network gets one try, then the account backoff applies to it.
    const other = createClient()
    expectApiError(await signIn(other, email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')
    expectApiError(await signIn(other, email, WRONG), 429, 'RATE_LIMITED')
  })

  it('counts parallel guesses before checking them: 40 at once give 6 × 401, the rest 429 (F-016)', async () => {
    const user = await createUser()
    const api = createClient()
    const results = await Promise.all(Array.from({ length: 40 }, () => signIn(api, user.email, WRONG)))
    const statuses = results.map((res) => res.status)
    expect(statuses.filter((status) => status === 401)).toHaveLength(6)
    expect(statuses.filter((status) => status === 429)).toHaveLength(34)
    for (const res of results.filter((r) => r.status === 429)) {
      expectApiError(res, 429, 'RATE_LIMITED')
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    }
  })

  it('answers a flood with quick 429s instead of queueing every hash (bounded argon2 queue, F-016)', async () => {
    // One attempt per network, so neither the backoff nor the in-flight cap applies: only the hashing queue.
    const clients = Array.from({ length: 200 }, () => createClient())
    const flood = await Promise.all(clients.map((client) => signIn(client, uniqueEmail('flood'), WRONG)))
    const limited = flood.flatMap((res, i) => (res.status === 429 ? [{ res, client: clients[i]! }] : []))
    expect(limited.length).toBeGreaterThan(0)
    for (const { res } of limited) {
      expectApiError(res, 429, 'RATE_LIMITED')
      expect(res.headers.get('retry-after')).toBe('1')
    }
    for (const res of flood.filter((r) => r.status !== 429)) expectApiError(res, 401, 'AUTH_INVALID_CREDENTIALS')
    // A refused attempt was never checked, so it was given back: its network carries no failure.
    const network = limiterKeysForIp(normalizeIp(limited[0]!.client.ip)).net
    expect(await testDb().select().from(throttleTable).where(eq(throttleTable.key, network))).toEqual([])
  })

  it('throttles one IP across emails (ip:/net: key)', async () => {
    const api = createClient()
    for (let i = 0; i < 6; i++) await signIn(api, uniqueEmail('spray'), WRONG)
    const user = await createUser()
    expectApiError(await signIn(api, user.email, user.password), 429, 'RATE_LIMITED')
    // The same /64 counts as one client.
    const sibling = createClient({ ip: api.ip.replace(/::[0-9a-f]+$/, '::beef') })
    expectApiError(await signIn(sibling, user.email, user.password), 429, 'RATE_LIMITED')
    expect((await signIn(createClient(), user.email, user.password)).status).toBe(200)
  })

  it('reveals a disabled account only after the correct password', async () => {
    const user = await createUser({ disabled: true })
    expectApiError(await signIn(createClient(), user.email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')
    const res = await signIn(createClient(), user.email, user.password)
    expectApiError(res, 403, 'AUTH_ACCOUNT_DISABLED')
    expect(sessionCookie(res)).toBeUndefined()
  })

  it('lets unverified accounts sign in outside domain mode', async () => {
    const user = await createUser({ emailVerified: false })
    const res = await signIn(createClient(), user.email, user.password)
    expect(res.status).toBe(200)
    expect(res.body.user.emailVerified).toBe(false)
  })

  it('in domain mode: unverified → 403 AUTH_EMAIL_NOT_VERIFIED, one new verification mail per 10 minutes', async () => {
    await setRegistration('domain', ['example.test'])
    try {
      const user = await createUser({ email: uniqueDomainEmail('example.test'), emailVerified: false })
      expectApiError(await signIn(createClient(), user.email, WRONG), 401, 'AUTH_INVALID_CREDENTIALS')
      const first = await signIn(createClient(), user.email, user.password)
      expectApiError(first, 403, 'AUTH_EMAIL_NOT_VERIFIED')
      expect(sessionCookie(first)).toBeUndefined()
      const token = await mailToken(user.email, '/verify-email', /Confirm your email/)

      expectApiError(await signIn(createClient(), user.email, user.password), 403, 'AUTH_EMAIL_NOT_VERIFIED')
      await sleep(1_500)
      expect(await searchMessages(`to:"${user.email}"`)).toHaveLength(1)

      expect((await createClient().post('/api/auth/verify-email', { body: { token } })).status).toBe(200)
      const after = await signIn(createClient(), user.email, user.password)
      expect(after.status).toBe(200)
      expect(after.body.user.emailVerified).toBe(true)

      const verified = await createUser({ email: uniqueDomainEmail('example.test') })
      expect((await signIn(createClient(), verified.email, verified.password)).status).toBe(200)
    } finally {
      await resetRegistration()
    }
  })

  it('replaces the session the browser already had (rotation)', async () => {
    const [a, b] = [await createUser(), await createUser()]
    const api = await loginAs(a)
    const old = api.session!.id
    const res = await signIn(api, b.email, b.password)
    expect(res.status).toBe(200)
    const [row] = await testDb().select().from(sessions).where(eq(sessions.id, old))
    expect(row).toBeUndefined()
    expect((await api.get('/api/auth/me')).body.user.id).toBe(b.id)
  })

  it('validates the body', async () => {
    expectApiError(
      await createClient().post('/api/auth/login', { body: { email: 'not-an-email', password: 'x' } }),
      400,
      'VALIDATION_FAILED',
    )
    expectApiError(
      await createClient().post('/api/auth/login', { body: { email: uniqueEmail() } }),
      400,
      'VALIDATION_FAILED',
    )
  })
})
