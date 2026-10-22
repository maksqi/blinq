import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { BodyTooLargeError, readBodyWithLimit } from './body-limit'

describe('readBodyWithLimit', () => {
  it('returns the whole body when it fits', async () => {
    const body = await readBodyWithLimit(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]), 7)
    expect(body.toString()).toBe('{"a":1}')
  })

  it('rejects as soon as the limit is passed and stops reading (F-025)', async () => {
    const stream = new PassThrough()
    const result = readBodyWithLimit(stream, 10)
    stream.write(Buffer.alloc(6))
    stream.write(Buffer.alloc(6))
    await expect(result).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(stream.listenerCount('data')).toBe(0)
    stream.destroy()
  })

  it('passes stream errors on', async () => {
    const stream = new PassThrough()
    const result = readBodyWithLimit(stream, 10)
    stream.destroy(new Error('socket hang up'))
    await expect(result).rejects.toThrow('socket hang up')
  })
})
