/**
 * The real RoomServiceAdapter against the dev LiveKit (docs/TESTING.md §5.4). Runs only when the harness uses a real
 * LiveKit (`API_LIVEKIT_URL=http://127.0.0.1:7880`); every room it creates has a unique name and is deleted again.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createLivekitRoomService, isLivekitNotFound } from '../../../server/services/livekit/room-service'
import { buildParticipantToken, newIdentity } from '../../../server/services/livekit/token'
import { serverEnv } from '../_harness'
import { usesFakeLivekit } from './_support'

describe.skipIf(usesFakeLivekit())('RoomServiceAdapter against LiveKit', () => {
  const env = serverEnv()
  const service = createLivekitRoomService({ url: env.LIVEKIT_URL!, apiKey: env.LIVEKIT_API_KEY!, apiSecret: env.LIVEKIT_API_SECRET! })
  const created: string[] = []
  const roomName = () => {
    const name = `blinq-api-test-${randomUUID()}`
    created.push(name)
    return name
  }
  const create = (name: string, metadata = '{"v":1}') =>
    service.createRoom({ name, maxParticipants: 3, emptyTimeoutSec: 60, departureTimeoutSec: 20, metadata })

  afterAll(async () => {
    for (const name of created) await service.deleteRoom(name)
  })

  it('creates, lists, updates and deletes rooms', async () => {
    const name = roomName()
    const { sid } = await create(name)
    expect(sid).toMatch(/^RM_/)
    expect(await service.listRooms([name])).toEqual([
      { name, sid, numParticipants: 0, createdAt: expect.any(Date), metadata: '{"v":1}' },
    ])
    await service.updateRoomMetadata(name, '{"v":2}')
    expect((await service.listRooms([name]))[0]!.metadata).toBe('{"v":2}')
    // createRoom on an existing room returns it (the app deletes leftovers before a new meeting).
    expect((await create(name, '{"v":3}')).sid).toBe(sid)
    await service.deleteRoom(name)
    expect(await service.listRooms([name])).toEqual([])
    await expect(service.deleteRoom(name)).resolves.toBeUndefined()
  })

  it('answers missing rooms and participants the adapter way', async () => {
    const name = roomName()
    expect(await service.listParticipants(name)).toEqual([])
    expect(await service.getParticipant(name, newIdentity())).toBeNull()
    await expect(service.removeParticipant(name, newIdentity(), { revokeTokensIssuedBefore: new Date() })).resolves.toBeUndefined()
    expect(isLivekitNotFound(await service.updateRoomMetadata(name, '{}').catch((error: unknown) => error))).toBe(true)
    await create(name)
    expect(await service.getParticipant(name, newIdentity())).toBeNull()
    expect(isLivekitNotFound(await service.updateParticipant(name, newIdentity(), { name: 'x' }).catch((error: unknown) => error))).toBe(true)
    const payload = new TextEncoder().encode('{"type":"lobby.changed"}')
    await expect(service.sendData(name, payload, { topic: 'blinq.srv.v1', destinationIdentities: [] })).resolves.toBeUndefined()
    await expect(service.sendData(name, payload, { topic: 'blinq.srv.v1', destinationIdentities: [newIdentity()] })).resolves.toBeUndefined()
  })

  it('accepts join tokens only for rooms the server created (auto_create is off)', async () => {
    const name = roomName()
    const token = await buildParticipantToken({
      apiKey: env.LIVEKIT_API_KEY!,
      apiSecret: env.LIVEKIT_API_SECRET!,
      roomName: name,
      identity: newIdentity(),
      name: 'Probe',
      role: 'participant',
      kind: 'guest',
      micAllowed: true,
      cameraAllowed: true,
      handRaisedAt: null,
      volumeLevel: 100,
      policy: { screenSharePolicy: 'everyone' },
    })
    const validate = () => fetch(new URL(`/rtc/validate?access_token=${token}`, env.LIVEKIT_URL))
    expect((await validate()).status).toBe(404)
    await create(name)
    expect((await validate()).status).toBe(200)
  })
})
