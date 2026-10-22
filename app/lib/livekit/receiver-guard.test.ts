import { ExternalE2EEKeyProvider, Room, RoomEvent, setLogLevel } from 'livekit-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptReceiver, E2EE_RECEIVER_FLAG, hasE2EEReceiver, receiverReady } from './receiver-guard'

describe('hasE2EEReceiver', () => {
  it('is false without a receiver or for a receiver the SDK never set up', () => {
    expect(hasE2EEReceiver({})).toBe(false)
    expect(hasE2EEReceiver({ receiver: null })).toBe(false)
    expect(hasE2EEReceiver({ receiver: {} })).toBe(false)
    expect(hasE2EEReceiver({ receiver: { transform: null } })).toBe(false)
  })

  it('is true once the SDK marked the receiver or set a script transform', () => {
    expect(hasE2EEReceiver({ receiver: { [E2EE_RECEIVER_FLAG]: true } })).toBe(true)
    expect(hasE2EEReceiver({ receiver: { transform: {} } })).toBe(true)
  })
})

describe('acceptReceiver and receiverReady', () => {
  it('accepts only a track whose receiver decrypts', () => {
    const plain = { receiver: {} }
    expect(acceptReceiver(plain)).toBe(false)
    expect(receiverReady(plain)).toBe(false)

    const decrypting = { receiver: { [E2EE_RECEIVER_FLAG]: true } }
    expect(receiverReady(decrypting)).toBe(false)
    expect(acceptReceiver(decrypting)).toBe(true)
    expect(receiverReady(decrypting)).toBe(true)
  })

  it('is per track object: a new subscription on the same receiver needs its own TrackSubscribed', () => {
    const receiver = { [E2EE_RECEIVER_FLAG]: true }
    const first = { receiver }
    acceptReceiver(first)
    expect(receiverReady(first)).toBe(true)
    expect(receiverReady({ receiver })).toBe(false)
  })

  it('treats a missing track as not ready', () => {
    expect(receiverReady(null)).toBe(false)
    expect(receiverReady(undefined)).toBe(false)
  })
})

/**
 * The guard's assumption, checked against the real SDK: by the time a listener the app added runs, E2EEManager has set
 * up the track's decrypting receiver (its listener is registered in the Room constructor).
 */
describe('livekit-client sets up the receiver before app listeners run', () => {
  setLogLevel('silent')

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  class FakeScriptTransform {
    constructor(
      readonly worker: unknown,
      readonly options: unknown,
    ) {}
  }

  const fakeWorker = () => ({ postMessage: vi.fn(), onmessage: null, onerror: null, terminate: vi.fn() })

  /** A Room with `encryption`, created while the browser globals the SDK checks exist. */
  function encryptedRoom(globals: Record<string, unknown>) {
    for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value)
    const worker = fakeWorker()
    const room = new Room({
      encryption: { keyProvider: new ExternalE2EEKeyProvider(), worker: worker as unknown as Worker },
    })
    return { room, worker }
  }

  function subscribe(room: Room, receiver: Record<string, unknown>) {
    const track = { kind: 'video', mediaStreamID: 'stream-1', receiver }
    const seen: boolean[] = []
    room.on(RoomEvent.TrackSubscribed, (subscribed) => {
      seen.push(hasE2EEReceiver(subscribed as unknown as { receiver: object }))
      seen.push(acceptReceiver(subscribed as unknown as { receiver: object }))
    })
    room.emit(RoomEvent.TrackSubscribed, track, { trackInfo: { mimeType: 'video/VP8' } }, { identity: 'p_peer' })
    room.removeAllListeners()
    return { track, seen }
  }

  it('with RTCRtpScriptTransform (Firefox, Safari)', () => {
    const { room } = encryptedRoom({
      window: { RTCRtpScriptTransform: FakeScriptTransform },
      RTCRtpScriptTransform: FakeScriptTransform,
      navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' },
    })
    const receiver: Record<string, unknown> = {}
    const { track, seen } = subscribe(room, receiver)
    expect(seen).toEqual([true, true])
    expect(receiver.transform).toBeInstanceOf(FakeScriptTransform)
    expect(receiverReady(track)).toBe(true)
  })

  it('with encoded streams (Chromium)', () => {
    const { room, worker } = encryptedRoom({
      window: { RTCRtpSender: { prototype: { createEncodedStreams: () => undefined } } },
      navigator: {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      },
    })
    const receiver: Record<string, unknown> = {
      createEncodedStreams: () => ({ readable: { kind: 'readable' }, writable: { kind: 'writable' } }),
    }
    const { track, seen } = subscribe(room, receiver)
    expect(seen).toEqual([true, true])
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'decode' }),
      expect.arrayContaining([{ kind: 'readable' }, { kind: 'writable' }]),
    )
    expect(receiverReady(track)).toBe(true)
  })
})
