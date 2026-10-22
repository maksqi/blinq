/**
 * Error envelope for `/api/**` (server-core, docs/API.md §1.3). Nitro runs `error` hooks synchronously right before
 * its error handlers, so this rewrites validation errors, unknown routes and unexpected failures into
 * `{ statusCode, statusMessage, data: { code, details? } }`, logs unexpected failures (redacted, with the request id)
 * instead of leaking their messages, and answers right here (`apiErrorResponse`). Errors from `apiError()` keep their
 * code.
 *
 * Answering in the hook (decision, F-002/F-032): Nitro's default handler, which Nuxt leaves JSON requests to, would
 * set `cache-control: no-cache` on 404s and echo the request URL (with `X-Forwarded-Host`) in the body. A custom Nitro
 * `errorHandler` would replace Nuxt's handler and with it the HTML error pages, which this keeps untouched. The
 * response must end synchronously: h3's `send()` defers, and the next handler would overwrite the headers first.
 */
import { getResponseHeader, isError, setResponseHeaders, setResponseStatus } from 'h3'
import { requestLogger } from '../utils/logger'
import { isApiPath, normalizedPath } from '../utils/request-guards'
import { apiErrorResponse, normalizeApiError } from '../utils/validation'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error, context) => {
    const event = context.event
    if (!event || !isError(error)) return
    const path = normalizedPath(event.path)
    if (!isApiPath(path)) return
    const result = normalizeApiError(error)
    if (result.kind === 'internal') {
      requestLogger(event).error('unhandled error', { method: event.method, path, err: result.original })
    }
    // Only errors of the request itself (Nitro tags them), and only while nothing was sent yet.
    const tags: unknown = context.tags
    if (!Array.isArray(tags) || !tags.includes('request') || event.handled) return
    const response = apiErrorResponse(error, { retryAfter: getResponseHeader(event, 'retry-after') !== undefined })
    setResponseStatus(event, response.status, response.statusText)
    setResponseHeaders(event, response.headers)
    event.node.res.end(JSON.stringify(response.body))
  })
})
