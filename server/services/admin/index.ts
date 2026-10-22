/**
 * Admin services (Stage 03). The user and account-invite operations live in the users service
 * (`server/services/users`), which writes its own audit entries; this folder adds what the admin panel needs on top:
 *
 * - `common.ts`: `adminActor`, `routeId`, `likePattern`.
 * - `rooms.ts`: `listAdminRooms` (live counts with a database fallback), `endRoomByAdmin`, `deleteRoomByAdmin`,
 *   `listAdminRoomMeetings`.
 * - `audit-log.ts`: `listAuditLog`.
 * - `settings.ts`: `getAdminSettings` (with the SMTP status), `updateAdminSettings`, `sendTestEmail`.
 * - `users.ts`: `deleteUserByAdmin` (ends live meetings and deletes recording files first; the users service takes the
 *   user out of live calls).
 */
export { adminActor, likePattern, routeId, type AdminActor } from './common'
export { auditFilter, listAuditLog, toAuditEntry, type AuditQuery } from './audit-log'
export {
  deleteRoomByAdmin,
  endRoomByAdmin,
  fetchLiveRooms,
  listAdminRoomMeetings,
  listAdminRooms,
  mergeLiveState,
} from './rooms'
export { getAdminSettings, sendTestEmail, settingsChanges, smtpStatus, updateAdminSettings } from './settings'
export { cleanupBeforeUserDelete, deleteUserByAdmin } from './users'
