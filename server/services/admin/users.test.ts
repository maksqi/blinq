import { describe, expect, it } from 'vitest'
import { cleanupBeforeUserDelete, type UserCleanupSteps } from './users'

const USER = '01890000-0000-7000-8000-0000000000aa'

function recordingSteps(failAt?: keyof UserCleanupSteps) {
  const calls: string[] = []
  const step = (name: keyof UserCleanupSteps) => async (userId: string) => {
    calls.push(`${name}:${userId}`)
    if (name === failAt) throw new Error(`${name} failed`)
  }
  const steps: UserCleanupSteps = {
    endMeetingsOfOwner: step('endMeetingsOfOwner'),
    deleteRecordingsForUser: step('deleteRecordingsForUser'),
  }
  return { calls, steps }
}

describe('cleanupBeforeUserDelete', () => {
  it('ends meetings, then deletes recording files (the users service already left live calls, F-001)', async () => {
    const { calls, steps } = recordingSteps()
    await cleanupBeforeUserDelete(USER, steps)
    expect(calls).toEqual([`endMeetingsOfOwner:${USER}`, `deleteRecordingsForUser:${USER}`])
  })

  it('stops at the first failure so the account is not deleted half-cleaned', async () => {
    const { calls, steps } = recordingSteps('endMeetingsOfOwner')
    await expect(cleanupBeforeUserDelete(USER, steps)).rejects.toThrow('endMeetingsOfOwner failed')
    expect(calls).toEqual([`endMeetingsOfOwner:${USER}`])
  })
})
