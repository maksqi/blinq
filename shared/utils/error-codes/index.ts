/**
 * Stable API error codes. Responses: `{ statusCode, statusMessage, data: { code, details? } }` (h3 createError).
 * The UI maps codes to English messages (ERROR_MESSAGES); never show raw server text.
 */
export const COMMON_ERRORS = {
  VALIDATION_FAILED: 'Some fields are invalid. Check them and try again.',
  CSRF_REJECTED: 'This request was blocked. Reload the page and try again.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  UNAUTHENTICATED: 'Please sign in.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'Not found. It may have been deleted. Refresh and try again.',
  CONFLICT: 'This conflicts with the current state. Reload and try again.',
  INTERNAL: 'Something went wrong on the server. Try again in a moment.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. Try again shortly.',
} as const

export const AUTH_ERRORS = {
  AUTH_INVALID_CREDENTIALS: 'Email or password is incorrect. Check them and try again.',
  AUTH_PASSWORD_CHANGE_REQUIRED: 'Change your password to continue.',
  AUTH_PASSWORD_WEAK: 'Choose a stronger password.',
  AUTH_ACCOUNT_DISABLED: 'This account is disabled. Contact your administrator.',
  AUTH_EMAIL_NOT_VERIFIED: 'Confirm your email address first: open the link we emailed you.',
  AUTH_TOKEN_INVALID: 'This link is invalid. Open the latest link we emailed you, or request a new one.',
  AUTH_TOKEN_EXPIRED: 'This link has expired. Request a new one.',
  REGISTRATION_CLOSED: 'Registration is closed. Ask an administrator for an invite.',
  REGISTRATION_DOMAIN_NOT_ALLOWED: 'Registration is limited to specific email domains. Use an address from one of them.',
  INVITE_INVALID: 'This invite is invalid. Ask your administrator for a new one.',
  INVITE_EXPIRED: 'This invite has expired. Ask your administrator for a new one.',
  INVITE_USED: 'This invite has already been used. Sign in, or ask your administrator for a new one.',
} as const

export const ROOM_ERRORS = {
  ROOM_NOT_FOUND: 'This meeting does not exist. Check the link or ask the host for a new one.',
  ROOM_LIMIT_REACHED: 'You have reached the maximum number of rooms. Delete a room you no longer need first.',
  ROOM_KEY_INVALID: 'The encryption key in this link is invalid or outdated. Ask the host for a new link.',
  ROOM_LOCKED: 'The host has locked this meeting. Try again after they unlock it.',
  ROOM_FULL: 'This meeting is full. Try again when someone leaves.',
  ROOM_PASSWORD_REQUIRED: 'This meeting needs a password. Enter it to join.',
  ROOM_PASSWORD_INVALID: 'Wrong meeting password. Check it with the host and try again.',
  ROOM_GUESTS_NOT_ALLOWED: 'Guests cannot join this meeting. Sign in first.',
  ROOM_INVITE_REQUIRED: 'You need an invite link to join this meeting. Ask the host for one.',
  ROOM_INVITE_INVALID: 'This invite link is invalid, expired or revoked. Ask the host for a new one.',
  JOIN_REMOVED: 'You were removed from this meeting.',
  JOIN_DENIED: 'The host did not let you in.',
  LOBBY_FULL: 'Too many people are waiting. Try again later.',
  MEETING_LIVE: 'End the current meeting first.',
  CALL_NOT_PARTICIPANT: 'You are not in this meeting.',
  CALL_FORBIDDEN: 'Only the host or a co-host can do that.',
} as const

export const RECORDING_ERRORS = {
  RECORDING_DISABLED: 'Recording is disabled on this server. Ask your administrator to turn it on.',
  RECORDING_ACTIVE: 'This meeting is already being recorded.',
  RECORDING_NOT_ALLOWED: 'Only hosts and co-hosts with an account can record.',
  RECORDING_QUOTA_EXCEEDED: 'Your recording storage quota is full. Delete recordings you no longer need.',
  RECORDING_TOO_LARGE: 'The recording exceeds the allowed size or duration. Start a new recording.',
  RECORDING_NOT_READY: 'The recording is still being processed. Try again in a few minutes.',
} as const

export const ERROR_MESSAGES = {
  ...COMMON_ERRORS,
  ...AUTH_ERRORS,
  ...ROOM_ERRORS,
  ...RECORDING_ERRORS,
} as const

export type ErrorCode = keyof typeof ERROR_MESSAGES

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_MESSAGES
}

/** Human-readable message for an API error payload (falls back to a generic message). */
export function errorMessage(code: unknown): string {
  return isErrorCode(code) ? ERROR_MESSAGES[code] : COMMON_ERRORS.INTERNAL
}
