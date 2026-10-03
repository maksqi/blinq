/**
 * The users service the Stage 03 admin handlers build on (in-process against the test database): admin-created
 * accounts with temporary passwords, updates (rename, disable, role change with session rotation), admin resets,
 * session revocation, deletion, listing. Last-admin rules run on their own database: tests/api/auth/last-admin.test.ts.
 */
import { eq, inArray } from 'drizzle-orm'
import { H3Error } from 'h3'
import { describe, expect, it } from 'vitest'
import { callParticipants, loginThrottle, sessions, users } from '../../../server/database/schema'
import { createSession, validateSession } from '../../../server/services/session/sessions'
import {
  createUserByAdmin,
  deleteUser,
  getAdminUser,
  listAccountInvites,
  listUsers,
  resetPasswordByAdmin,
  revokeUserSessions,
  setUserDisabled,
  updateUserByAdmin,
  changeUserRole,
  createAccountInvite,
  type AdminActor,
} from '../../../server/services/users'
import { hashToken } from '../../../server/utils/crypto'
import { subscribeTo } from '../../../server/utils/event-bus'
import {
  createAdmin,
  createClient,
  createMeeting,
  createParticipant,
  createRoom,
  createUser,
  fakeEvent,
  loginAs,
  testDb,
  uniqueEmail,
  useServerEnvInProcess,
  waitForMessage,
} from '../_harness'
import { auditRows, signIn } from './support'

useServerEnvInProcess()

async function actor(options: { event?: AdminActor['event'] } = {}): Promise<AdminActor & { id: string }> {
  const admin = await createAdmin()
  return {
    id: admin.id,
    user: { id: admin.id, role: 'admin', displayName: admin.displayName },
    event: options.event ?? null,
  }
}

async function codeOf(promise: Promise<unknown>): Promise<{ code?: string; details?: unknown } | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof H3Error) return error.data as { code?: string; details?: unknown }
    throw error
  }
  return undefined
}

function watchRevoked() {
  const ids: string[] = []
  const off = subscribeTo('user.revoked', (event) => ids.push(event.userId))
  return { ids, off }
}

describe('createUserByAdmin', () => {
  it('creates an account with a temporary password shown once; the account must change it', async () => {
    const admin = await actor()
    const email = uniqueEmail('created')
    const created = await createUserByAdmin(
      { email: email.toUpperCase(), displayName: 'Made By Admin', role: 'user' },
      admin,
    )
    expect(created.emailed).toBe(false)
    expect(created.tempPassword).toMatch(/^[A-Za-z0-9]{16}$/)
    expect(created.user).toMatchObject({
      email,
      role: 'user',
      mustChangePassword: true,
      emailVerified: true,
      disabled: false,
      roomCount: 0,
    })
    const login = await signIn(createClient(), email, created.tempPassword!)
    expect(login.body.user.mustChangePassword).toBe(true)
    expect(await auditRows({ action: 'admin.user_created', targetId: created.user.id })).toHaveLength(1)

    expect(await codeOf(createUserByAdmin({ email, displayName: 'Again' }, admin))).toEqual({
      code: 'CONFLICT',
      details: { reason: 'email_taken' },
    })
  })

  it('mails the temporary password instead when asked', async () => {
    const admin = await actor()
    const email = uniqueEmail('mailed')
    const created = await createUserByAdmin({ email, displayName: 'Mailed', sendEmail: true }, admin)
    expect(created).toMatchObject({ tempPassword: null, emailed: true })
    const mail = await waitForMessage(email, { subject: /account is ready/ })
    const temp = mail.Text.match(/Temporary password: ([A-Za-z0-9]{16})/)?.[1]
    expect(temp).toBeDefined()
    expect(mail.Text).toContain('/login')
    expect((await signIn(createClient(), email, temp!)).status).toBe(200)
  })
})

describe('updateUserByAdmin', () => {
  it('renames without touching sessions and audits only real changes', async () => {
    const admin = await actor()
    const user = await createUser()
    const api = await loginAs(user)
    const renamed = await updateUserByAdmin(user.id, { displayName: 'Renamed Person' }, admin)
    expect(renamed.displayName).toBe('Renamed Person')
    expect((await api.get('/api/auth/me')).body.user.displayName).toBe('Renamed Person')
    await updateUserByAdmin(user.id, { displayName: 'Renamed Person' }, admin) // no-op
    const rows = await auditRows({ action: 'admin.user_updated', targetId: user.id })
    expect(rows.map((r) => r.details)).toEqual([{ fields: ['displayName'] }])
  })

  it('disabling revokes every session and publishes user.revoked; enabling lets the user back in', async () => {
    const admin = await actor()
    const user = await createUser()
    const api = await loginAs(user)
    const revoked = watchRevoked()
    try {
      const disabled = await setUserDisabled(user.id, true, admin)
      expect(disabled.disabled).toBe(true)
    } finally {
      revoked.off()
    }
    expect(revoked.ids).toEqual([user.id])
    expect((await api.get('/api/auth/me')).body.user).toBeNull()
    expect(await testDb().select().from(sessions).where(eq(sessions.userId, user.id))).toEqual([])
    expect((await signIn(createClient(), user.email, user.password)).body.data.code).toBe('AUTH_ACCOUNT_DISABLED')
    await setUserDisabled(user.id, false, admin)
    expect((await signIn(createClient(), user.email, user.password)).status).toBe(200)
  })

  it('refuses to let admins disable themselves', async () => {
    const admin = await actor()
    expect(await codeOf(setUserDisabled(admin.id, true, admin))).toEqual({
      code: 'CONFLICT',
      details: { reason: 'self' },
    })
  })

  it("rotates on a role change: the target's sessions are revoked", async () => {
    const admin = await actor()
    const user = await createUser()
    const api = await loginAs(user)
    const promoted = await changeUserRole(user.id, 'admin', admin)
    expect(promoted.role).toBe('admin')
    expect((await api.get('/api/auth/me')).body.user).toBeNull()
    const login = await signIn(createClient(), user.email, user.password)
    expect(login.body.user.role).toBe('admin')
    expect(await auditRows({ action: 'admin.user_updated', targetId: user.id })).toMatchObject([
      { details: { fields: ['role'], role: 'admin' } },
    ])
  })

  it("rotates the caller's own session in place on self-demotion (another admin exists)", async () => {
    await createAdmin() // someone stays admin
    const self = await createAdmin()
    const token = await createSession(self.id)
    const other = await createSession(self.id)
    const event = fakeEvent({ cookie: `blinq_session=${token}`, method: 'PATCH' })
    await updateUserByAdmin(self.id, { role: 'user' }, { user: { id: self.id, role: 'admin' }, event })
    const cookie = String(event.node.res.getHeader('set-cookie'))
    const rotated = cookie.match(/^blinq_session=([A-Za-z0-9_-]{43});/)?.[1]
    expect(rotated).toBeDefined()
    expect(await validateSession(token)).toBeNull()
    expect(await validateSession(other)).toBeNull()
    expect((await validateSession(rotated!))?.user.role).toBe('user')
  })

  it('answers 404 for unknown users', async () => {
    const admin = await actor()
    expect(
      (await codeOf(updateUserByAdmin('0192d2f4-7a3b-7cde-8f01-23456789abcd', { displayName: 'X' }, admin)))?.code,
    ).toBe('NOT_FOUND')
    expect((await codeOf(updateUserByAdmin('nope', { displayName: 'X' }, admin)))?.code).toBe('NOT_FOUND')
  })
})

describe('resetPasswordByAdmin', () => {
  it('sets a temporary password, forces a change, revokes sessions and clears the login backoff', async () => {
    const admin = await actor()
    const user = await createUser()
    const api = await loginAs(user)
    const wrong = createClient()
    for (let i = 0; i < 6; i++) await signIn(wrong, user.email, 'wrong-password-yy')
    const result = await resetPasswordByAdmin(user.id, {}, admin)
    expect(result).toMatchObject({ emailed: false })
    expect(result.tempPassword).toMatch(/^[A-Za-z0-9]{16}$/)
    expect((await api.get('/api/auth/me')).body.user).toBeNull()
    expect(
      await testDb()
        .select()
        .from(loginThrottle)
        .where(eq(loginThrottle.key, `email:${user.email}`)),
    ).toEqual([])
    expect((await signIn(createClient(), user.email, user.password)).status).toBe(401)
    const login = await signIn(createClient(), user.email, result.tempPassword!)
    expect(login.body.user.mustChangePassword).toBe(true)
    expect(await auditRows({ action: 'admin.user_password_reset', targetId: user.id })).toHaveLength(1)
  })

  it('mails the temporary password when asked', async () => {
    const admin = await actor()
    const user = await createUser()
    expect(await resetPasswordByAdmin(user.id, { sendEmail: true }, admin)).toEqual({
      tempPassword: null,
      emailed: true,
    })
    const mail = await waitForMessage(user.email, { subject: /password was reset/ })
    expect(mail.Text).toMatch(/Temporary password: [A-Za-z0-9]{16}/)
  })
})

describe('revokeUserSessions and deleteUser', () => {
  it('revokes all sessions of a user', async () => {
    const admin = await actor()
    const user = await createUser()
    await loginAs(user)
    await loginAs(user)
    expect(await revokeUserSessions(user.id, admin)).toEqual({ revoked: 2 })
    expect(await auditRows({ action: 'admin.user_sessions_revoked', targetId: user.id })).toMatchObject([
      { details: { revoked: 2 } },
    ])
  })

  it('deletes a user after the cleanup hook; the row and its sessions are gone', async () => {
    const admin = await actor()
    const user = await createUser()
    const api = await loginAs(user)
    await createRoom(user)
    const cleaned: string[] = []
    const revoked = watchRevoked()
    try {
      await deleteUser(user.id, admin, { beforeDelete: async (row) => void cleaned.push(row.id) })
    } finally {
      revoked.off()
    }
    expect(cleaned).toEqual([user.id])
    expect(revoked.ids).toEqual([user.id])
    expect(await testDb().select().from(users).where(eq(users.id, user.id))).toEqual([])
    expect((await api.get('/api/auth/me')).body.user).toBeNull()
    expect(await auditRows({ action: 'admin.user_deleted', targetId: user.id })).toMatchObject([
      { details: { email: user.email } },
    ])
    expect((await codeOf(deleteUser(user.id, admin)))?.code).toBe('NOT_FOUND')
  })

  it('refuses to delete the own account', async () => {
    const admin = await actor()
    expect(await codeOf(deleteUser(admin.id, admin))).toEqual({ code: 'CONFLICT', details: { reason: 'self' } })
  })

  it('takes the user out of live calls before the row goes, without any cleanup hook (F-001)', async () => {
    const admin = await actor()
    const user = await createUser()
    const room = await createRoom(await createUser())
    const meeting = await createMeeting(room)
    const joined = await createParticipant({ room, meeting, userId: user.id, status: 'joined' })
    const waiting = await createParticipant({ room, meeting, userId: user.id, status: 'waiting' })
    let statusesWhenRemoved: string[] = []
    await deleteUser(user.id, admin, {
      beforeDelete: async () => {
        // The users service already ran the removal, while the rows still carried the user id.
        statusesWhenRemoved = (
          await testDb()
            .select({ status: callParticipants.status })
            .from(callParticipants)
            .where(eq(callParticipants.userId, user.id))
        ).map((row) => row.status)
      },
    })
    expect(statusesWhenRemoved).toEqual(['left', 'left'])
    const rows = await testDb()
      .select({ id: callParticipants.id, status: callParticipants.status, userId: callParticipants.userId })
      .from(callParticipants)
      .where(inArray(callParticipants.id, [joined.id, waiting.id]))
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ status: 'left', userId: null })
  })
})

describe('listing', () => {
  it('lists users with filters and room counts', async () => {
    const marker = `list-${Date.now()}`
    const alice = await createUser({ email: uniqueEmail(marker), displayName: 'Alice Lister' })
    const bob = await createUser({ email: uniqueEmail(marker), disabled: true })
    await createRoom(alice)
    await createRoom(alice)
    const page = await listUsers({ page: 1, pageSize: 10, q: marker })
    expect(page.total).toBe(2)
    expect(page.items.map((u) => u.id).sort()).toEqual([alice.id, bob.id].sort())
    expect(page.items.find((u) => u.id === alice.id)?.roomCount).toBe(2)
    expect((await listUsers({ page: 1, pageSize: 10, q: marker, status: 'disabled' })).items.map((u) => u.id)).toEqual([
      bob.id,
    ])
    expect((await listUsers({ page: 1, pageSize: 10, q: marker, role: 'admin' })).total).toBe(0)
    expect((await getAdminUser(alice.id)).roomCount).toBe(2)
    // LIKE wildcards in q are literal.
    expect(
      (await listUsers({ page: 1, pageSize: 10, q: '%_%' })).items.every((u) => /%|_/.test(u.email + u.displayName)),
    ).toBe(true)
  })

  it('lists invites newest first without tokens', async () => {
    const admin = await actor()
    const email = uniqueEmail('invite-list')
    const created = await createAccountInvite({ email, role: 'user', expiresIn: '30d' }, admin)
    const page = await listAccountInvites({ page: 1, pageSize: 5, q: email })
    expect(page.items).toEqual([
      {
        id: created.id,
        email,
        role: 'user',
        expiresAt: created.expiresAt,
        usedAt: null,
        revoked: false,
        createdAt: created.createdAt,
        createdBy: admin.id,
      },
    ])
    expect(JSON.stringify(page)).not.toContain(created.token)
    expect(JSON.stringify(page)).not.toContain(hashToken(created.token))
  })
})
