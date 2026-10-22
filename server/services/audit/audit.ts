/**
 * Audit log writer (server-core, docs/SECURITY.md §8).
 *
 *   await audit(event, { action: 'admin.disable_user', targetType: 'user', targetId: id, details: { reason } })
 *
 * - Actions are `<domain>.<verb>` (lowercase, underscores inside parts), e.g. `auth.login_failed`,
 *   `admin.settings_updated`. Invalid names throw (a programming error that tests catch).
 * - The IP comes from `getClientIp(event)`; pass `null` as the event outside requests (CLI, tasks), and `{ ip }` for
 *   work that finishes after the response (the socket may be gone by then).
 * - `actorUserId` defaults to the signed-in user of the request; pass `null` explicitly for "no actor".
 * - `details` are redacted (sensitive keys and token-like strings) and capped at 8 KiB: never pass secrets anyway.
 * - Pass `{ db: tx }` to write inside a transaction.
 */
import type { H3Event } from 'h3'
import { useDb, type Db, type Tx } from '../../database/client'
import { auditLog } from '../../database/schema'
import { getAuth } from '../../utils/auth'
import { getClientIp } from '../../utils/client-ip'
import { redact } from '../../utils/logger'

export interface AuditInput {
  action: string
  targetType?: string | null
  targetId?: string | null
  details?: Record<string, unknown> | null
  /** Defaults to the signed-in user of `event`; `null` records no actor. */
  actorUserId?: string | null
  actorParticipantId?: string | null
}

export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
export const AUDIT_DETAILS_MAX_BYTES = 8192

export type AuditRow = typeof auditLog.$inferInsert

/** Pure: the row to insert. */
export function buildAuditRow(
  input: AuditInput,
  context: { ip: string | null; actorUserId: string | null; now: Date },
): AuditRow {
  if (!AUDIT_ACTION_PATTERN.test(input.action)) {
    throw new Error(`Invalid audit action "${input.action}": use <domain>.<verb>`)
  }
  return {
    at: context.now,
    action: input.action,
    actorUserId: input.actorUserId === undefined ? context.actorUserId : input.actorUserId,
    actorParticipantId: input.actorParticipantId ?? null,
    ip: context.ip,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    details: sanitizeDetails(input.details),
  }
}

export function sanitizeDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!details) return null
  const clean = redact(details) as Record<string, unknown>
  const size = Buffer.byteLength(JSON.stringify(clean))
  return size > AUDIT_DETAILS_MAX_BYTES ? { truncated: true, bytes: size } : clean
}

export async function audit(
  event: H3Event | null,
  input: AuditInput,
  options: { db?: Db | Tx; now?: Date; ip?: string | null } = {},
): Promise<void> {
  const actorUserId = event && input.actorUserId === undefined ? ((await getAuth(event)).user?.id ?? null) : null
  const row = buildAuditRow(input, {
    ip: options.ip !== undefined ? options.ip : event ? getClientIp(event) : null,
    actorUserId,
    now: options.now ?? new Date(),
  })
  await (options.db ?? useDb()).insert(auditLog).values(row)
}
