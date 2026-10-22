/**
 * Which remote tracks may be attached, played, mixed or recorded (F-067, defense in depth for F-015).
 *
 * livekit-client sets up a remote track's decrypting receiver transform in E2EEManager's `RoomEvent.TrackSubscribed`
 * listener. E2EEManager registers it in the Room constructor, so it runs before every listener blinq adds. A track is
 * `publication.track` before that event, though, and an event the SDK loses (F-067: buffered after a full reconnect
 * and never flushed) leaves a track that is subscribed but has no transform: Chromium decodes nothing, while Firefox
 * and Safari hand the decoder whatever arrives, plaintext injected by an SFU included.
 *
 * So a remote track is used only after blinq's own TrackSubscribed handler accepted it, and only if the SDK marked its
 * receiver as set up for E2EE then. Everything else stays detached; the receiver watchdog reports it.
 */

/**
 * The property livekit-client's E2EEManager.handleReceiver sets on a receiver once its decrypting transform is in place
 * (`E2EE_FLAG`, both the RTCRtpScriptTransform and the encoded-streams path). sdk-patch.test.ts guards the name.
 */
export const E2EE_RECEIVER_FLAG = 'lk_e2ee'

/** The parts of a remote track the guard reads (structural, so it is testable in Node). */
export interface GuardedTrack {
  readonly receiver?: object | null
}

/** Whether livekit-client set up a decrypting transform on this track's receiver. */
export function hasE2EEReceiver(track: GuardedTrack): boolean {
  const receiver = track.receiver
  if (!receiver) return false
  if (E2EE_RECEIVER_FLAG in receiver) return true
  // RTCRtpScriptTransform path (Firefox, Safari): the transform itself is the proof as well.
  return (receiver as { transform?: unknown }).transform != null
}

/** Tracks blinq accepted in its TrackSubscribed handler (weak: a track is dropped with its subscription). */
const accepted = new WeakSet<object>()

/**
 * Called from blinq's TrackSubscribed handler, after its encryption and block checks. Accepts the track when its
 * receiver decrypts; returns false (and accepts nothing) otherwise.
 */
export function acceptReceiver(track: GuardedTrack): boolean {
  if (!hasE2EEReceiver(track)) return false
  accepted.add(track)
  return true
}

/** Whether a remote track (any track object, e.g. `publication.track`) may be attached, played, mixed or recorded. */
export function receiverReady(track: object | null | undefined): boolean {
  return !!track && accepted.has(track)
}
