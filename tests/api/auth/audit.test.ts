/**
 * Every auth mutation writes its documented audit action (table-driven), and nothing secret goes into the entry.
 * Admin actions are covered by users-service.test.ts; zz-audit-summary.test.ts records the totals of a whole run.
 */
import { describe, expect, it } from 'vitest'
import { createClient, createInvite, createUser, loginAs, uniqueEmail, uniqueName } from '../_harness'
import { auditRows, createEmailToken, mailToken, signIn } from './support'

const PASSWORD = 'lilac-anchor-pebble-35'

describe('audit entries', () => {
  it.each([
    [
      'auth.login',
      async () => {
        const user = await createUser()
        await signIn(createClient(), user.email, user.password)
        return { targetId: user.id }
      },
    ],
    [
      'auth.login_failed',
      async () => {
        const user = await createUser({ disabled: true })
        await signIn(createClient(), user.email, user.password)
        return { targetId: user.id }
      },
    ],
    [
      'auth.logout',
      async () => {
        const user = await createUser()
        await (await loginAs(user)).post('/api/auth/logout')
        return { targetId: user.id }
      },
    ],
    [
      'auth.password_changed',
      async () => {
        const user = await createUser()
        await (
          await loginAs(user)
        ).post('/api/auth/password', { body: { currentPassword: user.password, newPassword: PASSWORD } })
        return { targetId: user.id }
      },
    ],
    [
      'auth.email_verified',
      async () => {
        const user = await createUser({ emailVerified: false })
        await createClient().post('/api/auth/verify-email', {
          body: { token: await createEmailToken(user.id, 'verify_email') },
        })
        return { targetId: user.id }
      },
    ],
    [
      'auth.password_reset_requested',
      async () => {
        const user = await createUser()
        await createClient().post('/api/auth/password-reset/request', { body: { email: user.email } })
        // Written after the response (F-024), before the mail goes out.
        await mailToken(user.email, '/reset-password', /Reset your/)
        return { targetId: user.id }
      },
    ],
    [
      'auth.password_reset',
      async () => {
        const user = await createUser()
        await createClient().post('/api/auth/password-reset/request', { body: { email: user.email } })
        const token = await mailToken(user.email, '/reset-password', /Reset your/)
        await createClient().post('/api/auth/password-reset/confirm', { body: { token, newPassword: PASSWORD } })
        return { targetId: user.id }
      },
    ],
    [
      'auth.invite_accepted',
      async () => {
        const invite = await createInvite()
        await createClient().post('/api/auth/invites/accept', {
          body: { token: invite.token, email: uniqueEmail(), displayName: uniqueName('A'), password: PASSWORD },
        })
        return { targetId: invite.id }
      },
    ],
    [
      'auth.session_revoked',
      async () => {
        const user = await createUser()
        const [api, other] = [await loginAs(user), await loginAs(user)]
        await api.delete(`/api/auth/sessions/${other.session!.id}`)
        return { targetId: other.session!.id }
      },
    ],
    [
      'user.profile_updated',
      async () => {
        const user = await createUser()
        await (await loginAs(user)).patch('/api/me', { body: { displayName: uniqueName('Renamed') } })
        return { targetId: user.id }
      },
    ],
  ] as const)('%s', async (action, run) => {
    const { targetId } = await run()
    const rows = await auditRows({ action, targetId })
    expect(rows, action).toHaveLength(1)
    expect(JSON.stringify(rows[0]!.details ?? {})).not.toMatch(new RegExp(PASSWORD))
    expect(rows[0]!.ip, 'the client IP is recorded').toBeTruthy()
  })
})
