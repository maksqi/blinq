/**
 * Guards for `patches/livekit-client@2.22.3.patch`. pnpm keys a patch by version: after an upgrade it silently stops
 * applying, and these tests fail until the new version is checked (and each part dropped once upstream fixed it).
 *
 * - Data packets: 2.22.3 sends encrypted data packets without `encryption_type`, so receivers report NONE even after a
 *   successful decryption, and `messaging.ts` (which requires E2EE) would drop every chat message and reaction.
 * - E2EE worker (F-015): the decrypt flag is per participant and every `TrackPublished` overwrites it, so one
 *   publication announced as unencrypted turned decryption off for all of that participant's tracks, and the worker
 *   then passed frames to the decoder undecrypted. Patched, it drops them (and never encodes without encryption).
 * - Room (F-037): the `devicechange` listener kept every Room alive through its constructor's closure context; the
 *   iOS silent-audio `visibilitychange` listener was never removed; the Krisp listeners on an audio processor's output
 *   track were never removed, so the mic chain's output (kept alive by the shared AudioContext) held every Room.
 * - Engine (F-006): a server-side close (room deleted, participant removed) logged data channel errors when the SCTP
 *   abort arrived before the leave message.
 * - Engine (F-067): `pendingReconnect` stayed true until the reconnect attempt settled, but a full reconnect emits
 *   Reconnected about 2 s earlier, and the Room buffered every `emitWhenConnected` event of that window (TrackSubscribed
 *   included) with nothing left to flush it: the E2EE receiver transform was never set up. Now the flag ends when the
 *   timer fires, and a cancelled timer leaves no pending reconnect.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ConnectionState, Room, RoomEvent, setLogLevel } from 'livekit-client'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
// The CommonJS entry (dist/livekit-client.umd.js) sits next to the ES module builds the browser bundles.
const distDir = dirname(require.resolve('livekit-client'))
const bundle = readFileSync(join(distDir, 'livekit-client.esm.mjs'), 'utf8')
const worker = readFileSync(join(distDir, 'livekit-client.e2ee.worker.mjs'), 'utf8')
/** The frame cryptor (its base class only has throwing stubs of the same methods). */
const cryptor = worker.slice(worker.indexOf('class FrameCryptor extends BaseFrameCryptor'))

/** The brace-balanced block that starts at the first `{` after `marker` (searching from `from`). */
function blockAfter(source: string, marker: string, from = 0): string {
  const at = source.indexOf(marker, from)
  if (at < 0) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', at + marker.length - 1)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (char === '{') depth++
    else if (char === '}' && --depth === 0) return source.slice(open, index + 1)
  }
  throw new Error(`unbalanced block after ${marker}`)
}

describe('livekit-client patch', () => {
  it('marks the encrypted data packets it sends as GCM', () => {
    const send = bundle.slice(bundle.indexOf('sendDataPacket(packet'))
    const packet = send.slice(
      send.indexOf('new EncryptedPacket({'),
      send.indexOf('})', send.indexOf('new EncryptedPacket({')),
    )
    expect(packet).toContain('encryptionType: Encryption_Type.GCM')
  })

  it('drops incoming frames of a participant whose decrypt flag is off instead of passing them through', () => {
    const decode = blockAfter(cryptor, 'decodeFunction(encodedFrame, controller) {')
    const offBranch = blockAfter(decode, 'if (!encryptionEnabled) {')
    expect(offBranch).toContain('return;')
    expect(offBranch).not.toContain('enqueue')
  })

  it('never sends a frame unencrypted', () => {
    const encode = blockAfter(cryptor, 'encodeFunction(encodedFrame, controller) {')
    const offBranch = blockAfter(encode, 'if (!this.isEnabled()) {')
    expect(offBranch).toContain('return;')
    expect(offBranch).not.toContain('enqueue')
  })

  it('registers the devicechange listener without capturing the Room', () => {
    const constructor = blockAfter(bundle, 'class Room extends eventsExports.EventEmitter {')
    expect(constructor).toContain('blinqWatchDeviceChanges(this)')
    expect(constructor).not.toContain('new WeakRef(this)')
    const helper = blockAfter(bundle, 'function blinqWatchDeviceChanges(room) {')
    expect(helper).toContain('new WeakRef(room)')
    expect(helper).not.toMatch(/\bthis\b/)
  })

  it('removes the iOS silent-audio visibilitychange listener on disconnect', () => {
    expect(bundle).toContain("document.addEventListener('visibilitychange', onVisibilityChange)")
    expect(bundle).toContain("document.removeEventListener('visibilitychange', onVisibilityChange)")
    const listener = blockAfter(bundle, 'function blinqDummyAudioVisibilityListener(room, element, stream) {')
    expect(listener).not.toMatch(/\bthis\b/)
  })

  it("removes the Krisp listeners from a processor's output when the processor or the track stops", () => {
    const forget = blockAfter(bundle, 'function blinqForgetProcessedTrack(track) {')
    expect(forget).toContain("removeEventListener('enable-lk-krisp-noise-filter'")
    expect(forget).toContain("removeEventListener('disable-lk-krisp-noise-filter'")
    expect(blockAfter(bundle, 'internalStopProcessor() {')).toContain('blinqForgetProcessedTrack(_this5)')
    const stop = bundle.slice(bundle.indexOf('this.manuallyStopped = true;'))
    expect(stop.slice(0, stop.indexOf('this.processor = undefined;'))).toContain('blinqForgetProcessedTrack(this)')
  })

  it('reports data channel errors only when the engine is still open after the grace period', () => {
    const onError = blockAfter(bundle, 'this.handleDataError = event =>')
    expect(onError).toContain('setTimeout(')
    expect(onError).toContain('BLINQ_SERVER_CLOSE_GRACE_MS')
    expect(onError).toContain('blinqSessionUp(this)')
    // A server-side abort (SCTP cause 12) is a warning, not an error.
    expect(onError).toContain('BLINQ_SCTP_USER_INITIATED_ABORT')
    expect(onError).toContain('this.blinqServerAborted ? this.log.warn : this.log.error')
    const onClose = blockAfter(bundle, 'this.handleDataChannelClose = kind => () =>')
    expect(onClose).toContain('setTimeout(')
    expect(onClose).toContain('this.blinqServerAborted ? this.log.warn : this.log.error')
    const up = blockAfter(bundle, 'function blinqSessionUp(engine) {')
    expect(up).toContain('engine._isClosed')
    expect(up).toContain('engine.attemptingReconnect')
  })

  it('ends pendingReconnect when the reconnect timer fires, not when the attempt settles (F-067)', () => {
    const onDisconnect = blockAfter(bundle, 'this.handleDisconnect = (connection, disconnectReason) =>')
    expect(onDisconnect).toContain('blinq patch (F-067)')
    expect(onDisconnect).toContain('if (this.reconnectTimeout === reconnectTimeout) {')
    expect(bundle).not.toContain('.finally(() => this.reconnectTimeout = undefined)')
    const clear = blockAfter(bundle, '  clearReconnectTimeout() {')
    expect(clear).toContain('this.reconnectTimeout = undefined;')
  })

  it('keeps the receiver flag and the TrackSubscribed listener blinq relies on (receiver-guard.ts)', () => {
    // receiver-guard.ts reads this property; E2EEManager sets it once the receiver's transform is in place.
    expect(bundle).toContain("const E2EE_FLAG = 'lk_e2ee';")
    expect(
      blockAfter(bundle, '  handleReceiver(receiver, trackId, participantIdentity, codec, hasPacketTrailer) {'),
    ).toContain('receiver[E2EE_FLAG] = true;')
    const listeners = blockAfter(bundle, '  setupEventListeners(room, keyProvider) {')
    expect(listeners).toContain('.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {')
    expect(listeners).toContain('this.setupE2EEReceiver(track, participant.identity, pub.trackInfo);')
  })
})

/** The engine internals the F-067 tests drive (all exist on RTCEngine in 2.22.3). */
interface EngineInternals {
  readonly pendingReconnect: boolean
  /** True until the engine joined (handleDisconnect ignores a closed engine). */
  _isClosed: boolean
  attemptReconnect: (reason?: unknown) => Promise<void>
  handleDisconnect: (connection: string, reason?: unknown) => void
  clearReconnectTimeout: () => void
  clearPendingReconnect: () => void
}

/** The Room internals the F-067 tests drive. */
interface RoomInternals {
  state: ConnectionState
  bufferedEvents: unknown[]
  emitWhenConnected: (event: RoomEvent, ...args: unknown[]) => boolean
}

describe('livekit-client patch: reconnect window (F-067)', () => {
  const rooms: Room[] = []
  setLogLevel('silent')

  /** A Room that believes it is connected, whose engine's reconnect attempts never settle (a restart in progress). */
  function connectedRoom() {
    const room = new Room()
    rooms.push(room)
    const engine = room.engine as unknown as EngineInternals
    engine._isClosed = false
    const attempts: unknown[] = []
    engine.attemptReconnect = (reason) => {
      attempts.push(reason)
      return new Promise<void>(() => undefined)
    }
    const internals = room as unknown as RoomInternals
    internals.state = ConnectionState.Connected
    return { room, engine, internals, attempts }
  }

  const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    for (const room of rooms.splice(0)) {
      const engine = room.engine as unknown as EngineInternals
      engine.clearPendingReconnect()
      room.removeAllListeners()
    }
  })

  it('reports no pending reconnect once the timer fired, while the attempt still runs', async () => {
    const { engine, attempts } = connectedRoom()
    engine.handleDisconnect('leave-reconnect')
    expect(engine.pendingReconnect).toBe(true)
    await macrotask()
    expect(attempts).toHaveLength(1)
    expect(engine.pendingReconnect).toBe(false)
  })

  it('delivers TrackSubscribed of a connected room at once while that attempt runs', async () => {
    const { room, engine, internals } = connectedRoom()
    engine.handleDisconnect('leave-reconnect')
    await macrotask()
    const delivered: unknown[] = []
    room.on(RoomEvent.TrackSubscribed, (track) => delivered.push(track))
    const track = { kind: 'video' }
    internals.emitWhenConnected(RoomEvent.TrackSubscribed, track, {}, {})
    expect(delivered).toEqual([track])
    expect(internals.bufferedEvents).toHaveLength(0)
  })

  it('still buffers events while a reconnect is scheduled', () => {
    const { room, engine, internals } = connectedRoom()
    engine.handleDisconnect('leave-reconnect')
    const delivered: unknown[] = []
    room.on(RoomEvent.TrackSubscribed, (track) => delivered.push(track))
    internals.emitWhenConnected(RoomEvent.TrackSubscribed, { kind: 'video' }, {}, {})
    expect(delivered).toHaveLength(0)
    expect(internals.bufferedEvents).toHaveLength(1)
  })

  it('leaves no pending reconnect when a scheduled timer is cancelled', async () => {
    const { engine, attempts } = connectedRoom()
    engine.handleDisconnect('leave-reconnect')
    engine.clearReconnectTimeout()
    expect(engine.pendingReconnect).toBe(false)
    await macrotask()
    expect(attempts).toHaveLength(0)
  })

  it('leaves no pending reconnect when a successful attempt cancels a timer scheduled during it', async () => {
    const { engine, attempts } = connectedRoom()
    engine.handleDisconnect('leave-reconnect')
    await macrotask()
    // Something asks for another reconnect while the first attempt runs; the attempt then succeeds.
    engine.handleDisconnect('signal')
    expect(engine.pendingReconnect).toBe(true)
    engine.clearPendingReconnect()
    expect(engine.pendingReconnect).toBe(false)
    await macrotask()
    expect(attempts).toHaveLength(1)
  })
})
