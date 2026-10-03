/**
 * DB-backed server-core services, in-process against the test database: login backoff, settings, audit,
 * cleanup and retention (injected clocks; rows are unique per test).
 */
import { randomBytes } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { H3Error } from 'h3'
import { describe, expect, it } from 'vitest'
import { useDb } from '../../../server/database/client'
import { AdvisoryLockTimeoutError, withAdvisoryLocks } from '../../../server/utils/advisory-lock'
import {
  auditLog,
  callParticipants,
  emailTokens,
  guestSessions,
  loginThrottle,
  roomInvites,
  sessions,
  settings,
  userInvites,
} from '../../../server/database/schema'
import { audit } from '../../../server/services/audit/audit'
import { runRetention } from '../../../server/services/audit/retention'
import { runCleanup } from '../../../server/services/session/cleanup'
import {
  getSettings,
  getSystemFlag,
  invalidateSettingsCache,
  setSystemFlag,
  updateSettings,
} from '../../../server/services/settings/settings'
import { hashToken, randomToken } from '../../../server/utils/crypto'
import {
  clearAccountThrottle,
  clearLoginFailures,
  emailThrottleKey,
  loginAttemptKeys,
  refundAttempt,
  reserveAttempt,
} from '../../../server/utils/limiter'
import {
  createAdmin,
  createGuestSession,
  createInvite,
  createMeeting,
  createParticipant,
  createRoom,
  createRoomInvite,
  createSession,
  createUser,
  fakeEvent,
  testDb,
  uniqueEmail,
  uniqueIp,
  useServerEnvInProcess,
} from '../_harness'

useServerEnvInProcess()

const DAY = 24 * 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms)

describe('login backoff (login_throttle)', () => {
  const rowOf = async (key: string) => (await testDb().select().from(loginThrottle).where(eq(loginThrottle.key, key)))[0]

  it('reserves 5 free attempts, then waits 2^(n-5) s; refused attempts are not counted', async () => {
    const keys = [{ key: emailThrottleKey(uniqueEmail()) }]
    const now = new Date()
    for (let i = 0; i < 6; i++) expect((await reserveAttempt(keys, now)).allowed).toBe(true)
    expect(await reserveAttempt(keys, now)).toEqual({ allowed: false, retryAfterMs: 2_000 })
    expect((await rowOf(keys[0]!.key))!.failures).toBe(6)
    const later = new Date(now.getTime() + 2_000)
    expect((await reserveAttempt(keys, later)).allowed).toBe(true)
    expect(await reserveAttempt(keys, later)).toEqual({ allowed: false, retryAfterMs: 4_000 })
    await clearLoginFailures(keys.map((spec) => spec.key))
    expect(await rowOf(keys[0]!.key)).toBeUndefined()
  })

  it('serializes parallel attempts: 40 at once reserve exactly 6 (F-016)', async () => {
    const keys = loginAttemptKeys(uniqueEmail(), uniqueIp())
    const results = await Promise.all(Array.from({ length: 40 }, () => reserveAttempt(keys)))
    expect(results.filter((result) => result.allowed)).toHaveLength(6)
    for (const spec of keys) expect((await rowOf(spec.key))!.failures).toBe(6)
    await clearLoginFailures(keys.map((spec) => spec.key))
  })

  it('refunds an attempt: the wait it started and the row age come back, empty rows go', async () => {
    const network = { key: `ip:${uniqueIp(4)}-${randomBytes(4).toString('hex')}` }
    const start = ago(3_600_000)
    for (let i = 0; i < 5; i++) await reserveAttempt([network], start)
    const before = await rowOf(network.key)
    const decision = await reserveAttempt([network])
    expect(decision.allowed).toBe(true)
    expect((await rowOf(network.key))!.nextAllowedAt).not.toBeNull() // the 6th would start a wait
    if (decision.allowed) await refundAttempt(decision.reservation)
    expect(await rowOf(network.key)).toEqual(before)

    const fresh = { key: `ip:${randomBytes(8).toString('hex')}` }
    const once = await reserveAttempt([fresh])
    if (once.allowed) await refundAttempt(once.reservation)
    expect(await rowOf(fresh.key)).toBeUndefined()
    await clearLoginFailures([network.key])
  })

  it('forgets failures older than 24 h', async () => {
    const key = emailThrottleKey(uniqueEmail())
    for (let i = 0; i < 3; i++) await reserveAttempt([{ key }])
    await testDb().update(loginThrottle).set({ updatedAt: ago(25 * 3_600_000) }).where(eq(loginThrottle.key, key))
    await reserveAttempt([{ key }])
    expect((await rowOf(key))!.failures).toBe(1)
    await clearLoginFailures([key])
  })

  it('clears an account: its email key and network pair keys, not the network keys', async () => {
    const email = `under_score%${uniqueEmail()}`
    const keys = loginAttemptKeys(email, uniqueIp())
    const lookalike = loginAttemptKeys(`underXscoreX${email.slice('under_score%'.length)}`, uniqueIp())
    await reserveAttempt(keys)
    await reserveAttempt(lookalike)
    await clearAccountThrottle(email)
    expect(await rowOf(keys[0]!.key)).toBeDefined()
    expect(await rowOf(keys[1]!.key)).toBeUndefined()
    expect(await rowOf(keys[2]!.key)).toBeUndefined()
    // LIKE wildcards in the address are escaped.
    for (const spec of lookalike) expect(await rowOf(spec.key)).toBeDefined()
    await clearLoginFailures([...keys, ...lookalike].map((spec) => spec.key))
  })
})

describe('advisory locks without parked connections (F-046)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('serializes holders of a key, and its waiters never starve the pool', async () => {
    const key = `test:${randomBytes(8).toString('hex')}`
    const order: string[] = []
    const holder = withAdvisoryLocks(useDb(), [key], async () => {
      order.push('holder:start')
      await sleep(400)
      order.push('holder:end')
    })
    await sleep(50)
    // More waiters than the pool has connections (10).
    const waiters = Array.from({ length: 15 }, (_, i) =>
      withAdvisoryLocks(useDb(), [key], async () => void order.push(`waiter:${i}`)),
    )
    await sleep(50)
    const started = Date.now()
    await useDb().execute(sql`select 1`)
    expect(Date.now() - started).toBeLessThan(250) // a blocking lock would park all 10 connections until 400 ms
    await Promise.all([holder, ...waiters])
    expect(order.slice(0, 2)).toEqual(['holder:start', 'holder:end'])
    expect(order).toHaveLength(17)
  })

  it('gives up after waitMs with AdvisoryLockTimeoutError', async () => {
    const key = `test:${randomBytes(8).toString('hex')}`
    const holder = withAdvisoryLocks(useDb(), [key], () => sleep(300))
    await sleep(30)
    await expect(withAdvisoryLocks(useDb(), [key], async () => 'never', { waitMs: 80 })).rejects.toBeInstanceOf(
      AdvisoryLockTimeoutError,
    )
    await holder
    expect(await withAdvisoryLocks(useDb(), [key, `${key}:2`], async () => 'free again')).toBe('free again')
  })
})

describe('settings service', () => {
  it('writes only the sent keys, invalidates the cache and records the actor', async () => {
    const admin = await createAdmin()
    try {
      const before = await getSettings()
      const keysBefore = (await testDb().select({ key: settings.key }).from(settings)).map((r) => r.key)
      const at = new Date('2026-09-30T08:00:00Z')
      const next = await updateSettings({ 'limits.maxRoomsPerUser': 7 }, admin.id, at)
      expect(next['limits.maxRoomsPerUser']).toBe(7)
      expect(next['guests.allowed']).toBe(before['guests.allowed'])
      expect((await getSettings())['limits.maxRoomsPerUser']).toBe(7)
      const [row] = await testDb().select().from(settings).where(eq(settings.key, 'limits.maxRoomsPerUser'))
      expect(row).toMatchObject({ value: 7, updatedBy: admin.id, updatedAt: at }) // the injected clock (F-047)
      const rows = await testDb().select({ key: settings.key }).from(settings)
      expect(rows.map((r) => r.key).sort()).toEqual([...new Set([...keysBefore, 'limits.maxRoomsPerUser'])].sort())
    } finally {
      await testDb().delete(settings).where(eq(settings.key, 'limits.maxRoomsPerUser'))
      invalidateSettingsCache()
    }
  })

  it('rejects invalid patches with VALIDATION_FAILED', async () => {
    for (const patch of [{ 'limits.maxRoomsPerUser': 0 }, { 'system.bootstrapDone': true }, { unknown: 1 }]) {
      const error = await updateSettings(patch, null).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(H3Error)
      expect((error as H3Error).data).toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })

  it('keeps system flags out of getSettings', async () => {
    const key = `system.test_${randomBytes(4).toString('hex')}` as const
    try {
      const at = new Date('2026-09-30T08:00:00Z')
      await setSystemFlag(key, { on: true }, undefined, at)
      expect((await testDb().select().from(settings).where(eq(settings.key, key)))[0]!.updatedAt).toEqual(at)
      expect(await getSystemFlag(key)).toEqual({ on: true })
      invalidateSettingsCache()
      expect(JSON.stringify(await getSettings())).not.toContain(key)
    } finally {
      await testDb().delete(settings).where(eq(settings.key, key))
    }
  })
})

describe('audit', () => {
  it('records the action, the client IP, the signed-in actor and redacted details', async () => {
    const user = await createUser()
    const session = await createSession(user.id)
    const targetId = randomToken(8)
    await audit(fakeEvent({ cookie: session.cookie, ip: '203.0.113.77' }), {
      action: 'test.audit_write',
      targetType: 'thing',
      targetId,
      details: { password: 'hunter2', note: 'ok' },
    })
    await audit(null, { action: 'test.audit_write', targetType: 'thing', targetId, actorUserId: null })
    const rows = await testDb().select().from(auditLog).where(eq(auditLog.targetId, targetId))
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.actorUserId === user.id)).toMatchObject({
      ip: '203.0.113.77',
      details: { password: '[redacted]', note: 'ok' },
    })
    expect(rows.find((r) => r.actorUserId === null)).toMatchObject({ ip: null, details: null })
  })
})

describe('maintenance tasks', () => {
  it('cleanup deletes expired and stale rows and keeps live ones', async () => {
    const user = await createUser()
    const expired = await createSession(user.id, { expiresAt: ago(1_000) })
    const idle = await createSession(user.id, { createdAt: ago(9 * DAY), lastSeenAt: ago(8 * DAY) })
    const live = await createSession(user.id)
    const room = await createRoom(user)
    const oldGuest = await createGuestSession(room, { expiresAt: ago(1_000) })
    const liveGuest = await createGuestSession(room)
    const oldInvite = await createInvite({ expiresAt: ago(31 * DAY) })
    const freshInvite = await createInvite()
    const revokedRoomInvite = await createRoomInvite(room)
    await testDb().update(roomInvites).set({ revokedAt: ago(31 * DAY) }).where(eq(roomInvites.id, revokedRoomInvite.id))
    const liveRoomInvite = await createRoomInvite(room, { expiresAt: null })
    const [usedToken] = await testDb()
      .insert(emailTokens)
      .values({ userId: user.id, purpose: 'verify_email', tokenHash: hashToken(randomToken()), expiresAt: new Date(Date.now() + DAY), usedAt: ago(1_000) })
      .returning()
    const staleKey = emailThrottleKey(uniqueEmail())
    await testDb().insert(loginThrottle).values({ key: staleKey, failures: 3, updatedAt: ago(25 * 3_600_000) })

    const result = await runCleanup()
    expect(result.sessions).toBeGreaterThanOrEqual(2)

    const remainingSessions = await testDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(inArray(sessions.id, [expired.id, idle.id, live.id]))
    expect(remainingSessions.map((s) => s.id)).toEqual([live.id])
    const guests = await testDb().select({ id: guestSessions.id }).from(guestSessions).where(inArray(guestSessions.id, [oldGuest.id, liveGuest.id]))
    expect(guests.map((g) => g.id)).toEqual([liveGuest.id])
    const invites = await testDb().select({ id: userInvites.id }).from(userInvites).where(inArray(userInvites.id, [oldInvite.id, freshInvite.id]))
    expect(invites.map((i) => i.id)).toEqual([freshInvite.id])
    const roomInviteRows = await testDb()
      .select({ id: roomInvites.id })
      .from(roomInvites)
      .where(inArray(roomInvites.id, [revokedRoomInvite.id, liveRoomInvite.id]))
    expect(roomInviteRows.map((i) => i.id)).toEqual([liveRoomInvite.id])
    expect(await testDb().select().from(emailTokens).where(eq(emailTokens.id, usedToken!.id))).toHaveLength(0)
    expect(await testDb().select().from(loginThrottle).where(eq(loginThrottle.key, staleKey))).toHaveLength(0)
  })

  it('retention erases old IP addresses and deletes old audit entries', async () => {
    const user = await createUser()
    const targetId = randomToken(8)
    const [oldAudit, agedAudit, newAudit] = await testDb()
      .insert(auditLog)
      .values([
        { action: 'test.retention', targetId, ip: '203.0.113.1', at: ago(200 * DAY) },
        { action: 'test.retention', targetId, ip: '203.0.113.2', at: ago(40 * DAY) },
        { action: 'test.retention', targetId, ip: '203.0.113.3', at: ago(DAY) },
      ])
      .returning()
    const oldSession = await createSession(user.id, { createdAt: ago(40 * DAY), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + DAY), ip: '203.0.113.4' })
    const room = await createRoom(user)
    const meeting = await createMeeting(room)
    const participant = await createParticipant({ room, meeting, userId: user.id })
    await testDb().update(callParticipants).set({ ip: '203.0.113.5', createdAt: ago(40 * DAY) }).where(eq(callParticipants.id, participant.id))

    await runRetention(new Date(), testDb(), { 'privacy.ipRetentionDays': 30, 'audit.retentionDays': 180 })

    const auditRows = await testDb().select().from(auditLog).where(eq(auditLog.targetId, targetId))
    expect(auditRows.map((r) => r.id).sort()).toEqual([agedAudit!.id, newAudit!.id].sort())
    expect(auditRows.find((r) => r.id === agedAudit!.id)!.ip).toBeNull()
    expect(auditRows.find((r) => r.id === newAudit!.id)!.ip).toBe('203.0.113.3')
    expect(oldAudit).toBeDefined()
    const [sessionRow] = await testDb().select().from(sessions).where(eq(sessions.id, oldSession.id))
    expect(sessionRow!.ip).toBeNull()
    const [participantRow] = await testDb().select().from(callParticipants).where(eq(callParticipants.id, participant.id))
    expect(participantRow!.ip).toBeNull()
  })
})
