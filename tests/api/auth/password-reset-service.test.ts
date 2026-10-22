/**
 * Password reset requests, in-process against the test database (F-024): the response path does the same work for
 * every address (limiter, then hand-off), and everything that depends on the account runs after it.
 */
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { emailTokens } from '../../../server/database/schema'
import { requestPasswordReset, type BackgroundRunner } from '../../../server/services/auth/password-reset'
import { normalizeIp } from '../../../server/utils/client-ip'
import { createUser, fakeEvent, testDb, uniqueEmail, uniqueIp, useServerEnvInProcess, waitForMessage } from '../_harness'
import { auditRows } from './support'

useServerEnvInProcess()

const resetTokens = (userId: string) =>
  testDb()
    .select()
    .from(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, 'reset_password')))

function capture() {
  const jobs: Array<() => Promise<unknown>> = []
  const background: BackgroundRunner = (_label, job) => void jobs.push(job)
  return { jobs, background }
}

describe('requestPasswordReset', () => {
  it('answers before touching the account: known and unknown addresses hand off the same job', async () => {
    const user = await createUser()
    const disabled = await createUser({ disabled: true })
    const ip = uniqueIp()
    const { jobs, background } = capture()
    for (const email of [user.email, disabled.email, uniqueEmail('nobody')]) {
      await requestPasswordReset(fakeEvent({ ip }), email, { background })
    }
    expect(jobs).toHaveLength(3)
    // Nothing account-dependent ran on the response path.
    expect(await resetTokens(user.id)).toHaveLength(0)
    expect(await auditRows({ action: 'auth.password_reset_requested', targetId: user.id })).toHaveLength(0)

    const outcomes = await Promise.all(jobs.map((job) => job()))
    expect(outcomes).toEqual([true, false, false])
    expect(await resetTokens(user.id)).toHaveLength(1)
    expect(await resetTokens(disabled.id)).toHaveLength(0)
    const [entry] = await auditRows({ action: 'auth.password_reset_requested', targetId: user.id })
    expect(entry!.ip).toBe(normalizeIp(ip)) // taken on the response path, written later
    await waitForMessage(user.email, { subject: /Reset your/ })
  })

  it('runs the jobs of one address in order, so the newest request holds the only link', async () => {
    const user = await createUser()
    const { jobs, background } = capture()
    await requestPasswordReset(fakeEvent({ ip: uniqueIp() }), user.email, { background })
    await requestPasswordReset(fakeEvent({ ip: uniqueIp() }), user.email, { background })
    await Promise.all(jobs.map((job) => job()))
    expect(await resetTokens(user.id)).toHaveLength(1)
  })
})
