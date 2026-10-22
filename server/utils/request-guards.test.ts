import { describe, expect, it } from 'vitest'
import {
  API_RESPONSE_HEADERS,
  bodyLimitDecision,
  bodyLimitExempt,
  csrfRejected,
  isApiPath,
  isProbePath,
  normalizedPath,
  passwordChangeExempt,
} from './request-guards'

const publicOrigin = 'https://meet.example.test'
const check = (method: string, path: string, origin?: string, secFetchSite?: string) =>
  csrfRejected({ method, path, origin, secFetchSite, publicOrigin })

describe('normalizedPath', () => {
  it.each([
    ['/api/rooms?page=2', '/api/rooms'],
    ['/api/rooms/', '/api/rooms'],
    ['//api//rooms///', '/api/rooms'],
    ['/api/webhooks/livekit#x', '/api/webhooks/livekit'],
    ['/', '/'],
    ['', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizedPath(input)).toBe(expected)
  })

  it('classifies API and probe paths', () => {
    expect(isApiPath('/api/rooms')).toBe(true)
    expect(isApiPath('/apix')).toBe(false)
    expect(isApiPath('/m/abc-defg-hjk')).toBe(false)
    expect(isProbePath('/api/health')).toBe(true)
    expect(isProbePath('/api/ready')).toBe(true)
    expect(isProbePath('/api/config')).toBe(false)
  })
})

describe('csrfRejected', () => {
  it('never checks safe methods', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(check(method, '/api/rooms')).toBe(false)
  })

  it('requires the exact public origin for every mutating method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
      expect(check(method, '/api/rooms')).toBe(true)
      expect(check(method, '/api/rooms', 'https://evil.test')).toBe(true)
      expect(check(method, '/api/rooms', 'null')).toBe(true)
      expect(check(method, '/api/rooms', `${publicOrigin}/`)).toBe(true)
      expect(check(method, '/api/rooms', 'https://meet.example.test:8443')).toBe(true)
      expect(check(method, '/api/rooms', 'http://meet.example.test')).toBe(true)
      expect(check(method, '/api/rooms', publicOrigin)).toBe(false)
    }
  })

  it('requires Sec-Fetch-Site: same-origin when the header is present', () => {
    expect(check('POST', '/api/rooms', publicOrigin, 'same-origin')).toBe(false)
    expect(check('POST', '/api/rooms', publicOrigin, 'same-site')).toBe(true)
    expect(check('POST', '/api/rooms', publicOrigin, 'cross-site')).toBe(true)
    expect(check('POST', '/api/rooms', publicOrigin, 'none')).toBe(true)
  })

  it('exempts only POST /api/webhooks/livekit', () => {
    expect(check('POST', '/api/webhooks/livekit')).toBe(false)
    expect(check('PUT', '/api/webhooks/livekit')).toBe(true)
    expect(check('POST', '/api/webhooks/livekit/extra')).toBe(true)
    expect(check('POST', '/api/webhooks')).toBe(true)
  })

  it('applies outside /api too', () => {
    expect(check('POST', '/dashboard')).toBe(true)
  })
})

describe('passwordChangeExempt', () => {
  it.each([
    ['GET', '/api/auth/me'],
    ['HEAD', '/api/auth/me'],
    ['POST', '/api/auth/password'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/config'],
    ['GET', '/api/health'],
    ['GET', '/api/ready'],
  ])('allows %s %s', (method, path) => {
    expect(passwordChangeExempt(method, path)).toBe(true)
  })

  it.each([
    ['POST', '/api/auth/me'],
    ['GET', '/api/auth/sessions'],
    ['DELETE', '/api/auth/sessions/x'],
    ['PATCH', '/api/me'],
    ['GET', '/api/rooms'],
    ['POST', '/api/rooms'],
    ['GET', '/api/auth/password'],
  ])('blocks %s %s', (method, path) => {
    expect(passwordChangeExempt(method, path)).toBe(false)
  })
})

describe('API response headers', () => {
  it('mark every API response no-store, same-origin and nosniff (F-028)', () => {
    expect(API_RESPONSE_HEADERS).toEqual({
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    })
  })
})

describe('bodyLimitDecision (F-025)', () => {
  const decide = (method: string, path: string, contentLength?: string, transferEncoding?: string) =>
    bodyLimitDecision({ method, path, contentLength, transferEncoding, limit: 1_000 })

  it('lets declared lengths up to the limit through and rejects larger ones, PATCH included', () => {
    expect(decide('POST', '/api/rooms', '1000')).toBe('ok')
    expect(decide('POST', '/api/rooms', '1001')).toBe('too_large')
    expect(decide('PATCH', '/api/rooms/x', '5000')).toBe('too_large')
    expect(decide('DELETE', '/api/rooms/x', 'nonsense')).toBe('too_large')
  })

  it('counts bodies without Content-Length', () => {
    expect(decide('POST', '/api/auth/login', undefined, 'chunked')).toBe('count')
    expect(decide('PUT', '/api/rooms/x/key', '', 'chunked')).toBe('count')
    expect(decide('POST', '/api/auth/logout')).toBe('ok')
  })

  it('skips safe methods, pages and the routes that stream their own bodies', () => {
    expect(decide('GET', '/api/rooms', undefined, 'chunked')).toBe('ok')
    expect(decide('POST', '/login', undefined, 'chunked')).toBe('ok')
    expect(decide('PUT', '/api/recordings/r1/chunks/3', '20000000')).toBe('ok')
    expect(decide('POST', '/api/webhooks/livekit', undefined, 'chunked')).toBe('ok')
    expect(decide('POST', '/api/recordings/r1/complete', '5000')).toBe('too_large')
    expect(bodyLimitExempt('put', '/api/recordings/r1/chunks/3')).toBe(true)
    expect(bodyLimitExempt('POST', '/api/recordings/r1/chunks/3')).toBe(false)
  })
})
