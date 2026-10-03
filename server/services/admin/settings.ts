/**
 * Admin settings and SMTP (Stage 03, docs/API.md §9 and §15).
 *
 * - `smtpStatus(environment)`: pure; `{ configured, host, from }` from the environment (never the user or password).
 * - `getAdminSettings()` → `{ settings, smtp }`.
 * - `settingsChanges(before, after)`: pure; changed keys with old and new values.
 * - `updateAdminSettings(rawBody, actor)` → `{ settings }`: writes through the settings service (strict partial patch,
 *   merged result re-validated, cache invalidated, so the next request sees it). Audit `admin.settings_updated` with
 *   `details: { fields, old, new }`; an update that changes nothing writes no entry (decision, like the users service).
 * - `sendTestEmail(to, actor)`: 503 `SERVICE_UNAVAILABLE` without SMTP or when sending fails (`details.smtpError`, a
 *   short reason without credentials). Audit `admin.test_email_sent` after a successful send (decision).
 */
import type { SettingKey, Settings } from '#shared/schemas/settings'
import { env, type Env } from '../../utils/env'
import { audit } from '../audit/audit'
import { testMessage } from '../mail/messages'
import { sendMailOr503 } from '../mail/transport'
import { getSettings, invalidateSettingsCache, updateSettings } from '../settings/settings'
import { assertAdminActor, type AdminActor } from './common'

export interface SmtpStatus {
  configured: boolean
  host: string | null
  from: string | null
}

export interface AdminSettingsView {
  settings: Settings
  smtp: SmtpStatus
}

export function smtpStatus(environment: Pick<Env, 'smtpEnabled' | 'SMTP_HOST' | 'SMTP_FROM'>): SmtpStatus {
  if (!environment.smtpEnabled) return { configured: false, host: null, from: null }
  return { configured: true, host: environment.SMTP_HOST ?? null, from: environment.SMTP_FROM ?? null }
}

export async function getAdminSettings(): Promise<AdminSettingsView> {
  return { settings: await getSettings(), smtp: smtpStatus(env()) }
}

export interface SettingsChanges {
  fields: SettingKey[]
  old: Partial<Settings>
  new: Partial<Settings>
}

export function settingsChanges(before: Settings, after: Settings): SettingsChanges {
  const fields = (Object.keys(after) as SettingKey[]).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
  const pick = (source: Settings) => Object.fromEntries(fields.map((key) => [key, source[key]])) as Partial<Settings>
  return { fields, old: pick(before), new: pick(after) }
}

export async function updateAdminSettings(rawBody: unknown, actor: AdminActor): Promise<{ settings: Settings }> {
  const now = assertAdminActor(actor)
  // Read the stored values, not a cached copy that another process may have outdated.
  invalidateSettingsCache()
  const before = await getSettings()
  const after = await updateSettings(rawBody, actor.user.id, now)
  const changes = settingsChanges(before, after)
  if (changes.fields.length) {
    await audit(
      actor.event,
      {
        action: 'admin.settings_updated',
        actorUserId: actor.user.id,
        targetType: 'settings',
        targetId: null,
        details: { fields: changes.fields, old: changes.old, new: changes.new },
      },
      { now },
    )
  }
  return { settings: after }
}

export async function sendTestEmail(to: string, actor: AdminActor): Promise<{ ok: true }> {
  const now = assertAdminActor(actor)
  await sendMailOr503(testMessage(to, now))
  await audit(
    actor.event,
    {
      action: 'admin.test_email_sent',
      actorUserId: actor.user.id,
      targetType: 'email',
      targetId: null,
      details: { to },
    },
    { now },
  )
  return { ok: true }
}
