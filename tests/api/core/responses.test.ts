/**
 * Response hardening (Stage 10): the documented error body without the request URL, `no-store` on every API error
 * (F-002, F-032), `Cross-Origin-Resource-Policy` on API responses (F-028), and the 1 MB body limit also for chunked
 * and PATCH bodies (F-025). HTML error pages stay Nuxt's.
 */
import { describe, expect, it } from 'vitest'
import { apiBaseUrl, createClient, createUser, expectApiError, loginAs, uniqueEmail, uniqueIp } from '../_harness'

const MB = 1_000_000

/** A request body sent as a stream: no Content-Length, `Transfer-Encoding: chunked`. */
function chunkedBody(totalBytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close()
      const size = Math.min(chunk, totalBytes - sent)
      sent += size
      controller.enqueue(new Uint8Array(size).fill(0x20))
    },
  })
}

async function postStream(path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  const res = await fetch(new URL(path, apiBaseUrl()), {
    method: 'POST',
    body,
    duplex: 'half',
    headers: {
      origin: new URL(apiBaseUrl()).origin,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-forwarded-for': uniqueIp(),
      ...headers,
    },
  } as RequestInit)
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : undefined }
}

describe('API error responses (F-002, F-032)', () => {
  it('answers unknown routes with the envelope only: no URL, no stack, no-store', async () => {
    const res = await createClient().get('/api/definitely-not-a-route', {
      headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    })
    expectApiError(res, 404, 'NOT_FOUND')
    expect(res.body).toEqual({ statusCode: 404, statusMessage: res.body.statusMessage, data: { code: 'NOT_FOUND' } })
    expect(res.text).not.toContain('evil.example')
    expect(res.text).not.toContain('definitely-not-a-route')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('keeps no-store on 401, 403 and 400 answers too', async () => {
    for (const res of [
      await createClient().get('/api/auth/sessions'),
      await createClient().post('/api/auth/logout', { origin: 'https://evil.example' }),
      await createClient().post('/api/auth/login', { body: { email: 'not-an-email', password: 'x' } }),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.headers.get('cache-control'), res.text).toBe('no-store')
      expect(res.body.url).toBeUndefined()
    }
  })

  it('leaves HTML error pages to Nuxt', async () => {
    const res = await createClient().get('/definitely-not-a-page', { headers: { accept: 'text/html' } })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})

describe('API response headers (F-028)', () => {
  it('sets Cross-Origin-Resource-Policy: same-origin on API answers', async () => {
    const config = await createClient().get('/api/config')
    expect(config.status).toBe(200)
    expect(config.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(config.headers.get('x-content-type-options')).toBe('nosniff')
    expect(config.headers.get('cache-control')).toBe('no-store')
    const me = await (await loginAs(await createUser())).get('/api/auth/me')
    expect(me.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })
})

describe('request body limit (F-025)', () => {
  it('reads a small chunked body as usual', async () => {
    const json = JSON.stringify({ email: uniqueEmail(), password: 'not-the-password-1' })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(json.slice(0, 10)))
        controller.enqueue(new TextEncoder().encode(json.slice(10)))
        controller.close()
      },
    })
    const res = await postStream('/api/auth/login', body)
    expect(res.status, res.text).toBe(401)
    expect(res.body.data.code).toBe('AUTH_INVALID_CREDENTIALS')
  })

  it('refuses a chunked body above 1 MB with 413 without reading all of it', async () => {
    const res = await postStream('/api/auth/login', chunkedBody(3 * MB))
    expect(res.status, res.text).toBe(413)
    expect(res.body).toMatchObject({ statusCode: 413, data: { code: 'VALIDATION_FAILED' } })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a declared PATCH body above 1 MB (nuxt-security checks POST, PUT and DELETE only)', async () => {
    const api = await loginAs(await createUser())
    const res = await api.patch('/api/me', { raw: JSON.stringify({ displayName: 'x'.repeat(MB + 10) }), headers: { 'content-type': 'application/json' } })
    expectApiError(res, 413, 'VALIDATION_FAILED')
  })
})
