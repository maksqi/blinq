/**
 * Receiver watchdog (F-067): a remote track that is subscribed but never decrypts must not fail silently. The session
 * runs `check()` about once a second while the room is connected and reports the identities it returns the way it
 * reports undecryptable media (the tile and the E2EE badge).
 *
 * A track is stalled when, for `graceMs` of connected time:
 * - it is subscribed (`publication.track`) but blinq's TrackSubscribed handler never accepted it (receiver-guard.ts):
 *   the SDK lost the event, so no decrypting transform may exist and the track stays detached; or
 * - it was accepted, is a video track the policy enabled, and its receiver keeps receiving packets while not one frame
 *   decodes (the transform exists but does not decrypt).
 *
 * A video track that decoded a frame is verified and no longer sampled, so a call in a steady state costs nothing; a
 * picture that freezes later (congestion) is not this watchdog's business. Stalled tracks stay watched: one that
 * recovers is no longer reported.
 */

export interface DecodeSample {
  packetsReceived: number
  framesDecoded: number
}

export interface WatchedTrack {
  /** The remote track object (identity of the subscription). */
  track: object
  identity: string
  kind: 'audio' | 'video'
  /** blinq's TrackSubscribed handler accepted it (`receiverReady`). */
  ready: boolean
  /** The subscription policy enabled it (the SFU sends media). */
  enabled: boolean
  /** Inbound statistics of the track's receiver; null when unavailable. Called for unverified video tracks only. */
  sample: () => Promise<DecodeSample | null>
}

export interface ReceiverWatchdogOptions {
  now?: () => number
  /** Connected time a track may stay unaccepted or undecoded. */
  graceMs?: number
  /** Packets that must arrive within that time before an undecoded video track counts as stalled. */
  minPackets?: number
}

interface Entry {
  generation: number
  /** First check that saw the track unaccepted. */
  unacceptedSince?: number
  /** First sample of an accepted, enabled video track without a decoded frame. */
  first?: { at: number; packets: number }
}

export const RECEIVER_GRACE_MS = 5_000
export const RECEIVER_MIN_PACKETS = 50

export class ReceiverWatchdog {
  private readonly now: () => number
  private readonly graceMs: number
  private readonly minPackets: number
  private readonly entries = new WeakMap<object, Entry>()
  private readonly verified = new WeakSet<object>()
  private generation = 0

  constructor(options: ReceiverWatchdogOptions = {}) {
    this.now = options.now ?? Date.now
    this.graceMs = options.graceMs ?? RECEIVER_GRACE_MS
    this.minPackets = options.minPackets ?? RECEIVER_MIN_PACKETS
  }

  /** The room is not connected (reconnecting, resuming): events are buffered legitimately, so every clock restarts. */
  reset(): void {
    this.generation++
  }

  /** One pass over the current subscriptions; resolves to the identities with a stalled track. */
  async check(tracks: readonly WatchedTrack[]): Promise<Set<string>> {
    const now = this.now()
    const stalled = new Set<string>()
    await Promise.all(
      tracks.map(async (watched) => {
        if (await this.isStalled(watched, now)) stalled.add(watched.identity)
      }),
    )
    return stalled
  }

  private entry(track: object): Entry {
    let entry = this.entries.get(track)
    if (!entry || entry.generation !== this.generation) {
      entry = { generation: this.generation }
      this.entries.set(track, entry)
    }
    return entry
  }

  private async isStalled(watched: WatchedTrack, now: number): Promise<boolean> {
    const entry = this.entry(watched.track)
    if (!watched.ready) {
      entry.unacceptedSince ??= now
      return now - entry.unacceptedSince >= this.graceMs
    }
    entry.unacceptedSince = undefined
    if (watched.kind !== 'video' || this.verified.has(watched.track)) return false
    if (!watched.enabled) {
      // Paused by the policy: nothing arrives, so the clock restarts when it is enabled again.
      entry.first = undefined
      return false
    }
    const sample = await watched.sample().catch(() => null)
    if (!sample) return false
    if (sample.framesDecoded > 0) {
      this.verified.add(watched.track)
      this.entries.delete(watched.track)
      return false
    }
    entry.first ??= { at: now, packets: sample.packetsReceived }
    return now - entry.first.at >= this.graceMs && sample.packetsReceived - entry.first.packets >= this.minPackets
  }
}
