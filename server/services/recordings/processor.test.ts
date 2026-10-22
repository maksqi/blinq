import { describe, expect, it } from 'vitest'
import { readyColumns } from './processor'

describe('readyColumns', () => {
  it('dates processing and retention from the injected clock (F-047)', () => {
    const processedAt = new Date('2026-10-03T12:00:00Z')
    const id = '0192d2f4-7a3b-7cde-8f01-23456789abcd'
    const columns = readyColumns(id, { kind: 'ready', sizeBytes: 10, durationMs: 2_000, width: 1280, height: 720 }, processedAt, 30)
    expect(columns).toEqual({
      status: 'ready',
      error: null,
      storageKey: `${id}/recording.blq1`,
      sizeBytes: 10,
      durationMs: 2_000,
      width: 1280,
      height: 720,
      processedAt,
      expiresAt: new Date('2026-11-02T12:00:00Z'),
    })
  })
})
