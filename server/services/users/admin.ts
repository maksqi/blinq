/**
 * User management for admins (auth; the Stage 03 `admin` handlers call these). Every mutation writes exactly one
 * audit entry inside its transaction; handlers must not write another. `actor` is `{ user: await requireAdmin(event),
 * event }`.
 *
 * - `listUsers(query)` → `Paginated<AdminUser>` (`adminUsersQuerySchema` output: `q` over email and name, `role`,
 *   `status`), newest first.
 * - `getAdminUser(id)` → `AdminUser`; 404 `NOT_FOUND`.
 * - `createUserByAdmin(input, actor)` → `{ user, tempPassword, emailed }` (`adminCreateUserSchema` output). A
 *   16-character temporary password, `must_change_password`, email counted as verified (decision). With `sendEmail`
 *   the password is emailed instead of returned (`tempPassword: null`); SMTP off or failing → 503
 *   `SERVICE_UNAVAILABLE` (`details.smtpError`) and nothing is created. Existing email → 409 `CONFLICT`
 *   (`email_taken`). Audit `admin.user_created`.
 * - `updateUserByAdmin(id, patch, actor)` → `AdminUser` (`adminUpdateUserSchema` output: `displayName`, `role`,
 *   `disabled`). Audit `admin.user_updated` with `details.fields` (only changed fields; no-op patches write nothing).
 *   - Disabling revokes every session and publishes `user.revoked` (live calls end). Admins cannot disable themselves
 *     (409 `CONFLICT`, `self`) (decision).
 *   - A role change rotates sessions (docs/SECURITY.md §4): another user's sessions are revoked (they sign in again;
 *     `user.revoked` is published); the caller's own current session is rotated in place (new cookie on
 *     `actor.event`) and their other sessions revoked.
 *   - Demoting or disabling the last enabled admin → 409 `CONFLICT` (`last_admin`), serialized with row locks.
 *   Shorthands: `setUserDisabled(id, disabled, actor)`, `changeUserRole(id, role, actor)`, `renameUser(id, name, actor)`.
 * - `resetPasswordByAdmin(id, { sendEmail }, actor)` → `{ tempPassword, emailed }`: new temporary password,
 *   `must_change_password`, all sessions revoked (`user.revoked`), login backoff of the email cleared. `sendEmail`
 *   mails it instead (503 as above). Audit `admin.user_password_reset`.
 * - `revokeUserSessions(id, actor)` → `{ revoked }`: all sessions, `user.revoked`. Audit `admin.user_sessions_revoked`.
 * - `deleteUser(id, actor, { beforeDelete })`: 409 `CONFLICT` for `self` and `last_admin`, 404 `NOT_FOUND`.
 *   After the checks the user leaves every live call (`removeUserFromLiveCalls`, while their rows still carry the user
 *   id), then `beforeDelete(user)` runs (end live meetings, delete recording files: the rows cascade, the files would
 *   not). Then the row is deleted (sessions, identities, rooms, recordings cascade), `user.revoked` is published.
 *   Audit `admin.user_deleted` (email kept in `details`).
 */
import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import {
  adminCreateUserSchema,
  adminUpdateUserSchema,
  type AdminUser,
  type adminUsersQuerySchema,
  type CreatedUserCredentials,
} from '#shared/schemas/admin'
import type { UserRole } from '#shared/schemas/auth'
import type { Paginated } from '#shared/schemas/common'
import { useDb, type Tx } from '../../database/client'
import { authIdentities, rooms, users } from '../../database/schema'
import { apiError } from '../../utils/api-error'
import { setSessionCookie } from '../../utils/cookies'
import { getAuth } from '../../utils/auth'
import { eventBus } from '../../utils/event-bus'
import { clearAccountThrottle } from '../../utils/limiter'
import { hashPassword } from '../../utils/password'
import { audit } from '../audit/audit'
import { removeUserFromLiveCalls } from '../calls/revocation'
import { tempPasswordMessage } from '../mail/messages'
import { isSmtpConfigured, sendMailOr503 } from '../mail/transport'
import { evictUserFromSessionCache, revokeAllForUser, rotateSession } from '../session/sessions'
import { assertAdmin, type AdminActor } from './actor'
import { lastAdminConflict, lockEnabledAdmins, wouldRemoveLastAdmin } from './last-admin'
import { generateTempPassword } from './temp-password'
import { createUser, findUserById, type UserRow } from './users'

export type AdminUsersQuery = z.output<typeof adminUsersQuerySchema>
export type AdminCreateUserInput = z.input<typeof adminCreateUserSchema>
export type AdminUpdateUserInput = z.output<typeof adminUpdateUserSchema>

const selfConflict = () => apiError('CONFLICT', 409, { reason: 'self' })
const notFound = () => apiError('NOT_FOUND', 404)
const smtpOff = () => apiError('SERVICE_UNAVAILABLE', 503, { smtpError: 'SMTP is not configured' })
const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

export function toAdminUser(row: UserRow, roomCount: number): AdminUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    disabled: row.disabledAt !== null,
    mustChangePassword: row.mustChangePassword,
    emailVerified: row.emailVerifiedAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    roomCount,
  }
}

async function roomCounts(userIds: string[]): Promise<Map<string, number>> {
  if (!userIds.length) return new Map()
  const rows = await useDb()
    .select({ ownerId: rooms.ownerId, n: count() })
    .from(rooms)
    .where(and(inArray(rooms.ownerId, userIds), isNull(rooms.deletedAt)))
    .groupBy(rooms.ownerId)
  return new Map(rows.map((row) => [row.ownerId, row.n]))
}

async function withRoomCount(row: UserRow): Promise<AdminUser> {
  return toAdminUser(row, (await roomCounts([row.id])).get(row.id) ?? 0)
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export async function listUsers(query: AdminUsersQuery): Promise<Paginated<AdminUser>> {
  const conditions: SQL[] = []
  if (query.q)
    conditions.push(or(ilike(users.email, likePattern(query.q)), ilike(users.displayName, likePattern(query.q)))!)
  if (query.role) conditions.push(eq(users.role, query.role))
  if (query.status === 'active') conditions.push(isNull(users.disabledAt))
  if (query.status === 'disabled') conditions.push(isNotNull(users.disabledAt))
  const where = conditions.length ? and(...conditions) : undefined
  const db = useDb()
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ n: count() }).from(users).where(where),
  ])
  const counts = await roomCounts(rows.map((row) => row.id))
  return {
    items: rows.map((row) => toAdminUser(row, counts.get(row.id) ?? 0)),
    page: query.page,
    pageSize: query.pageSize,
    total: total?.n ?? 0,
  }
}

export async function getAdminUser(id: string): Promise<AdminUser> {
  const row = await findUserById(id)
  if (!row) throw notFound()
  return withRoomCount(row)
}

export async function createUserByAdmin(
  input: AdminCreateUserInput,
  actor: AdminActor,
): Promise<CreatedUserCredentials> {
  const now = assertAdmin(actor)
  const { email, displayName, role, sendEmail } = adminCreateUserSchema.parse(input)
  if (sendEmail && !isSmtpConfigured()) throw smtpOff()
  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  const row = await useDb().transaction(async (tx) => {
    const created = await createUser(
      { email, displayName, role, passwordHash, mustChangePassword: true, emailVerified: true, now },
      tx,
    )
    await audit(
      actor.event,
      {
        action: 'admin.user_created',
        actorUserId: actor.user.id,
        targetType: 'user',
        targetId: created.id,
        details: { email: created.email, role, emailed: sendEmail },
      },
      { db: tx, now },
    )
    if (sendEmail) {
      await sendMailOr503(tempPasswordMessage({ to: created.email, displayName, tempPassword, reason: 'created' }))
    }
    return created
  })
  return { user: toAdminUser(row, 0), tempPassword: sendEmail ? null : tempPassword, emailed: sendEmail }
}

/** Rotates the caller's own session in place, or signs the target out everywhere. */
async function rotateAfterPrivilegeChange(userId: string, actor: AdminActor): Promise<void> {
  if (actor.event && userId === actor.user.id) {
    const { session } = await getAuth(actor.event)
    if (session) {
      await revokeAllForUser(userId, { exceptSessionId: session.id })
      const token = await rotateSession(session.id)
      if (token) setSessionCookie(actor.event, token)
      evictUserFromSessionCache(userId)
      return
    }
  }
  await revokeAllForUser(userId)
}

export async function updateUserByAdmin(
  id: string,
  patch: AdminUpdateUserInput,
  actor: AdminActor,
): Promise<AdminUser> {
  const now = assertAdmin(actor)
  const changes = adminUpdateUserSchema.parse(patch)
  const touchesAdminRights = changes.role !== undefined || changes.disabled !== undefined

  const { row, fields } = await useDb().transaction(async (tx: Tx) => {
    // Lock order: the enabled admins first, then the target (see last-admin.ts).
    const admins = touchesAdminRights ? await lockEnabledAdmins(tx) : []
    const [target] = isUuid(id) ? await tx.select().from(users).where(eq(users.id, id)).for('update') : []
    if (!target) throw notFound()

    const set: Partial<typeof users.$inferInsert> = {}
    const changed: Array<'displayName' | 'role' | 'disabled'> = []
    if (changes.displayName !== undefined && changes.displayName !== target.displayName) {
      set.displayName = changes.displayName
      changed.push('displayName')
    }
    if (changes.role !== undefined && changes.role !== target.role) {
      set.role = changes.role
      changed.push('role')
    }
    if (changes.disabled !== undefined && changes.disabled !== (target.disabledAt !== null)) {
      if (changes.disabled && target.id === actor.user.id) throw selfConflict()
      set.disabledAt = changes.disabled ? now : null
      changed.push('disabled')
    }
    const losesAdminRights =
      target.role === 'admin' && target.disabledAt === null && (set.role === 'user' || set.disabledAt instanceof Date)
    if (losesAdminRights && wouldRemoveLastAdmin(admins, target.id)) throw lastAdminConflict()
    if (!changed.length) return { row: target, fields: changed }

    const [updated] = await tx
      .update(users)
      .set({ ...set, updatedAt: now })
      .where(eq(users.id, id))
      .returning()
    await audit(
      actor.event,
      {
        action: 'admin.user_updated',
        actorUserId: actor.user.id,
        targetType: 'user',
        targetId: id,
        details: {
          fields: changed,
          ...(changed.includes('role') ? { role: set.role } : {}),
          ...(changed.includes('disabled') ? { disabled: changes.disabled } : {}),
        },
      },
      { db: tx, now },
    )
    return { row: updated!, fields: changed }
  })

  if (fields.includes('disabled') && row.disabledAt) await revokeAllForUser(id)
  else if (fields.includes('role')) await rotateAfterPrivilegeChange(id, actor)
  if (fields.length) evictUserFromSessionCache(id)
  return withRoomCount(row)
}

export const setUserDisabled = (id: string, disabled: boolean, actor: AdminActor) =>
  updateUserByAdmin(id, { disabled }, actor)
export const changeUserRole = (id: string, role: UserRole, actor: AdminActor) => updateUserByAdmin(id, { role }, actor)
export const renameUser = (id: string, displayName: string, actor: AdminActor) =>
  updateUserByAdmin(id, { displayName }, actor)

export async function resetPasswordByAdmin(
  id: string,
  input: { sendEmail?: boolean },
  actor: AdminActor,
): Promise<{ tempPassword: string | null; emailed: boolean }> {
  const now = assertAdmin(actor)
  const sendEmail = input.sendEmail ?? false
  if (sendEmail && !isSmtpConfigured()) throw smtpOff()
  if (!isUuid(id)) throw notFound()
  const tempPassword = generateTempPassword()
  const passwordHash = await hashPassword(tempPassword)
  const row = await useDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: now })
      .where(eq(users.id, id))
      .returning()
    if (!updated) throw notFound()
    // Accounts that only signed in externally so far now have a password too.
    await tx
      .insert(authIdentities)
      .values({ userId: id, provider: 'password', subject: id, email: updated.email })
      .onConflictDoNothing()
    await audit(
      actor.event,
      {
        action: 'admin.user_password_reset',
        actorUserId: actor.user.id,
        targetType: 'user',
        targetId: id,
        details: { emailed: sendEmail },
      },
      { db: tx, now },
    )
    if (sendEmail) {
      await sendMailOr503(
        tempPasswordMessage({ to: updated.email, displayName: updated.displayName, tempPassword, reason: 'reset' }),
      )
    }
    return updated
  })
  await revokeAllForUser(id)
  await clearAccountThrottle(row.email)
  return { tempPassword: sendEmail ? null : tempPassword, emailed: sendEmail }
}

export async function revokeUserSessions(id: string, actor: AdminActor): Promise<{ revoked: number }> {
  const now = assertAdmin(actor)
  const target = await findUserById(id)
  if (!target) throw notFound()
  const revoked = await revokeAllForUser(id)
  await audit(
    actor.event,
    {
      action: 'admin.user_sessions_revoked',
      actorUserId: actor.user.id,
      targetType: 'user',
      targetId: id,
      details: { revoked },
    },
    { now },
  )
  return { revoked }
}

export async function deleteUser(
  id: string,
  actor: AdminActor,
  options: { beforeDelete?: (user: UserRow) => Promise<void> } = {},
): Promise<void> {
  const now = assertAdmin(actor)
  const target = await findUserById(id)
  if (!target) throw notFound()
  if (target.id === actor.user.id) throw selfConflict()
  // Fail fast before any cleanup; the transaction below checks again under lock.
  if (target.role === 'admin' && !target.disabledAt) {
    const [enabled] = await useDb()
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
    if ((enabled?.n ?? 0) <= 1) throw lastAdminConflict()
  }
  // While `call_participants.user_id` still points at the account: the delete sets it to null, and the `user.revoked`
  // event published afterwards would find nothing to remove (F-001).
  await removeUserFromLiveCalls(id, now)
  await options.beforeDelete?.(target)

  await useDb().transaction(async (tx) => {
    if (wouldRemoveLastAdmin(await lockEnabledAdmins(tx), id)) throw lastAdminConflict()
    const deleted = await tx.delete(users).where(eq(users.id, id)).returning({ id: users.id })
    if (!deleted.length) throw notFound()
    await audit(
      actor.event,
      {
        action: 'admin.user_deleted',
        actorUserId: actor.user.id,
        targetType: 'user',
        targetId: id,
        details: { email: target.email, role: target.role },
      },
      { db: tx, now },
    )
  })
  evictUserFromSessionCache(id)
  eventBus().publish({ type: 'user.revoked', userId: id })
}
