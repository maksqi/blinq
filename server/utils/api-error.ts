import { createError } from 'h3'
import { errorMessage, type ErrorCode } from '#shared/utils/error-codes'

/**
 * The only way handlers and services report expected failures.
 * Produces `{ statusCode, statusMessage, data: { code, details? } }` with a stable code and an English message.
 */
export function apiError(code: ErrorCode, statusCode: number, details?: unknown) {
  return createError({
    statusCode,
    statusMessage: errorMessage(code),
    data: details === undefined ? { code } : { code, details },
  })
}
