/**
 * Reading a request body whose size is not declared (server-core, F-025).
 *
 * - `readBodyWithLimit(stream, limit)` → the whole body as a Buffer, or rejects with `BodyTooLargeError` as soon as
 *   more than `limit` bytes arrived (it stops listening; the rest is never buffered). What happens to the rest is the
 *   caller's choice: `stream.resume()` discards it, which lets the client read the answer before the connection ends.
 */
import type { Readable } from 'node:stream'

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

export function readBodyWithLimit(stream: Readable, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buffer.length
      if (size > limit) {
        cleanup()
        reject(new BodyTooLargeError(limit))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
    stream.on('error', onError)
  })
}
