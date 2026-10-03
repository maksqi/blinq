/**
 * Body limit for `/api/**` (server-core, docs/API.md §1, F-025). Caddy limits bodies to 1 MB, but the app must not
 * rely on it: nuxt-security checks only `Content-Length` and only on POST, PUT and DELETE. So a declared length above
 * 1 MB answers 413 (PATCH too), and a body without `Content-Length` (chunked) is read here while counting bytes: past
 * 1 MB it answers 413 without buffering the rest; otherwise the handler parses the buffered body as usual
 * (`req.rawBody`, which h3's body readers use). Recording chunk uploads and the LiveKit webhook stream their own
 * bodies and are skipped. Runs after the CSRF and password-change guards, so rejected requests are never read.
 */
import type { IncomingMessage } from 'node:http'
import { getRequestHeader, setResponseHeader } from 'h3'
import { apiError } from '../utils/api-error'
import { BodyTooLargeError, readBodyWithLimit } from '../utils/body-limit'
import { API_BODY_LIMIT_BYTES, bodyLimitDecision, normalizedPath } from '../utils/request-guards'

export default defineEventHandler(async (event) => {
  const decision = bodyLimitDecision({
    method: event.method,
    path: normalizedPath(event.path),
    contentLength: getRequestHeader(event, 'content-length'),
    transferEncoding: getRequestHeader(event, 'transfer-encoding'),
    limit: API_BODY_LIMIT_BYTES,
  })
  if (decision === 'ok') return
  if (decision === 'count') {
    try {
      const req = event.node.req as IncomingMessage & { rawBody?: Buffer }
      req.rawBody = await readBodyWithLimit(req, API_BODY_LIMIT_BYTES)
      return
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error
    }
  }
  // The client may still be sending: do not keep the connection for the rest of it.
  setResponseHeader(event, 'Connection', 'close')
  throw apiError('VALIDATION_FAILED', 413)
})
