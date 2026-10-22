/**
 * Password reset by email: the Mailpit link, single use, expiry, all sessions revoked, 503 without SMTP, and no
 * enumeration (unknown and disabled accounts get the same 202 and no mail).
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { users } from '../../../server/database/schema'
import {
  apiBaseUrl,
  createClient,
  createUser,
  expectApiError,
  expectNoMessage,
  loginAs,
  searchMessages,
  testDb,
  type TestServer,
  uniqueEmail,
  waitForMessage,
} from '../_harness'
import {
  auditRows,
  expireEmailToken,
  mailToken,
  sessionCookie,
  signIn,
  sleep,
  startExtraServer,
  WITHOUT_SMTP,
} from './support'

const NEW_PASSWORD = 'saffron-glacier-pylon-64'
const SUBJECT = /Reset your/
const request = (email: string, client = createClient()) =>
  client.post('/api/auth/password-reset/request', { body: { email } })
const confirm = (token: string, newPassword = NEW_PASSWORD) =>
  createClient().post('/api/auth/password-reset/confirm', { body: { token, newPassword } })

describe('password reset', () => {
  it('mails a single-use link from PUBLIC_URL; confirming sets the password and revokes every session', async () => {
    const user = await createUser({ mustChangePassword: true, emailVerified: false })
    const [a, b] = [await loginAs(user), await loginAs(user)]

    const res = await request(user.email.toUpperCase())
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true })
    const mail = await waitForMessage(user.email, { subject: SUBJECT })
    expect(mail.Text).toContain(`${apiBaseUrl()}/reset-password#`)
    expect(mail.Text).not.toMatch(/[?&]token=/)
    const token = await mailToken(user.email, '/reset-password', SUBJECT)

    const done = await confirm(token)
    expect(done.status, done.text).toBe(200)
    expect(done.body).toEqual({ ok: true })
    expect(sessionCookie(done)).toBeUndefined() // does not sign in

    for (const client of [a, b]) expect((await client.get('/api/auth/me')).body.user).toBeNull()
    expectApiError(await signIn(createClient(), user.email, user.password), 401, 'AUTH_INVALID_CREDENTIALS')
    const login = await signIn(createClient(), user.email, NEW_PASSWORD)
    expect(login.status).toBe(200)
    expect(login.body.user).toMatchObject({ mustChangePassword: false, emailVerified: true })

    expectApiError(await confirm(token, 'another-strong-passphrase-91'), 400, 'AUTH_TOKEN_INVALID')
    expect(await auditRows({ action: 'auth.password_reset_requested', targetId: user.id })).toHaveLength(1)
    expect(await auditRows({ action: 'auth.password_reset', targetId: user.id })).toHaveLength(1)
  })

  it('answers unknown and disabled accounts identically and mails nothing (no enumeration)', async () => {
    const existing = await createUser()
    const disabled = await createUser({ disabled: true })
    const unknown = uniqueEmail('nobody')
    const answers = await Promise.all([request(existing.email), request(disabled.email), request(unknown)])
    for (const res of answers) {
      expect(res.status).toBe(202)
      expect(res.text).toBe(answers[0]!.text)
      expect(res.headers.get('content-length')).toBe(answers[0]!.headers.get('content-length'))
    }
    await waitForMessage(existing.email, { subject: SUBJECT })
    await expectNoMessage(disabled.email)
    await expectNoMessage(unknown, 200)
  })

  it('rejects expired links with AUTH_TOKEN_EXPIRED and unknown ones with AUTH_TOKEN_INVALID', async () => {
    const user = await createUser()
    await request(user.email)
    const token = await mailToken(user.email, '/reset-password', SUBJECT)
    await expireEmailToken(token)
    expectApiError(await confirm(token), 400, 'AUTH_TOKEN_EXPIRED')
    expectApiError(await confirm('Q'.repeat(43)), 400, 'AUTH_TOKEN_INVALID')
    expectApiError(await confirm('not-a-token'), 400, 'VALIDATION_FAILED')
    expect((await signIn(createClient(), user.email, user.password)).status).toBe(200)
  })

  it('checks the password policy before spending the token', async () => {
    const user = await createUser()
    await request(user.email)
    const token = await mailToken(user.email, '/reset-password', SUBJECT)
    const weak = await confirm(token, 'password1234')
    expectApiError(weak, 400, 'AUTH_PASSWORD_WEAK')
    expect((await confirm(token)).status).toBe(200)
  })

  it('invalidates older links when a new one is requested', async () => {
    const user = await createUser()
    await request(user.email)
    const first = await mailToken(user.email, '/reset-password', SUBJECT)
    await request(user.email)
    let second = first
    for (let i = 0; i < 50 && second === first; i++) {
      await sleep(100)
      const messages = await searchMessages(`to:"${user.email}"`)
      if (messages.length > 1) second = await mailToken(user.email, '/reset-password', SUBJECT)
    }
    expect(second).not.toBe(first)
    expectApiError(await confirm(first), 400, 'AUTH_TOKEN_INVALID')
    expect((await confirm(second)).status).toBe(200)
  })

  it('sends at most 3 mails per address and hour, silently (reset-email limiter)', async () => {
    const user = await createUser()
    for (let i = 0; i < 5; i++) expect((await request(user.email)).status).toBe(202)
    await sleep(1_500)
    expect(await searchMessages(`to:"${user.email}"`)).toHaveLength(3)
  })

  it('clears the login backoff of the account', async () => {
    const user = await createUser()
    // 9 networks fail once each: the account waits 16 s for every network that already failed for it.
    const clients = Array.from({ length: 9 }, () => createClient())
    for (const client of clients) await signIn(client, user.email, 'wrong-password-000')
    expectApiError(await signIn(clients[0]!, user.email, user.password), 429, 'RATE_LIMITED')
    await request(user.email)
    expect((await confirm(await mailToken(user.email, '/reset-password', SUBJECT))).status).toBe(200)
    expect((await signIn(clients[0]!, user.email, NEW_PASSWORD)).status).toBe(200)
  })
})

describe('password reset without SMTP', () => {
  let server: TestServer

  beforeAll(async () => {
    server = await startExtraServer('no-smtp-reset', WITHOUT_SMTP)
  })

  afterAll(async () => {
    await server?.stop()
  })

  it('answers 503 SERVICE_UNAVAILABLE for every address and sends nothing', async () => {
    const user = await createUser()
    const api = createClient({ baseUrl: server.baseUrl })
    for (const email of [user.email, uniqueEmail()]) {
      expectApiError(
        await api.post('/api/auth/password-reset/request', { body: { email } }),
        503,
        'SERVICE_UNAVAILABLE',
      )
    }
    await expectNoMessage(user.email, 500)
    const [row] = await testDb().select().from(users).where(eq(users.id, user.id))
    expect(row).toBeDefined()
  })
})
