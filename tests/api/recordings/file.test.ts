/**
 * GET /api/recordings/:id/file: exact Range responses decrypted from BLQ1, every security header, downloads with an
 * RFC 5987 file name, integrity failures, and states that are never served.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { recordings } from '../../../server/database/schema'
import { createRoom, expectApiError, testDb, type ApiClient } from '../_harness'
import { liveCall, seedReadyRecording } from './_support'

const SEGMENT = 4096

async function fileRequest(client: ApiClient, id: string, headers: Record<string, string> = {}, query = '') {
  return fetch(new URL(`/api/recordings/${id}/file${query}`, client.baseUrl), {
    headers: { cookie: client.cookieHeader(), 'x-forwarded-for': client.ip, ...headers },
  })
}

async function seeded(options: { roomName?: string; size?: number } = {}) {
  const call = await liveCall()
  const room = options.roomName ? await createRoom(call.owner, { name: options.roomName }) : call.room
  const recording = await seedReadyRecording({
    createdBy: call.owner.id,
    roomId: room.id,
    plaintext: randomBytes(options.size ?? 13 * SEGMENT + 123),
    segmentSize: SEGMENT,
    startedAt: new Date('2026-09-28T12:34:56Z'),
  })
  return { ...call, room, recording }
}

function expectFileHeaders(res: Response) {
  expect(res.headers.get('content-type')).toBe('video/mp4')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('accept-ranges')).toBe('bytes')
  expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin') // F-028
}

describe('recording file', () => {
  it('serves the whole decrypted file with every header', async () => {
    const { client, recording } = await seeded()
    const res = await fileRequest(client, recording.id)
    expect(res.status).toBe(200)
    expectFileHeaders(res)
    expect(res.headers.get('content-length')).toBe(String(recording.plaintext.length))
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="blinq-recording\.mp4"; filename\*=UTF-8''blinq-/)
    expect(Buffer.from(await res.arrayBuffer()).equals(recording.plaintext)).toBe(true)
  })

  it('answers exact bytes for many ranges, including every segment boundary', async () => {
    const { client, recording } = await seeded()
    const size = recording.plaintext.length
    const ranges: Array<[number, number]> = [
      [0, 0],
      [0, SEGMENT - 1],
      [SEGMENT - 1, SEGMENT],
      [SEGMENT, 2 * SEGMENT - 1],
      [3 * SEGMENT - 7, 5 * SEGMENT + 7],
      [size - 1, size - 1],
      [13 * SEGMENT, size - 1],
    ]
    for (let i = 0; i < 15; i++) {
      const a = Math.floor(Math.random() * size)
      ranges.push([a, a + Math.floor(Math.random() * (size - a))])
    }
    for (const [a, b] of ranges) {
      const res = await fileRequest(client, recording.id, { range: `bytes=${a}-${b}` })
      expect(res.status, `bytes=${a}-${b}`).toBe(206)
      expectFileHeaders(res)
      expect(res.headers.get('content-range')).toBe(`bytes ${a}-${b}/${size}`)
      expect(res.headers.get('content-length')).toBe(String(b - a + 1))
      expect(Buffer.from(await res.arrayBuffer()).equals(recording.plaintext.subarray(a, b + 1)), `bytes=${a}-${b}`).toBe(true)
    }
    const suffix = await fileRequest(client, recording.id, { range: 'bytes=-500' })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe(`bytes ${size - 500}-${size - 1}/${size}`)
    expect(Buffer.from(await suffix.arrayBuffer()).equals(recording.plaintext.subarray(size - 500))).toBe(true)
    const open = await fileRequest(client, recording.id, { range: `bytes=${SEGMENT * 2}-` })
    expect(open.status).toBe(206)
    expect(Buffer.from(await open.arrayBuffer()).equals(recording.plaintext.subarray(SEGMENT * 2))).toBe(true)
    const clamped = await fileRequest(client, recording.id, { range: `bytes=${size - 10}-${size + 1000}` })
    expect(clamped.headers.get('content-range')).toBe(`bytes ${size - 10}-${size - 1}/${size}`)
  })

  it('answers 416 with bytes */size for unsatisfiable ranges and ignores multiple ranges', async () => {
    const { client, recording } = await seeded()
    const size = recording.plaintext.length
    const res = await fileRequest(client, recording.id, { range: `bytes=${size}-` })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${size}`)
    const multi = await fileRequest(client, recording.id, { range: 'bytes=0-1,5-6' })
    expect(multi.status).toBe(200)
    expect(Buffer.from(await multi.arrayBuffer()).equals(recording.plaintext)).toBe(true)
  })

  it('switches to an attachment with an RFC 5987 name built from room name and date', async () => {
    // Non-ASCII test data is written as escapes (docs/TESTING.md §3): "Cafe" with an acute e, two CJK characters, a camera.
    const roomName = 'Caf\u00e9 \u65e5\u672c \u{1F3A5}'
    const { client, recording } = await seeded({ roomName })
    const res = await fileRequest(client, recording.id, {}, '?download=1')
    expect(res.status).toBe(200)
    const expected = encodeURIComponent(`blinq-${roomName}-2026-09-28.mp4`)
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="blinq-recording.mp4"; filename*=UTF-8''${expected}`)
  })

  it('strips quotes, path separators and invisible characters from the file name', async () => {
    // A right-to-left override and a zero-width space between "d" and "x".
    const { client, recording } = await seeded({ roomName: 'a"b/c\\d\u202e\u200bx (1)*' })
    const res = await fileRequest(client, recording.id)
    const disposition = res.headers.get('content-disposition')!
    expect(disposition).toBe(`inline; filename="blinq-recording.mp4"; filename*=UTF-8''blinq-a%20b%20c%20dx%20%281%29-2026-09-28.mp4`)
    await res.arrayBuffer()
  })

  it('fails with 500 before sending anything when the covering segment or the end of the file is damaged', async () => {
    const { client, recording } = await seeded()
    const original = readFileSync(recording.path)
    const tampered = Buffer.from(original)
    const inSegment5 = 49 + 5 * (SEGMENT + 16) + 10
    tampered[inSegment5]! ^= 0x01
    writeFileSync(recording.path, tampered)
    // Ranges that avoid the damaged segment still work: only covering segments are decrypted.
    const early = await fileRequest(client, recording.id, { range: `bytes=0-${SEGMENT - 1}` })
    expect(early.status).toBe(206)
    expect(Buffer.from(await early.arrayBuffer()).equals(recording.plaintext.subarray(0, SEGMENT))).toBe(true)
    const damaged = await fileRequest(client, recording.id, { range: `bytes=${5 * SEGMENT}-${5 * SEGMENT + 10}` })
    expect(damaged.status).toBe(500)
    expect((await damaged.json()).data.code).toBe('INTERNAL')
    // A full download starts fine and is cut off at the damaged segment: the client never gets the whole file.
    const full = await fileRequest(client, recording.id)
    expect(full.status).toBe(200)
    await expect(full.arrayBuffer()).rejects.toThrow()

    writeFileSync(recording.path, original)
    truncateSync(recording.path, original.length - 100)
    const truncated = await fileRequest(client, recording.id, { range: 'bytes=0-10' })
    expect(truncated.status).toBe(500)
  })

  it('never serves recordings that are not ready: 409 while recording or processing, 404 when failed or local', async () => {
    const { client, owner, room, recording } = await seeded()
    for (const [status, expected] of [
      ['recording', 409],
      ['processing', 409],
      ['failed', 404],
    ] as const) {
      await testDb().update(recordings).set({ status }).where(eq(recordings.id, recording.id))
      const res = await client.get(`/api/recordings/${recording.id}/file`)
      expectApiError(res, expected, expected === 409 ? 'RECORDING_NOT_READY' : 'NOT_FOUND')
    }
    const local = await seedReadyRecording({ createdBy: owner.id, roomId: room.id })
    await testDb().update(recordings).set({ mode: 'local', storageKey: null }).where(eq(recordings.id, local.id))
    expectApiError(await client.get(`/api/recordings/${local.id}/file`), 404, 'NOT_FOUND')
  })
})
