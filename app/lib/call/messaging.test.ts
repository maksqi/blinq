import { Encryption_Type } from 'livekit-client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DATA_TOPICS } from '#shared/schemas/livekit'
import type { ParticipantView } from '../contracts/call'
import { sealAppMessage, type AppMessage } from '../e2ee/envelope'
import { deriveMeetingKeys, generateRoomKey } from '../e2ee/keys'
import { toBase64Url, utf8 } from '../e2ee/encoding'
import { createEventBus } from './event-bus'
import { createMessaging, MESSAGE_FRESHNESS_MS, type DropReason, type IncomingPacket } from './messaging'

const SLUG = 'abc-defg-hjk'
const EPOCH = toBase64Url(new Uint8Array(16).fill(7))
const ALICE = 'p_AliceAliceAlice1'
const BOB = 'p_BobBobBobBobBob1'
const LOCAL = 'p_LocalLocalLocal1'
/** This device's clock: a moment after the test messages were sent. */
const NOW = 1_700_000_000_000 + 1_500

function view(identity: string, isLocal = false): ParticipantView {
  return {
    identity,
    name: identity,
    role: 'participant',
    kind: 'user',
    isLocal,
    isSpeaking: false,
    audioLevel: 0,
    connectionQuality: 'good',
    micEnabled: true,
    cameraEnabled: true,
    screenSharing: false,
    handRaisedAt: null,
    volumeForEveryone: 100,
    mediaEncrypted: true,
    joinedAt: 0,
  }
}

let chatKey: CryptoKey
let otherKey: CryptoKey

beforeAll(async () => {
  const k = generateRoomKey()
  chatKey = (await deriveMeetingKeys(k, EPOCH, SLUG)).chatKey
  otherKey = (await deriveMeetingKeys(generateRoomKey(), EPOCH, SLUG)).chatKey
})

function setup() {
  const events = createEventBus()
  const drops: DropReason[] = []
  const published: Array<{ bytes: Uint8Array; topic: string; destinationIdentities?: string[] }> = []
  const known = new Map([
    [ALICE, view(ALICE)],
    [BOB, view(BOB)],
    [LOCAL, view(LOCAL, true)],
  ])
  const messaging = createMessaging({
    slug: SLUG,
    chatKey: () => chatKey,
    transport: {
      localIdentity: () => LOCAL,
      publish: async (bytes, options) => {
        published.push({ bytes, ...options })
      },
    },
    lookup: (identity) => known.get(identity) ?? null,
    events,
    now: () => NOW,
    onDrop: (reason) => drops.push(reason),
  })
  const chats: Array<{ body: unknown; from: string; ts: number }> = []
  messaging.on('chat', (body, from, ts) => chats.push({ body, from: from.identity, ts }))
  const hints: string[] = []
  events.on('server.hint', ({ type }) => hints.push(type))
  return { messaging, drops, published, chats, hints, known }
}

function message(overrides: Partial<AppMessage> = {}): AppMessage {
  return {
    id: crypto.randomUUID(),
    type: 'chat',
    from: ALICE,
    ts: 1_700_000_000_000,
    body: { text: 'hello' },
    ...overrides,
  }
}

async function packet(
  overrides: Partial<IncomingPacket> & { message?: AppMessage; key?: CryptoKey } = {},
): Promise<IncomingPacket> {
  const msg = overrides.message ?? message()
  const payload = overrides.payload ?? (await sealAppMessage(overrides.key ?? chatKey, SLUG, msg))
  return {
    payload,
    senderIdentity: 'senderIdentity' in overrides ? overrides.senderIdentity : msg.from,
    topic: 'topic' in overrides ? overrides.topic : DATA_TOPICS.chat,
    encryptionType: 'encryptionType' in overrides ? overrides.encryptionType : Encryption_Type.GCM,
  }
}

describe('AppMessaging receive', () => {
  it('delivers an encrypted message from a known sender', async () => {
    const { messaging, chats, drops } = setup()
    await messaging.handlePacket(await packet())
    expect(chats).toEqual([{ body: { text: 'hello' }, from: ALICE, ts: 1_700_000_000_000 }])
    expect(drops).toEqual([])
  })

  it('drops packets LiveKit reports as unencrypted (NONE), even with a valid envelope', async () => {
    const { messaging, chats, drops } = setup()
    await messaging.handlePacket(await packet({ encryptionType: Encryption_Type.NONE }))
    await messaging.handlePacket(await packet({ encryptionType: undefined }))
    expect(chats).toEqual([])
    expect(drops).toEqual(['unencrypted', 'unencrypted'])
  })

  it('drops packets without a sender or from unknown participants', async () => {
    const { messaging, chats, drops } = setup()
    await messaging.handlePacket(await packet({ senderIdentity: undefined }))
    const stranger = 'p_StrangerStrange1'
    await messaging.handlePacket(await packet({ message: message({ from: stranger }), senderIdentity: stranger }))
    // A packet claiming to come from this client itself.
    await messaging.handlePacket(await packet({ message: message({ from: LOCAL }), senderIdentity: LOCAL }))
    expect(chats).toEqual([])
    expect(drops).toEqual(['unknown-sender', 'unknown-sender', 'unknown-sender'])
  })

  it('drops spoofed envelopes whose sender differs from the LiveKit sender', async () => {
    const { messaging, chats, drops } = setup()
    // Sealed by Bob as "from Alice" (AAD for Alice) but delivered by LiveKit as Bob's packet.
    await messaging.handlePacket(await packet({ message: message({ from: ALICE }), senderIdentity: BOB }))
    // Sealed as Bob, LiveKit says Alice.
    await messaging.handlePacket(await packet({ message: message({ from: BOB }), senderIdentity: ALICE }))
    expect(chats).toEqual([])
    expect(drops).toEqual(['envelope', 'envelope'])
  })

  it('drops messages sealed with another key and tampered or garbage payloads', async () => {
    const { messaging, chats, drops } = setup()
    await messaging.handlePacket(await packet({ key: otherKey }))
    const good = await packet()
    const tampered = new Uint8Array(good.payload)
    tampered[tampered.length - 1]! ^= 1
    await messaging.handlePacket({ ...good, payload: tampered })
    await messaging.handlePacket({ ...good, payload: utf8('{"type":"chat"}') })
    expect(chats).toEqual([])
    expect(drops).toEqual(['envelope', 'envelope', 'envelope'])
  })

  it('drops duplicates (replayed packets and re-sent ids)', async () => {
    const { messaging, chats, drops } = setup()
    const first = await packet()
    await messaging.handlePacket(first)
    await messaging.handlePacket(first)
    const id = crypto.randomUUID()
    await messaging.handlePacket(await packet({ message: message({ id }) }))
    await messaging.handlePacket(await packet({ message: message({ id, body: { text: 'again' } }) }))
    expect(chats.map((chat) => chat.body)).toEqual([{ text: 'hello' }, { text: 'hello' }])
    expect(drops).toEqual(['duplicate', 'duplicate'])
  })

  it('drops envelopes whose timestamp is too far from this clock, so replays after a reload fail (F-031)', async () => {
    const { messaging, chats, drops } = setup()
    const sent = 1_700_000_000_000
    // A replay of an old message (the id memory starts empty after a reload).
    await messaging.handlePacket(await packet({ message: message({ ts: NOW - MESSAGE_FRESHNESS_MS - 1 }) }))
    // A sender clock far ahead.
    await messaging.handlePacket(await packet({ message: message({ ts: NOW + MESSAGE_FRESHNESS_MS + 1 }) }))
    expect(chats).toEqual([])
    expect(drops).toEqual(['stale', 'stale'])
    // Clock skew within the margin, either way, is fine.
    await messaging.handlePacket(await packet({ message: message({ ts: sent - 4 * 60_000 }) }))
    await messaging.handlePacket(await packet({ message: message({ ts: NOW + 4 * 60_000 }) }))
    expect(chats).toHaveLength(2)
  })

  it('drops an envelope whose type does not match its topic', async () => {
    const { messaging, chats, drops } = setup()
    await messaging.handlePacket(await packet({ message: message({ type: 'reaction' }), topic: DATA_TOPICS.chat }))
    expect(chats).toEqual([])
    expect(drops).toEqual(['type-mismatch'])
  })

  it('routes reactions to reaction handlers only and ignores foreign topics', async () => {
    const { messaging, chats, drops } = setup()
    const reactions: unknown[] = []
    messaging.on('reaction', (body) => reactions.push(body))
    await messaging.handlePacket(
      await packet({ message: message({ type: 'reaction', body: { reaction: 'clap' } }), topic: DATA_TOPICS.reaction }),
    )
    await messaging.handlePacket(await packet({ topic: 'lk.chat' }))
    await messaging.handlePacket(await packet({ topic: undefined }))
    expect(reactions).toEqual([{ reaction: 'clap' }])
    expect(chats).toEqual([])
    expect(drops).toEqual([])
  })

  it('keeps delivering to other handlers when one throws', async () => {
    const onHandlerError = vi.fn()
    const events = createEventBus()
    const messaging = createMessaging({
      slug: SLUG,
      chatKey: () => chatKey,
      transport: { localIdentity: () => LOCAL, publish: async () => {} },
      lookup: (identity) => (identity === ALICE ? view(ALICE) : null),
      events,
      now: () => NOW,
      onHandlerError,
    })
    const received: unknown[] = []
    messaging.on('chat', () => {
      throw new Error('feature bug')
    })
    messaging.on('chat', (body) => received.push(body))
    await messaging.handlePacket(await packet())
    expect(received).toEqual([{ text: 'hello' }])
    expect(onHandlerError).toHaveBeenCalledOnce()
  })

  it('stops delivering after unsubscribe and dispose', async () => {
    const { messaging, chats } = setup()
    const off = messaging.on('chat', () => {
      throw new Error('should not be called')
    })
    off()
    messaging.dispose()
    await messaging.handlePacket(await packet())
    expect(chats).toEqual([])
  })
})

describe('server hints (blinq.srv.v1)', () => {
  const hint = (type: string) => utf8(JSON.stringify({ type }))

  it('are emitted as server.hint when they come from the server (no sender)', async () => {
    const { messaging, hints } = setup()
    for (const type of ['lobby.changed', 'participant.changed', 'ask-unmute']) {
      await messaging.handlePacket({
        payload: hint(type),
        senderIdentity: undefined,
        topic: DATA_TOPICS.server,
        encryptionType: Encryption_Type.NONE,
      })
    }
    expect(hints).toEqual(['lobby.changed', 'participant.changed', 'ask-unmute'])
  })

  it('are dropped when a participant sends them, encrypted or not', async () => {
    const { messaging, hints, drops } = setup()
    for (const encryptionType of [Encryption_Type.NONE, Encryption_Type.GCM]) {
      await messaging.handlePacket({
        payload: hint('ask-unmute'),
        senderIdentity: ALICE,
        topic: DATA_TOPICS.server,
        encryptionType,
      })
    }
    expect(hints).toEqual([])
    expect(drops).toEqual(['hint-from-participant', 'hint-from-participant'])
  })

  it('are dropped when they are not a known hint', async () => {
    const { messaging, hints, drops } = setup()
    const server = { senderIdentity: undefined, topic: DATA_TOPICS.server, encryptionType: Encryption_Type.NONE }
    await messaging.handlePacket({ ...server, payload: hint('grant.token') })
    await messaging.handlePacket({ ...server, payload: utf8('not json') })
    await messaging.handlePacket({
      ...server,
      payload: utf8(JSON.stringify({ type: 'lobby.changed', token: 'x'.repeat(2000) })),
    })
    await messaging.handlePacket({ ...server, payload: new Uint8Array([0xff, 0xfe]) })
    expect(hints).toEqual([])
    expect(drops).toEqual(['hint-invalid', 'hint-invalid', 'hint-invalid', 'hint-invalid'])
  })
})

describe('AppMessaging send', () => {
  it('seals with the chat key and publishes on the topic of the type', async () => {
    const { messaging, published } = setup()
    await messaging.send('chat', { text: 'hi' }, { to: [ALICE] })
    await messaging.send('reaction', { reaction: 'heart' })
    expect(published.map((p) => [p.topic, p.destinationIdentities])).toEqual([
      [DATA_TOPICS.chat, [ALICE]],
      [DATA_TOPICS.reaction, undefined],
    ])
    // The payload is ciphertext and opens only for this sender.
    const { messaging: receiver, chats, known } = setup()
    known.set(LOCAL, view(LOCAL)) // on the receiving side the sender is remote
    await receiver.handlePacket({
      payload: published[0]!.bytes,
      senderIdentity: LOCAL,
      topic: DATA_TOPICS.chat,
      encryptionType: Encryption_Type.GCM,
    })
    expect(chats.map((chat) => [chat.body, chat.from])).toEqual([[{ text: 'hi' }, LOCAL]])
    expect(new TextDecoder().decode(published[0]!.bytes)).not.toContain('hi"')
  })

  it('refuses to send before the call is connected', async () => {
    const messaging = createMessaging({
      slug: SLUG,
      chatKey: () => null,
      transport: { localIdentity: () => null, publish: async () => {} },
      lookup: () => null,
      events: createEventBus(),
    })
    await expect(messaging.send('chat', { text: 'x' })).rejects.toThrow('Not connected')
  })
})
