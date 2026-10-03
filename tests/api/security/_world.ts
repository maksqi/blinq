/**
 * Shared setup for the security API suite (Stage 10, not a test file: Vitest only picks up *.test.ts).
 *
 * - `buildWorld()`: two live rooms and one client per subject of the authorization matrix:
 *   anonymous, guest of room A, guest of room B, participant, co-host, host, other user, admin, a disabled admin and an
 *   admin with a pending password change (both also co-hosts of room A with live rows, so only their account state can
 *   keep them out). Room A has an invite, a ready recording by the host and the host holds a spare session; room B has
 *   a waiting request owned by its guest.
 * - `fileRoutes()`: every handler under server/api as `{ method, pattern, file }` (`pattern` keeps the file's parameter
 *   names, e.g. `/api/rooms/:id/invites/:inviteId`).
 * - `send(client, method, path, options)`: a request that also works for SSE (headers only, then aborted).
 * - `snapshot(world)`: the state the rejected requests of a suite must leave alone.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray, or } from 'drizzle-orm'
import {
  callParticipants,
  meetings,
  recordings,
  roomInvites,
  roomMembers,
  rooms,
  sessions,
  settings,
  users,
} from '../../../server/database/schema'
import {
  type ApiClient,
  type ApiResponse,
  createAdmin,
  createClient,
  createGuestSession,
  createParticipant,
  createRoom,
  createRoomInvite,
  createSession,
  createUser,
  loginAs,
  REPO_ROOT,
  testDb,
  type TestRoom,
  type TestUser,
} from '../_harness'
import { seedReadyRecording } from '../recordings/_support'
import { type FakeCall, livekitCalls, participantRow, startMeeting } from '../rooms/_support'

export const SUBJECTS = [
  'anonymous',
  'guestA',
  'guestB',
  'participant',
  'cohost',
  'host',
  'otherUser',
  'admin',
  'disabled',
  'mustChange',
] as const

export type Subject = (typeof SUBJECTS)[number]

export interface FileRoute {
  method: string
  pattern: string
  file: string
}

/** Every handler file under server/api, the same way Nitro maps file names to routes. */
export function fileRoutes(): FileRoute[] {
  const root = join(REPO_ROOT, 'server/api')
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort()
  return files.map((file) => {
    const segments = file.replace(/\.ts$/, '').split(/[\\/]/)
    const match = segments.pop()!.match(/^(.+)\.(get|post|put|patch|delete)$/)
    if (!match) throw new Error(`Handler without an HTTP method suffix: server/api/${file}`)
    const parts = [...segments, match[1]!].filter((part) => part !== 'index').map((part) => part.replace(/^\[(.+)\]$/, ':$1'))
    return { method: match[2]!.toUpperCase(), pattern: `/api/${parts.join('/')}`, file: `server/api/${file}` }
  })
}

export const routeKey = (route: { method: string; pattern: string }) => `${route.method} ${route.pattern}`

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** A body every strict request schema rejects. */
export const PROBE_BODY = { __probe: true }

export interface Member {
  api: ApiClient
  identity: string
  rowId: string
}

export interface World {
  roomA: TestRoom
  roomB: TestRoom
  meetingA: string
  meetingB: string
  users: Record<'host' | 'cohost' | 'participant' | 'otherUser' | 'admin' | 'disabled' | 'mustChange' | 'ownerB', TestUser>
  clients: Record<Subject, ApiClient>
  /** Live rows in room A's meeting. */
  members: Record<'host' | 'cohost' | 'participant' | 'guestA' | 'disabled' | 'mustChange', Member>
  /** Guest session of room B and its live row. */
  guestB: { sessionId: string; rowId: string }
  inviteA: { id: string; token: string }
  /** A ready server recording made by the host in room A. */
  recordingA: string
  /** A waiting request in room B owned by the guest of room B. */
  requestB: string
  /** A second session of the host that no client uses. */
  hostSpareSession: string
}

async function memberRow(room: TestRoom, meetingId: string, user: TestUser, role: 'cohost' | 'participant'): Promise<Member> {
  if (role === 'cohost') await testDb().insert(roomMembers).values({ roomId: room.id, userId: user.id })
  const row = await createParticipant({ room, meeting: { id: meetingId }, userId: user.id, role, status: 'joined', displayName: user.displayName })
  return { api: await loginAs(user), identity: row.lkIdentity, rowId: row.id }
}

export async function buildWorld(): Promise<World> {
  const host = await createUser({ displayName: 'Hana Host' })
  const ownerB = await createUser({ displayName: 'Bea Owner' })
  const roomA = await createRoom(host, { waitingRoom: false })
  const roomB = await createRoom(ownerB, { waitingRoom: true })

  const joinedA = await startMeeting(roomA, host)
  const hostRow = (await participantRow(joinedA.identity))!
  const joinedB = await startMeeting(roomB, ownerB)
  const meetingA = hostRow.meetingId!
  const meetingB = (await participantRow(joinedB.identity))!.meetingId!

  const [cohost, participant, otherUser, admin, disabled, mustChange] = await Promise.all([
    createUser({ displayName: 'Cleo Cohost' }),
    createUser({ displayName: 'Pia Participant' }),
    createUser({ displayName: 'Otto Other' }),
    createAdmin({ displayName: 'Ada Admin' }),
    createAdmin({ displayName: 'Dora Disabled', disabled: true }),
    createAdmin({ displayName: 'Max Mustchange', mustChangePassword: true }),
  ])

  const guestSessionA = await createGuestSession(roomA, { displayName: 'Gus Guest' })
  const guestRowA = await createParticipant({ room: roomA, meeting: { id: meetingA }, guestSessionId: guestSessionA.id, status: 'joined', displayName: guestSessionA.displayName })
  const guestSessionB = await createGuestSession(roomB, { displayName: 'Bo Guest' })
  const guestRowB = await createParticipant({ room: roomB, meeting: { id: meetingB }, guestSessionId: guestSessionB.id, status: 'joined', displayName: guestSessionB.displayName })
  const requestB = await createParticipant({ room: roomB, meeting: { id: meetingB }, guestSessionId: guestSessionB.id, status: 'waiting', displayName: guestSessionB.displayName })

  const members = {
    host: { api: joinedA.api, identity: joinedA.identity, rowId: hostRow.id },
    cohost: await memberRow(roomA, meetingA, cohost, 'cohost'),
    participant: await memberRow(roomA, meetingA, participant, 'participant'),
    disabled: await memberRow(roomA, meetingA, disabled, 'cohost'),
    mustChange: await memberRow(roomA, meetingA, mustChange, 'cohost'),
    guestA: {
      api: createClient().setCookie(guestSessionA.cookieName, guestSessionA.token),
      identity: guestRowA.lkIdentity,
      rowId: guestRowA.id,
    },
  }

  const clients: Record<Subject, ApiClient> = {
    anonymous: createClient(),
    guestA: members.guestA.api,
    guestB: createClient().setCookie(guestSessionB.cookieName, guestSessionB.token),
    participant: members.participant.api,
    cohost: members.cohost.api,
    host: members.host.api,
    otherUser: await loginAs(otherUser),
    admin: await loginAs(admin),
    disabled: members.disabled.api,
    mustChange: members.mustChange.api,
  }

  const inviteA = await createRoomInvite(roomA)
  const recordingA = (await seedReadyRecording({ createdBy: host.id, roomId: roomA.id })).id
  const hostSpareSession = (await createSession(host.id)).id

  return {
    roomA,
    roomB,
    meetingA,
    meetingB,
    users: { host, cohost, participant, otherUser, admin, disabled, mustChange, ownerB },
    clients,
    members,
    guestB: { sessionId: guestSessionB.id, rowId: guestRowB.id },
    inviteA: { id: inviteA.id, token: inviteA.token },
    recordingA,
    requestB: requestB.id,
    hostSpareSession,
  }
}

export interface SendOptions {
  body?: unknown
  raw?: Uint8Array<ArrayBuffer> | string
  headers?: Record<string, string>
  origin?: string | null
}

/**
 * `client.request()`, except that an SSE answer is not read to the end: its status and headers are kept and the
 * stream is aborted (the waiting-room stream stays open until a decision).
 */
export async function send(client: ApiClient, method: string, path: string, options: SendOptions = {}): Promise<ApiResponse> {
  if (!path.endsWith('/events')) return client.request(method, path, options)
  const controller = new AbortController()
  const headers = new Headers({ accept: 'text/event-stream', 'x-forwarded-for': client.ip, ...options.headers })
  const cookie = client.cookieHeader()
  if (cookie) headers.set('cookie', cookie)
  if (options.origin) headers.set('origin', options.origin)
  const response = await fetch(new URL(path, client.baseUrl), { method, headers, signal: controller.signal })
  const isStream = (response.headers.get('content-type') ?? '').startsWith('text/event-stream')
  let text = ''
  if (isStream) controller.abort()
  else text = await response.text()
  const isJson = (response.headers.get('content-type') ?? '').includes('json')
  return { status: response.status, headers: response.headers, body: isJson && text ? JSON.parse(text) : text, text, setCookies: response.headers.getSetCookie() }
}

const LIVEKIT_READS = new Set(['listRooms', 'listParticipants', 'getParticipant'])

/** The fake LiveKit's state-changing calls about one room (reads such as live counts are left out). */
export async function livekitWrites(roomId: string): Promise<FakeCall[]> {
  return (await livekitCalls(roomId)).filter((call) => !LIVEKIT_READS.has(call.method))
}

/** A random identity in the documented format that belongs to nobody. */
export function unknownIdentity(): string {
  return `p_${randomBytes(12).toString('base64url').replace(/[-_]/g, 'x').slice(0, 16)}`
}

export { randomUUID }

/**
 * The world's own resources, which requests refused by a security check must leave alone (fresh resources that
 * allowed cases create and consume are not part of it).
 */
export async function snapshot(world: World) {
  const db = testDb()
  const userIds = Object.values(world.users).map((user) => user.id)
  const sessionIds = [
    ...Object.values(world.clients).flatMap((client) => (client.session ? [client.session.id] : [])),
    world.hostSpareSession,
  ]
  const roomIds = [world.roomA.id, world.roomB.id]
  const [roomRows, memberRows, inviteRows, participantRows, meetingRows, recordingRows, userRows, sessionRows, settingRows] =
    await Promise.all([
      db.select().from(rooms).where(inArray(rooms.id, roomIds)),
      db.select().from(roomMembers).where(eq(roomMembers.roomId, world.roomA.id)),
      db.select().from(roomInvites).where(eq(roomInvites.id, world.inviteA.id)),
      db
        .select()
        .from(callParticipants)
        .where(or(eq(callParticipants.roomId, world.roomA.id), inArray(callParticipants.id, [world.guestB.rowId, world.requestB]))),
      db.select().from(meetings).where(inArray(meetings.roomId, roomIds)),
      db.select().from(recordings).where(eq(recordings.id, world.recordingA)),
      db.select().from(users).where(inArray(users.id, userIds)),
      db.select().from(sessions).where(inArray(sessions.id, sessionIds)),
      db.select().from(settings),
    ])
  const byId = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => a.id.localeCompare(b.id))
  return {
    rooms: byId(roomRows.map((r) => ({ id: r.id, name: r.name, keyVersion: r.keyVersion, joinProofHash: r.joinProofHash, deletedAt: r.deletedAt, locked: r.locked, waitingRoom: r.waitingRoom, passwordHash: r.passwordHash, chatEnabled: r.chatEnabled }))),
    members: memberRows.map((m) => m.userId).sort(),
    invites: inviteRows.map((i) => ({ id: i.id, revokedAt: i.revokedAt, useCount: i.useCount })),
    participants: byId(
      participantRows.map((p) => ({ id: p.id, status: p.status, role: p.roomRole, name: p.displayName, mic: p.micAllowed, cam: p.cameraAllowed, hand: p.handRaisedAt, volume: p.volumeLevel })),
    ),
    meetings: byId(meetingRows.map((m) => ({ id: m.id, endedAt: m.endedAt }))),
    recordings: recordingRows.map((r) => ({ id: r.id, status: r.status, chunkCount: r.chunkCount, endedAt: r.endedAt })),
    users: byId(userRows.map((u) => ({ id: u.id, role: u.role, name: u.displayName, disabledAt: u.disabledAt, passwordHash: u.passwordHash, mustChange: u.mustChangePassword }))),
    sessions: sessionRows.map((row) => row.id).sort(),
    settings: settingRows.map((row) => ({ key: row.key, value: row.value })).sort((a, b) => a.key.localeCompare(b.key)),
  }
}
