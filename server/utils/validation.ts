/**
 * Validation-error and error-envelope helpers (server-core, docs/API.md §1.3).
 *
 * - `toValidationIssues(error)`: zod issues → `[{ path: 'a.b.0', message }]` (`details.issues` of VALIDATION_FAILED).
 * - `normalizeApiError(error)`: rewrites an error bound for an `/api/**` response into the documented envelope
 *   `{ statusCode, statusMessage, data: { code, details? } }`:
 *   - h3 validation errors (`readValidatedBody(event, schema.parse)`, `getValidatedQuery`, ...) and uncaught zod
 *     errors → 400 `VALIDATION_FAILED` with `details.issues`;
 *   - unknown routes (404 without a code) → `NOT_FOUND`;
 *   - anything else without a code → 500 `INTERNAL` with a generic message (the original is returned for logging).
 *   Errors that already carry a `data.code` (from `apiError`) are left alone. A server plugin calls it.
 * - `apiErrorResponse(error)`: status, headers and body of the documented error response for a normalized error.
 */
import type { H3Error } from 'h3'
import { errorMessage, isErrorCode } from '#shared/utils/error-codes'

export interface ValidationIssue {
  path: string
  message: string
}

interface ZodLikeError {
  issues: Array<{ path: PropertyKey[]; message: string }>
}

export function isZodLikeError(value: unknown): value is ZodLikeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    ((value as { name?: unknown }).name === 'ZodError' || value.constructor?.name === 'ZodError')
  )
}

export function toValidationIssues(error: ZodLikeError): ValidationIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
}

export type NormalizedError = { kind: 'coded' | 'validation' | 'not_found' } | { kind: 'internal'; original: unknown }

export function normalizeApiError(error: H3Error): NormalizedError {
  const data = error.data as { code?: unknown } | undefined
  if (data && isErrorCode(data.code)) return { kind: 'coded' }

  const zod = isZodLikeError(error.data) ? error.data : isZodLikeError(error.cause) ? error.cause : undefined
  if (zod) {
    rewrite(error, 400, 'VALIDATION_FAILED', { issues: toValidationIssues(zod) })
    return { kind: 'validation' }
  }
  if (error.statusCode === 404) {
    rewrite(error, 404, 'NOT_FOUND')
    return { kind: 'not_found' }
  }
  if (error.unhandled || (error.statusCode >= 500 && error.statusCode !== 503)) {
    const original = error.cause ?? error
    rewrite(error, error.statusCode >= 500 ? error.statusCode : 500, 'INTERNAL')
    return { kind: 'internal', original }
  }
  // Other framework errors (405, 413 from nuxt-security, ...): keep the status, add the matching generic code.
  rewrite(error, error.statusCode, codeForStatus(error.statusCode))
  return { kind: 'coded' }
}

function codeForStatus(status: number): Parameters<typeof errorMessage>[0] {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED'
    case 403:
      return 'FORBIDDEN'
    case 405:
      return 'NOT_FOUND'
    case 409:
      return 'CONFLICT'
    case 429:
      return 'RATE_LIMITED'
    case 503:
      return 'SERVICE_UNAVAILABLE'
    default:
      return 'VALIDATION_FAILED'
  }
}

function rewrite(error: H3Error, statusCode: number, code: Parameters<typeof errorMessage>[0], details?: unknown) {
  const message = errorMessage(code)
  error.statusCode = statusCode
  error.statusMessage = message
  error.message = message
  error.data = details === undefined ? { code } : { code, details }
  // Handled now: Nitro must not hide `data` or log it as an unhandled error (the plugin logs it instead).
  error.unhandled = false
  error.fatal = false
}

export interface ApiErrorResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: { statusCode: number; statusMessage: string; data: { code: string; details?: unknown } }
}

/**
 * Pure: the documented error response for a normalized error (F-002, F-032). Unlike Nitro's handler it never puts the
 * request URL (which reflects `X-Forwarded-Host`), a stack or a `message` into the body, and it keeps
 * `Cache-Control: no-store` for every status (Nitro sets `no-cache` on 404s). A 429 with `details.retryAfter`
 * (seconds) gets the matching `Retry-After` header unless one is already set.
 */
export function apiErrorResponse(error: H3Error, existing: { retryAfter?: boolean } = {}): ApiErrorResponse {
  const data = (error.data ?? {}) as { code?: unknown; details?: unknown }
  const code = isErrorCode(data.code) ? data.code : 'INTERNAL'
  const statusCode = error.statusCode || 500
  const statusMessage = error.statusMessage || errorMessage(code)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  }
  const retryAfter = (data.details as { retryAfter?: unknown } | undefined)?.retryAfter
  if (statusCode === 429 && !existing.retryAfter && typeof retryAfter === 'number' && retryAfter > 0) {
    headers['Retry-After'] = String(Math.ceil(retryAfter))
  }
  return {
    status: statusCode,
    statusText: statusMessage,
    headers,
    body: { statusCode, statusMessage, data: data.details === undefined ? { code } : { code, details: data.details } },
  }
}
