/**
 * Session and guest cookies (server-core, docs/API.md §13).
 *
 * - `sessionCookieName()`: `__Host-blinq_session` when `env().secureCookies` (https PUBLIC_URL), else
 *   `blinq_session` (browsers reject `__Host-` and Secure cookies on plain http).
 * - `guestCookieName(slug)`: `__Host-blinq_g_<slug>` / `blinq_g_<slug>`.
 * - `setSessionCookie(event, token)` (Max-Age 30 d), `clearSessionCookie(event)`, `readSessionToken(event)`.
 * - `setGuestCookie(event, slug, token, { expiresAt })`, `clearGuestCookie(event, slug)`, `readGuestToken(event, slug)`.
 * Attributes: HttpOnly, SameSite=Lax, Path=/, Secure when `secureCookies`. Readers return null for anything that
 * is not a well-formed 43-character token.
 */
import { deleteCookie, getCookie, setCookie, type H3Event } from 'h3'
import { slugSchema } from '#shared/schemas/common'
import { isOpaqueToken } from './crypto'
import { env } from './env'

export const SESSION_COOKIE_MAX_AGE_SEC = 30 * 24 * 3600

const secureDefault = () => env().secureCookies

export function sessionCookieName(secure = secureDefault()): string {
  return secure ? '__Host-blinq_session' : 'blinq_session'
}

export function guestCookieName(slug: string, secure = secureDefault()): string {
  // The slug becomes part of a header name: accept only the documented format.
  if (!slugSchema.safeParse(slug).success) throw new TypeError('Invalid room slug for a guest cookie')
  return `${secure ? '__Host-' : ''}blinq_g_${slug}`
}

export function cookieAttributes(secure = secureDefault()) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' }
}

export function setSessionCookie(event: H3Event, token: string, options: { maxAgeSec?: number } = {}): void {
  setCookie(event, sessionCookieName(), token, {
    ...cookieAttributes(),
    maxAge: options.maxAgeSec ?? SESSION_COOKIE_MAX_AGE_SEC,
  })
}

export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, sessionCookieName(), cookieAttributes())
}

export function readSessionToken(event: H3Event): string | null {
  const value = getCookie(event, sessionCookieName())
  return isOpaqueToken(value) ? value : null
}

export function setGuestCookie(
  event: H3Event,
  slug: string,
  token: string,
  options: { expiresAt: Date; now?: Date },
): void {
  const now = options.now ?? new Date()
  const maxAge = Math.max(0, Math.floor((options.expiresAt.getTime() - now.getTime()) / 1000))
  setCookie(event, guestCookieName(slug), token, { ...cookieAttributes(), maxAge })
}

export function clearGuestCookie(event: H3Event, slug: string): void {
  deleteCookie(event, guestCookieName(slug), cookieAttributes())
}

export function readGuestToken(event: H3Event, slug: string): string | null {
  const value = getCookie(event, guestCookieName(slug))
  return isOpaqueToken(value) ? value : null
}
