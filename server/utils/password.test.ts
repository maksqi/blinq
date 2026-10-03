import { H3Error } from 'h3'
import { describe, expect, it } from 'vitest'
import { COMMON_PASSWORDS } from './common-passwords'
import {
  ARGON2_PARAMS,
  checkPasswordPolicy,
  HASHING_CONCURRENCY,
  HASHING_MAX_WAITING,
  hashPassword,
  isCommonPassword,
  passwordHashingSaturated,
  passwordNeedsRehash,
  verifyAgainstDummy,
  verifyPassword,
} from './password'

/** Cheap argon2 cost, allowed only through the explicit test option. */
const fast = { testParams: { memoryCost: 1024, timeCost: 1 } }

describe('hashPassword / verifyPassword', () => {
  it('uses argon2id with the OWASP parameters by default', async () => {
    const hashed = await hashPassword('correct horse battery staple')
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(passwordNeedsRehash(hashed)).toBe(false)
    expect(ARGON2_PARAMS).toEqual({ algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 })
  })

  it('verifies the right password only', async () => {
    const hashed = await hashPassword('a sufficiently long password', fast)
    expect(await verifyPassword(hashed, 'a sufficiently long password')).toBe(true)
    expect(await verifyPassword(hashed, 'a sufficiently long passworD')).toBe(false)
    expect(await verifyPassword(hashed, '')).toBe(false)
  })

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'whatever')).toBe(false)
    expect(await verifyPassword('', 'whatever')).toBe(false)
  })

  it('refuses work beyond 4 running and 16 waiting hashes with 429 RATE_LIMITED (F-016)', async () => {
    expect(passwordHashingSaturated()).toBe(false)
    const pending = Promise.allSettled(
      Array.from({ length: HASHING_CONCURRENCY + HASHING_MAX_WAITING + 2 }, () => hashPassword('a flood of hashes', fast)),
    )
    expect(passwordHashingSaturated()).toBe(true)
    const results = await pending
    expect(passwordHashingSaturated()).toBe(false)
    const refused = results.filter((result) => result.status === 'rejected')
    expect(refused).toHaveLength(2)
    for (const result of refused) {
      const error = (result as PromiseRejectedResult).reason as H3Error
      expect(error).toBeInstanceOf(H3Error)
      expect(error.statusCode).toBe(429)
      expect(error.data).toEqual({ code: 'RATE_LIMITED', details: { retryAfter: 1 } })
    }
    // The queue drained: new work runs again.
    expect(await verifyPassword(await hashPassword('after the flood', fast), 'after the flood')).toBe(true)
  })

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password here', fast), hashPassword('same password here', fast)])
    expect(a).not.toBe(b)
  })

  it('flags hashes made with other parameters for rehash', async () => {
    expect(passwordNeedsRehash(await hashPassword('another long password', fast))).toBe(true)
    expect(passwordNeedsRehash('garbage')).toBe(true)
  })

  it('verifyAgainstDummy always fails', async () => {
    expect(await verifyAgainstDummy('any password at all')).toBe(false)
    expect(await verifyAgainstDummy('')).toBe(false)
  })
})

describe('checkPasswordPolicy', () => {
  it('enforces 12..256 characters', () => {
    expect(checkPasswordPolicy('Tr0ub4dor&3')).toEqual({ ok: false, reason: 'too_short' })
    expect(checkPasswordPolicy('x7!'.repeat(86))).toEqual({ ok: false, reason: 'too_long' })
    expect(checkPasswordPolicy('violet-harbor-lantern-42')).toEqual({ ok: true })
    expect(checkPasswordPolicy('kX9#mQ2$vL7p')).toEqual({ ok: true })
  })

  it.each([
    'password1234',
    'Password2024!',
    'P@ssw0rd2024',
    '!!letmein123!',
    'qwerty123456',
    'QWERTYUIOPASDF',
    '1q2w3e4r5t6y',
    'zaq12wsxcde3',
    '123456789012',
    '098765432109',
    'abcdefghijkl',
    'aaaaaaaaaaaa',
    'abcabcabcabc',
    '121212121212',
    'iloveyou1234',
    'correcthorsebatterystaple',
    'Blinq2024!!!',
    'zoommeeting1',
  ])('rejects the common password %s', (password) => {
    expect(isCommonPassword(password)).toBe(true)
    expect(checkPasswordPolicy(password)).toEqual({ ok: false, reason: 'common' })
  })

  it.each(['violet-harbor-lantern-42', 'my cat eats 3 lemons daily', 'Glacier.Paper.Moth.19', 'kX9#mQ2$vL7p'])(
    'accepts %s',
    (password) => {
      expect(isCommonPassword(password)).toBe(false)
    },
  )

  it('ships a lowercase ASCII denylist without duplicates', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(300)
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length)
    for (const entry of COMMON_PASSWORDS) expect(entry).toMatch(/^[\x21-\x7e]+$/)
    for (const entry of COMMON_PASSWORDS) expect(entry).toBe(entry.toLowerCase())
  })

  it('handles non-ASCII passwords without false positives', () => {
    // A Cyrillic passphrase, built from code points (the repository is English-only).
    const cyrillic = `${String.fromCodePoint(0x43f, 0x430, 0x440, 0x43e, 0x43b, 0x44c)}-${String.fromCodePoint(0x434, 0x43b, 0x438, 0x43d, 0x43d, 0x44b, 0x439)}-42`
    expect(checkPasswordPolicy(cyrillic)).toEqual({ ok: true })
  })
})
