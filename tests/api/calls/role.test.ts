/**
 * Role changes against an in-process fake LiveKit with a running screen share (the HTTP fake cannot publish one): a
 * co-host demoted under the "hosts" share policy has the share muted at once (F-046).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changeRole } from '../../../server/services/calls/actions'
import { actorOf } from '../../../server/services/calls/authorize'
import { createFakeRoomService, type FakeRoomService } from '../../../server/services/livekit/fake-room-service'
import { setRoomServiceForTesting } from '../../../server/services/livekit/room-service'
import {
  createMeeting,
  createParticipant,
  createRoom,
  createUser,
  fakeEvent,
  useServerEnvInProcess,
} from '../_harness'

useServerEnvInProcess()

let fake: FakeRoomService

beforeEach(() => {
  fake = createFakeRoomService()
  setRoomServiceForTesting(fake)
})

afterEach(() => setRoomServiceForTesting(undefined))

async function sharingCohost(policy: 'hosts' | 'everyone') {
  const owner = await createUser()
  const room = await createRoom(owner, { screenSharePolicy: policy })
  const meeting = await createMeeting(room)
  const host = await createParticipant({ room, meeting, userId: owner.id, role: 'host' })
  const cohost = await createParticipant({ room, meeting, userId: (await createUser()).id, role: 'cohost' })
  await fake.createRoom({ name: room.id, maxParticipants: 25, emptyTimeoutSec: 60, departureTimeoutSec: 20, metadata: '{}' })
  fake.simulateTracks(room.id, cohost.lkIdentity, [{ source: 'camera' }, { source: 'screen_share' }, { source: 'screen_share_audio' }])
  const ctx = { caller: host, actor: actorOf(host), room, meetingId: meeting.id, target: cohost }
  return { cohost, ctx }
}

const mutedTracks = () => fake.calls.filter((call) => call.method === 'mutePublishedTrack').map((call) => call.args[2])

describe('changeRole', () => {
  it('mutes the screen share of a co-host demoted under the "hosts" policy', async () => {
    const { cohost, ctx } = await sharingCohost('hosts')
    await changeRole(fakeEvent(), ctx, 'participant')
    const update = fake.calls.find((call) => call.method === 'updateParticipant')!
    const sources = (update.args[2] as { permission: { canPublishSources: string[] } }).permission.canPublishSources
    expect(sources).not.toContain('screen_share')
    expect(mutedTracks()).toEqual([`TR_screen_share_${cohost.lkIdentity}`, `TR_screen_share_audio_${cohost.lkIdentity}`])
  })

  it('leaves the share alone when everyone may share, and when promoting', async () => {
    const everyone = await sharingCohost('everyone')
    await changeRole(fakeEvent(), everyone.ctx, 'participant')
    expect(mutedTracks()).toEqual([])
    const hosts = await sharingCohost('hosts')
    await changeRole(fakeEvent(), hosts.ctx, 'cohost')
    expect(mutedTracks()).toEqual([])
  })
})
