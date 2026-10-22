import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearGuestCookie,
  clearSessionCookie,
  guestCookieName,
  readGuestToken,
  readSessionToken,
  sessionCookieName,
  setGuestCookie,
  setSessionCookie,
} from './cookies'
import { randomToken } from './crypto'
import { resetEnvCache } from './env'

function useEnv(publicUrl: string) {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('PUBLIC_URL', publicUrl)
  vi.stubEnv('APP_SECRET', 'a'.repeat(48))
  vi.stubEnv('RECORDING_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
  vi.stubEnv('LIVEKIT_API_KEY', 'APIabc123')
  vi.stubEnv('LIVEKIT_API_SECRET', 'b'.repeat(48))
  vi.stubEnv('DATABASE_URL', 'postgres://blinq:x@localhost/blinq')
  resetEnvCache()
}

function event(cookie?: string) {
  const req = new IncomingMessage(new Socket())
  if (cookie) req.headers.cookie = cookie
  return createEvent(req, new ServerResponse(req))
}

const setCookieHeader = (e: ReturnType<typeof event>) => [e.node.res.getHeader('set-cookie')].flat().join('\n')

afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvCache()
})

describe('cookie names', () => {
  it('uses the __Host- prefix only for secure origins', () => {
    expect(sessionCookieName(true)).toBe('__Host-blinq_session')
    expect(sessionCookieName(false)).toBe('blinq_session')
    expect(guestCookieName('abc-defg-hjk', true)).toBe('__Host-blinq_g_abc-defg-hjk')
    expect(guestCookieName('abc-defg-hjk', false)).toBe('blinq_g_abc-defg-hjk')
  })

  it('refuses slugs that are not in the documented format', () => {
    expect(() => guestCookieName('abc-defg-hjk; Path=/x', false)).toThrow(TypeError)
    expect(() => guestCookieName('ABC-DEFG-HJK', false)).toThrow(TypeError)
  })

  it('follows env().secureCookies by default', () => {
    useEnv('https://meet.example.test')
    expect(sessionCookieName()).toBe('__Host-blinq_session')
    useEnv('http://localhost:3001')
    expect(sessionCookieName()).toBe('blinq_session')
  })
})

describe('session cookie', () => {
  it('sets HttpOnly, Secure, SameSite=Lax, Path=/ and 30 days on https', () => {
    useEnv('https://meet.example.test')
    const e = event()
    const token = randomToken()
    setSessionCookie(e, token)
    const header = setCookieHeader(e)
    expect(header).toContain(`__Host-blinq_session=${token}`)
    expect(header).toContain('Max-Age=2592000')
    expect(header).toContain('Path=/')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    expect(header).not.toContain('Domain')
  })

  it('omits Secure on plain http and clears with Max-Age=0', () => {
    useEnv('http://localhost:3001')
    const e = event()
    clearSessionCookie(e)
    const header = setCookieHeader(e)
    expect(header).toContain('blinq_session=;')
    expect(header).toContain('Max-Age=0')
    expect(header).not.toContain('Secure')
  })

  it('reads only well-formed tokens', () => {
    useEnv('http://localhost:3001')
    const token = randomToken()
    expect(readSessionToken(event(`blinq_session=${token}`))).toBe(token)
    expect(readSessionToken(event('blinq_session=short'))).toBeNull()
    expect(readSessionToken(event(`__Host-blinq_session=${token}`))).toBeNull()
    expect(readSessionToken(event())).toBeNull()
  })
})

describe('guest cookie', () => {
  it('is scoped per room slug and expires with the guest session', () => {
    useEnv('https://meet.example.test')
    const e = event()
    const token = randomToken()
    const now = new Date('2026-09-30T10:00:00Z')
    setGuestCookie(e, 'abc-defg-hjk', token, { expiresAt: new Date(now.getTime() + 12 * 3600_000), now }) // injected clock (F-047)
    const header = setCookieHeader(e)
    expect(header).toContain(`__Host-blinq_g_abc-defg-hjk=${token}`)
    expect(header).toMatch(/Max-Age=43200(;|$)/)
    expect(header).toContain('HttpOnly')
    expect(readGuestToken(event(`__Host-blinq_g_abc-defg-hjk=${token}`), 'abc-defg-hjk')).toBe(token)
    expect(readGuestToken(event(`__Host-blinq_g_abc-defg-hjk=${token}`), 'xyz-defg-hjk')).toBeNull()
    const cleared = event()
    clearGuestCookie(cleared, 'abc-defg-hjk')
    expect(setCookieHeader(cleared)).toContain('Max-Age=0')
  })
})
