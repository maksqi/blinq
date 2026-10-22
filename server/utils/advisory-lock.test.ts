import { describe, expect, it } from 'vitest'
import { lockRetryDelayMs } from './advisory-lock'

describe('lockRetryDelayMs', () => {
  it('doubles from 5 ms up to 100 ms', () => {
    const max = () => 0.999_999
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((attempt) => Math.round(lockRetryDelayMs(attempt, max)))).toEqual([
      5, 10, 20, 40, 80, 100, 100, 100,
    ])
  })

  it('jitters down to half the step, so waiters do not retry in lockstep', () => {
    expect(lockRetryDelayMs(0, () => 0)).toBe(2.5)
    expect(lockRetryDelayMs(10, () => 0)).toBe(50)
  })
})
