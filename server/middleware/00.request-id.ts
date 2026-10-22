/**
 * Request id (server-core): a fresh random id per request in `event.context.requestId` and the `X-Request-Id`
 * response header. A client-sent `X-Request-Id` is ignored. Also gives every `/api/**` response (recording files
 * included) the API headers: `Cache-Control: no-store` (docs/API.md §1), `Cross-Origin-Resource-Policy: same-origin`
 * and `X-Content-Type-Options: nosniff` (nuxt-security sets them on rendered pages only) (F-028).
 */
import { setResponseHeaders } from 'h3'
import { newRequestId } from '../utils/request-context'
import { API_RESPONSE_HEADERS, isApiPath, normalizedPath } from '../utils/request-guards'

export default defineEventHandler((event) => {
  const requestId = newRequestId()
  event.context.requestId = requestId
  event.context.requestStartedAt = performance.now()
  setResponseHeaders(event, { 'X-Request-Id': requestId })
  if (isApiPath(normalizedPath(event.path))) setResponseHeaders(event, API_RESPONSE_HEADERS)
})
