/**
 * Pure request rules used by server-core middleware (docs/API.md §1.1).
 *
 * - `normalizedPath(url)`: path without query, repeated slashes collapsed, no trailing slash. Checks run on this
 *   form, which is at least as strict as Nitro's router (it strips trailing slashes, never decodes).
 * - `csrfRejected(...)`: every method except GET/HEAD/OPTIONS needs `Origin` equal to the origin of `PUBLIC_URL`,
 *   and `Sec-Fetch-Site: same-origin` when that header is present. Only `POST /api/webhooks/livekit` is exempt
 *   (signature auth). `Host` and `X-Forwarded-Host` are never consulted. Applied to every path, not only `/api/**`,
 *   since nothing else accepts mutations (decision).
 * - `passwordChangeExempt(method, path)`: the only `/api/**` routes a user with `mustChangePassword` may call.
 * - `isProbePath(path)`: `/api/health` and `/api/ready` (no session lookup, no request log).
 * - `API_RESPONSE_HEADERS`: set on every `/api/**` response.
 * - `bodyLimitDecision(...)`: how the 1 MB body limit applies (declared length, or counting a chunked body).
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const CSRF_EXEMPT = new Set(['POST /api/webhooks/livekit'])

const PASSWORD_CHANGE_EXEMPT = new Set([
  'GET /api/auth/me',
  'POST /api/auth/password',
  'POST /api/auth/logout',
  'GET /api/config',
  'GET /api/health',
  'GET /api/ready',
])

const PROBES = new Set(['/api/health', '/api/ready'])

/** Headers of every `/api/**` response, errors included (docs/API.md §1, F-028). */
export const API_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
} as const

export function normalizedPath(url: string): string {
  const path = url.split(/[?#]/, 1)[0]!.replace(/\/{2,}/g, '/')
  return path.length > 1 ? path.replace(/\/+$/, '') : path || '/'
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
}

export function isProbePath(path: string): boolean {
  return PROBES.has(path)
}

export function isCsrfExempt(method: string, path: string): boolean {
  return CSRF_EXEMPT.has(`${method.toUpperCase()} ${path}`)
}

export function csrfRejected(input: {
  method: string
  path: string
  origin: string | undefined
  secFetchSite: string | undefined
  publicOrigin: string
}): boolean {
  const method = input.method.toUpperCase()
  if (SAFE_METHODS.has(method) || isCsrfExempt(method, input.path)) return false
  if (input.origin !== input.publicOrigin) return true
  return input.secFetchSite !== undefined && input.secFetchSite !== 'same-origin'
}

/** Request bodies of `/api/**` (docs/API.md §1: 1 MB, the same number as nuxt-security's limit). */
export const API_BODY_LIMIT_BYTES = 1_000_000

const PAYLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Routes that stream their raw body and enforce their own limit: recording chunks and the LiveKit webhook. */
export function bodyLimitExempt(method: string, path: string): boolean {
  const upper = method.toUpperCase()
  if (upper === 'POST' && path === '/api/webhooks/livekit') return true
  return upper === 'PUT' && /^\/api\/recordings\/[^/]+\/chunks\/[^/]+$/.test(path)
}

/**
 * How the body limit applies to a request (F-025). nuxt-security checks only `Content-Length` and only on POST, PUT
 * and DELETE, so: a declared length above the limit → `too_large`; a body without `Content-Length` (chunked) →
 * `count` (read it while counting bytes); everything else → `ok`.
 */
export function bodyLimitDecision(input: {
  method: string
  path: string
  contentLength: string | undefined
  transferEncoding: string | undefined
  limit: number
}): 'ok' | 'too_large' | 'count' {
  if (!isApiPath(input.path) || !PAYLOAD_METHODS.has(input.method.toUpperCase())) return 'ok'
  if (bodyLimitExempt(input.method, input.path)) return 'ok'
  if (input.contentLength !== undefined && input.contentLength.trim() !== '') {
    const length = Number(input.contentLength)
    return Number.isFinite(length) && length <= input.limit ? 'ok' : 'too_large'
  }
  return input.transferEncoding ? 'count' : 'ok'
}

export function passwordChangeExempt(method: string, path: string): boolean {
  const upper = method.toUpperCase()
  return PASSWORD_CHANGE_EXEMPT.has(`${upper === 'HEAD' ? 'GET' : upper} ${path}`)
}
