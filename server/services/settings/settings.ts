/**
 * Admin settings (server-core, docs/API.md §15). Table `settings`, one row per key, typed by `settingsSchema`.
 *
 * - `getSettings()`: every setting merged over `SETTINGS_DEFAULTS`, cached ≤ 5 s per process, invalidated on write.
 *   Invalid stored values fall back to the default (and are logged).
 * - `updateSettings(patch, actorUserId, now)`: validates only the keys present in `patch` with the shared
 *   `settingsUpdateSchema` (strict; built without defaults, so keys that were not sent stay as they are), re-validates
 *   the merged result and cross-field rules (`registration.mode = 'domain'` needs SMTP and at least one allowed
 *   domain), writes changed keys and returns the new settings. Throws 400 `VALIDATION_FAILED` with `details.issues`
 *   (and `details.field` for cross-field rules). The handler writes the audit entry (`admin.settings_updated`).
 * - `getSystemFlag(key)` / `setSystemFlag(key, value, db, now)`: internal `system.*` keys, never part of
 *   `getSettings()`.
 * - `invalidateSettingsCache()`.
 */
import { eq, like, not } from 'drizzle-orm'
import {
  SETTINGS_DEFAULTS,
  settingsSchema,
  settingsUpdateSchema,
  type SettingKey,
  type Settings,
} from '#shared/schemas/settings'
import { useDb, type Db, type Tx } from '../../database/client'
import { settings as settingsTable } from '../../database/schema'
import { apiError } from '../../utils/api-error'
import { env } from '../../utils/env'
import { logger } from '../../utils/logger'
import { toValidationIssues } from '../../utils/validation'

export const SETTINGS_CACHE_TTL_MS = 5_000

export type SystemFlagKey = `system.${string}`

const SETTING_KEYS = Object.keys(settingsSchema.shape) as SettingKey[]

let cached: { value: Settings; at: number } | undefined
let loading: Promise<Settings> | undefined
let generation = 0

/** Pure: stored rows merged over the defaults. Unknown keys and `system.*` rows are ignored. */
export function mergeSettings(
  rows: Array<{ key: string; value: unknown }>,
  onInvalid: (key: string) => void = () => {},
): Settings {
  const merged: Record<string, unknown> = { ...SETTINGS_DEFAULTS }
  for (const row of rows) {
    if (!(SETTING_KEYS as string[]).includes(row.key)) continue
    const parsed = settingsSchema.shape[row.key as SettingKey].safeParse(row.value)
    if (parsed.success) merged[row.key] = parsed.data
    else onInvalid(row.key)
  }
  return settingsSchema.parse(merged)
}

async function loadSettings(db: Db | Tx = useDb()): Promise<Settings> {
  const rows = await db
    .select({ key: settingsTable.key, value: settingsTable.value })
    .from(settingsTable)
    .where(not(like(settingsTable.key, 'system.%')))
  return mergeSettings(rows, (key) => logger.warn('invalid stored setting ignored, using the default', { key }))
}

export async function getSettings(): Promise<Settings> {
  if (cached && Date.now() - cached.at < SETTINGS_CACHE_TTL_MS) return cached.value
  if (!loading) {
    const started = generation
    loading = loadSettings()
      .then((value) => {
        if (started === generation) cached = { value, at: Date.now() }
        return value
      })
      .finally(() => {
        loading = undefined
      })
  }
  return loading
}

export function invalidateSettingsCache(): void {
  generation++
  cached = undefined
  loading = undefined
}

/** Pure: cross-field rules on a complete, schema-valid settings object. */
export function settingsRuleViolation(
  value: Settings,
  context: { smtpEnabled: boolean },
): { field: SettingKey; message: string } | null {
  if (value['registration.mode'] === 'domain') {
    if (!context.smtpEnabled) {
      return { field: 'registration.mode', message: 'Domain registration needs SMTP for email verification' }
    }
    if (value['registration.allowedDomains'].length === 0) {
      return { field: 'registration.allowedDomains', message: 'Add at least one allowed domain' }
    }
  }
  return null
}

/** Pure: validates a patch against the current settings; returns the merged settings and the changed keys. */
export function applySettingsPatch(
  current: Settings,
  patch: unknown,
  context: { smtpEnabled: boolean },
): { next: Settings; changed: SettingKey[] } {
  const parsed = settingsUpdateSchema.safeParse(patch)
  if (!parsed.success) throw apiError('VALIDATION_FAILED', 400, { issues: toValidationIssues(parsed.error) })
  const provided = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined))
  const merged = settingsSchema.safeParse({ ...current, ...provided })
  if (!merged.success) throw apiError('VALIDATION_FAILED', 400, { issues: toValidationIssues(merged.error) })
  const violation = settingsRuleViolation(merged.data, context)
  if (violation) {
    throw apiError('VALIDATION_FAILED', 400, {
      field: violation.field,
      issues: [{ path: violation.field, message: violation.message }],
    })
  }
  const changed = SETTING_KEYS.filter((key) => JSON.stringify(merged.data[key]) !== JSON.stringify(current[key]))
  return { next: merged.data, changed }
}

export async function updateSettings(
  patch: unknown,
  actorUserId: string | null,
  now: Date = new Date(),
): Promise<Settings> {
  const db = useDb()
  const next = await db.transaction(async (tx) => {
    const current = await loadSettings(tx)
    const result = applySettingsPatch(current, patch, { smtpEnabled: env().smtpEnabled })
    for (const key of result.changed) {
      await tx
        .insert(settingsTable)
        .values({ key, value: result.next[key], updatedBy: actorUserId, updatedAt: now })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: result.next[key], updatedBy: actorUserId, updatedAt: now },
        })
    }
    return result.next
  })
  invalidateSettingsCache()
  return next
}

export async function getSystemFlag(key: SystemFlagKey, db: Db | Tx = useDb()): Promise<unknown> {
  const [row] = await db.select({ value: settingsTable.value }).from(settingsTable).where(eq(settingsTable.key, key))
  return row?.value
}

export async function setSystemFlag(
  key: SystemFlagKey,
  value: unknown,
  db: Db | Tx = useDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: now } })
}
