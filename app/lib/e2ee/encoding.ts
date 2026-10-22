/** Byte helpers shared by the E2EE modules. No external dependencies; runs in browsers and Node 24. */

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(text) as Uint8Array<ArrayBuffer>
}

export function fromUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes)
}

/** RFC 4648 base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const BASE64URL = /^[A-Za-z0-9_-]*$/

/** Strict base64url decoder: rejects padding, whitespace and non-alphabet characters. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    throw new TypeError('Invalid base64url string')
  }
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
