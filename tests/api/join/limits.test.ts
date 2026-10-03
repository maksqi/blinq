/**
 * Join limits (docs/API.md §6): lock, capacity, guest policy (server and room), password with backoff, removed and
 * denied being final for the meeting, the waiting-room cap and the join-ip limiter.
 */
import { describe, expect, it } from 'vitest'
import {
  createClient,
  createParticipant,
  createRoom,
  createRoomInvite,
  createUser,
  expectApiError,
  loginAs,
  uniqueIp,
} from '../_harness'
import { join, joinGuest, joinUser, requestRow, setSetting, startMeeting } from '../rooms/_support'

describe('lock', () => {
  it('rejects participants of a locked room; hosts and co-hosts get in', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { locked: true, waitingRoom: false })
    expectApiError((await joinGuest(room)).res, 403, 'ROOM_LOCKED')
    expectApiError((await joinUser(room)).res, 403, 'ROOM_LOCKED')
    expect((await join(await loginAs(owner), room)).status).toBe(200)
  })

  it('applies a lock set during the meeting', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    expect((await host.api.patch(`/api/calls/${room.id}/settings`, { body: { locked: true } })).status).toBe(200)
    expectApiError((await joinGuest(room)).res, 403, 'ROOM_LOCKED')
    expect((await host.api.patch(`/api/calls/${room.id}/settings`, { body: { locked: false } })).status).toBe(200)
    expect((await joinGuest(room)).res.status).toBe(200)
  })
})

describe('capacity', () => {
  it('counts admitted and joined participants against maxParticipants', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { maxParticipants: 2, waitingRoom: false })
    await startMeeting(room, owner)
    await joinGuest(room, { expectStatus: 200 })
    expectApiError((await joinGuest(room)).res, 409, 'ROOM_FULL')
    // Even the host's second tab does not fit.
    expectApiError(await join(await loginAs(owner), room), 409, 'ROOM_FULL')
  })

  it('re-checks capacity when a waiting request is admitted', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { maxParticipants: 2, waitingRoom: true })
    const host = await startMeeting(room, owner)
    const first = await joinGuest(room, { expectStatus: 202 })
    const second = await joinGuest(room, { expectStatus: 202 })
    expect((await host.api.post(`/api/calls/${room.id}/lobby/${first.res.body.requestId}/admit`)).status).toBe(204)
    expectApiError(await host.api.post(`/api/calls/${room.id}/lobby/${second.res.body.requestId}/admit`), 409, 'ROOM_FULL')
    expect((await requestRow(second.res.body.requestId))!.status).toBe('waiting')
  })
})

describe('guests', () => {
  it('refuses guests when the room disallows them; users still get in', async () => {
    const room = await createRoom(await createUser(), { allowGuests: false, waitingRoom: false })
    expectApiError((await joinGuest(room)).res, 403, 'ROOM_GUESTS_NOT_ALLOWED')
    expect((await joinUser(room)).res.status).toBe(200)
    const info = await createClient().post(`/api/join/${room.slug}/info`, { body: { proof: room.proof } })
    expect(info.body.guestsAllowed).toBe(false)
  })

  it('refuses guests when the server setting guests.allowed is off', async () => {
    const room = await createRoom(await createUser(), { waitingRoom: false })
    await setSetting('guests.allowed', false)
    try {
      expectApiError((await joinGuest(room)).res, 403, 'ROOM_GUESTS_NOT_ALLOWED')
      expect((await createClient().post(`/api/join/${room.slug}/info`, { body: { proof: room.proof } })).body.guestsAllowed).toBe(false)
      expect((await joinUser(room)).res.status).toBe(200)
    } finally {
      await setSetting('guests.allowed', null)
    }
  })

  it('needs a display name from guests', async () => {
    const room = await createRoom(await createUser(), { waitingRoom: false })
    const invite = await createRoomInvite(room)
    const res = await join(createClient(), room, { inviteToken: invite.token })
    expectApiError(res, 400, 'VALIDATION_FAILED')
    expect(res.body.data.details.issues[0].path).toBe('displayName')
  })
})

describe('room password', () => {
  it('requires the password, rejects a wrong one and backs off per IP and room', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { password: 'correct horse', waitingRoom: false })
    const api = createClient({ ip: uniqueIp() })
    const invite = await createRoomInvite(room)
    expectApiError(await join(api, room, { inviteToken: invite.token, displayName: 'G' }), 403, 'ROOM_PASSWORD_REQUIRED')
    for (let i = 0; i < 5; i++) {
      expectApiError(await join(api, room, { inviteToken: invite.token, displayName: 'G', password: 'wrong' }), 403, 'ROOM_PASSWORD_INVALID')
    }
    // Sixth failure: backoff starts (2 s), even with the right password.
    expectApiError(await join(api, room, { inviteToken: invite.token, displayName: 'G', password: 'wrong' }), 403, 'ROOM_PASSWORD_INVALID')
    const limited = await join(api, room, { inviteToken: invite.token, displayName: 'G', password: 'correct horse' })
    expectApiError(limited, 429, 'RATE_LIMITED')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    // Another IP is not affected; the host never needs the password.
    expect((await join(createClient({ ip: uniqueIp() }), room, { inviteToken: invite.token, displayName: 'G', password: 'correct horse' })).status).toBe(200)
    expect((await join(await loginAs(owner), room)).status).toBe(200)
  })

  it('counts parallel guesses before checking them: 25 at once give 6 wrong-password answers (F-026)', async () => {
    const room = await createRoom(await createUser(), { password: 'correct horse', waitingRoom: false })
    const invite = await createRoomInvite(room)
    const api = createClient({ ip: uniqueIp() })
    const results = await Promise.all(
      Array.from({ length: 25 }, () => join(api, room, { inviteToken: invite.token, displayName: 'G', password: 'wrong' })),
    )
    const statuses = results.map((res) => res.status)
    expect(statuses.filter((status) => status === 403)).toHaveLength(6)
    expect(statuses.filter((status) => status === 429)).toHaveLength(19)
    for (const res of results.filter((r) => r.status === 403)) expectApiError(res, 403, 'ROOM_PASSWORD_INVALID')
    for (const res of results.filter((r) => r.status === 429)) {
      expectApiError(res, 429, 'RATE_LIMITED')
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('removed and denied are final for the meeting', () => {
  it('keeps a removed participant out, with a new invite and a new tab too', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: false })
    const host = await startMeeting(room, owner)
    const user = await createUser()
    const guestTab = await joinUser(room, { user, expectStatus: 200 })
    expect((await host.api.post(`/api/calls/${room.id}/participants/${guestTab.identity}/remove`)).status).toBe(204)
    expectApiError((await joinUser(room, { user })).res, 403, 'JOIN_REMOVED')
  })

  it('keeps a denied guest out of the same meeting', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: true })
    const host = await startMeeting(room, owner)
    const guest = await joinGuest(room, { expectStatus: 202 })
    expect((await host.api.post(`/api/calls/${room.id}/lobby/${guest.res.body.requestId}/deny`)).status).toBe(204)
    expectApiError((await joinGuest(room, { api: guest.api })).res, 403, 'JOIN_DENIED')
  })

  it('lets them try again in the next meeting', async () => {
    const owner = await createUser()
    const room = await createRoom(owner, { waitingRoom: true })
    const host = await startMeeting(room, owner)
    const guest = await joinGuest(room, { expectStatus: 202 })
    await host.api.post(`/api/calls/${room.id}/lobby/${guest.res.body.requestId}/deny`)
    expect((await host.api.post(`/api/calls/${room.id}/end`)).status).toBe(204)
    expect((await joinGuest(room, { api: guest.api })).res.status).toBe(202)
  })
})

describe('waiting room cap and join-ip limiter', () => {
  it('holds at most 50 waiting requests per room', async () => {
    const room = await createRoom(await createUser(), { waitingRoom: true })
    for (let i = 0; i < 50; i++) await createParticipant({ room, meeting: null, status: 'waiting' })
    expectApiError((await joinGuest(room)).res, 409, 'LOBBY_FULL')
  })

  it('allows 30 join requests per IP and minute', async () => {
    const room = await createRoom(await createUser())
    const api = createClient({ ip: uniqueIp() })
    for (let i = 0; i < 30; i++) {
      expect((await api.post(`/api/join/${room.slug}/info`, { body: { proof: room.proof } })).status).toBe(200)
    }
    const limited = await api.post(`/api/join/${room.slug}/info`, { body: { proof: room.proof } })
    expectApiError(limited, 429, 'RATE_LIMITED')
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })
})
