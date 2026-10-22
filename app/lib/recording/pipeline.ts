/**
 * The capture pipeline of one recording: compositor (canvas track) + mixer (audio track) → MediaRecorder.
 *
 * - Scene: everyone's camera tile (video or initials) in call order, then every drawable screen share. Video comes
 *   only through `drawableVideo` (encrypted, subscribed remote publications; the recorder's own camera after
 *   processors and own screen share).
 * - Demand: `ctx.subscriptions.setDemand('recording', …)` keeps every remote camera flowing at its tile size and every
 *   screen share at canvas size, also while call-core's tiles are hidden (background tab, other grid page). Removed on
 *   dispose.
 * - Mix: `mixableAudio` (encrypted-verified remote tracks) at the host volume plus the processed mic, re-synced on
 *   subscription, mute, attribute and encryption events and every half second.
 *
 * Built synchronously (the controller calls it inside the click, so the AudioContext may start); MediaRecorder starts
 * only when the controller calls `startRecorder()` after the server's 201.
 */
import { RoomEvent, Track, type Room, type TrackPublication } from 'livekit-client'
import type { CallContext, VideoDemand } from '../contracts/call'
import { receiverReady } from '../livekit/receiver-guard'
import type { FrameClock } from './clock'
import { Compositor, type SceneTile } from './compositor'
import { AUDIO_BITRATE, canvasSizeFor, VIDEO_BITRATES, type RecordingLayout, type RecordingResolution } from './layout'
import { buildMixSources, RecordingMixer } from './mixer'
import { ChunkRecorder } from './recorder'
import {
  drawableVideo,
  mixableAudio,
  sourceKey,
  type LocalVideoFacts,
  type PublicationSource,
  type RemotePublicationFacts,
} from './sources'

/** How often the mixer re-reads its sources (besides room events), in clock ticks. */
const MIX_RESYNC_TICKS = 15

export interface CapturePipelineOptions {
  ctx: CallContext
  mime: string
  resolution: RecordingResolution
  createClock: () => FrameClock
  document?: Document
  onChunk: (blob: Blob) => void
  onError: (error: unknown) => void
  /** After every drawn frame (the controller's limit checks). */
  onTick: () => void
}

export interface CapturePipeline {
  readonly frameCount: number
  /** MediaRecorder starts capturing (only after the indicator was published). */
  startRecorder(): void
  /** MediaRecorder stops capturing now; resolves after the final chunk was delivered. */
  stopRecorder(): Promise<void>
  /** Stops drawing and mixing, removes the subscription demand and the hidden video elements. */
  dispose(): void
}

export type CreateCapturePipeline = (options: CapturePipelineOptions) => CapturePipeline

function sourceOf(publication: TrackPublication): PublicationSource {
  switch (publication.source) {
    case Track.Source.Camera:
      return 'camera'
    case Track.Source.ScreenShare:
      return 'screen_share'
    case Track.Source.Microphone:
      return 'microphone'
    case Track.Source.ScreenShareAudio:
      return 'screen_share_audio'
    default:
      return 'unknown'
  }
}

function remoteFacts(ctx: CallContext, room: Room): RemotePublicationFacts<MediaStreamTrack>[] {
  // A participant call-core blocked (an unencrypted publication, now or earlier in the call) is never recorded, whatever
  // their other publications say: livekit-client's decrypt flag is per participant.
  const blocked = new Set(
    ctx.participants.value.filter((view) => !view.isLocal && !view.mediaEncrypted).map((view) => view.identity),
  )
  const facts: RemotePublicationFacts<MediaStreamTrack>[] = []
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      facts.push({
        identity: participant.identity,
        source: sourceOf(publication),
        kind: publication.kind === Track.Kind.Audio ? 'audio' : 'video',
        encrypted: publication.isEncrypted && !blocked.has(participant.identity),
        subscribed: publication.isSubscribed,
        muted: publication.isMuted,
        // Only a track whose decrypting receiver call-core accepted is drawn (F-067, receiver-guard.ts).
        track: receiverReady(publication.track) ? publication.track!.mediaStreamTrack : null,
      })
    }
  }
  return facts
}

function localScreenTrack(room: Room): MediaStreamTrack | null {
  const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
  if (!publication || publication.isMuted) return null
  return publication.track?.mediaStreamTrack ?? null
}

/** Everyone's camera tile (video or initials) in call order, then every drawable screen share. */
export function buildScene(ctx: CallContext, room: Room): SceneTile[] {
  const self = ctx.self.value
  const local: LocalVideoFacts<MediaStreamTrack>[] = self
    ? [
        { identity: self.identity, source: 'camera', track: ctx.media.cameraTrack() },
        { identity: self.identity, source: 'screen_share', track: localScreenTrack(room) },
      ]
    : []
  const video = drawableVideo(remoteFacts(ctx, room), local)
  const cameras: SceneTile[] = []
  const screens: SceneTile[] = []
  for (const participant of ctx.participants.value) {
    const cameraKey = sourceKey(participant.identity, 'camera')
    cameras.push({
      key: cameraKey,
      kind: 'camera',
      identity: participant.identity,
      name: participant.name,
      micMuted: !participant.micEnabled,
      track: video.get(cameraKey)?.track ?? null,
    })
    const screenKey = sourceKey(participant.identity, 'screen_share')
    const screen = video.get(screenKey)
    if (screen) {
      screens.push({
        key: screenKey,
        kind: 'screen',
        identity: participant.identity,
        name: participant.name,
        micMuted: false,
        track: screen.track,
      })
    }
  }
  return [...cameras, ...screens]
}

/** Subscription demands for a layout: remote cameras at their tile size, screen shares at canvas size. */
export function demandsFor(
  layout: RecordingLayout,
  tiles: readonly SceneTile[],
  selfIdentity: string | undefined,
  canvas: { width: number; height: number },
): VideoDemand[] {
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]))
  const demands: VideoDemand[] = []
  for (const rect of layout.tiles) {
    const tile = byKey.get(rect.key)
    if (!tile || tile.identity === selfIdentity) continue
    // Every remote camera tile has a demand, also while it shows initials, so a camera turned on appears at once.
    demands.push(
      tile.kind === 'screen'
        ? { identity: tile.identity, source: 'screen_share', width: canvas.width, height: canvas.height }
        : { identity: tile.identity, source: 'camera', width: rect.width, height: rect.height },
    )
  }
  return demands
}

function syncMix(ctx: CallContext, room: Room, mixer: RecordingMixer) {
  const views = new Map(ctx.participants.value.map((view) => [view.identity, view]))
  const remote = mixableAudio(remoteFacts(ctx, room), ctx.audio.remoteAudioTracks())
  mixer.sync(buildMixSources(remote, (identity) => views.get(identity)?.volumeForEveryone, ctx.media.micTrack()))
}

function watchRoom(room: Room, resync: () => void): () => void {
  const events = [
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.ParticipantAttributesChanged,
    RoomEvent.LocalTrackPublished,
    RoomEvent.ParticipantEncryptionStatusChanged,
  ] as const
  // Let call-core's own handlers (audio elements, views) run first.
  const handler = () => queueMicrotask(resync)
  for (const event of events) room.on(event, handler)
  return () => {
    for (const event of events) room.off(event, handler)
  }
}

/** Builds the real pipeline. Throws when the browser cannot capture a canvas or record with these options. */
export function createCapturePipeline(options: CapturePipelineOptions): CapturePipeline {
  const { ctx } = options
  const room = ctx.room.value
  if (!room) throw new Error('Not connected')
  const canvas = canvasSizeFor(options.resolution)
  const mixer = new RecordingMixer({
    onError: (error) =>
      console.warn('blinq: a recording audio source failed', error instanceof Error ? error.name : 'error'),
  })
  let removeDemand: (() => void) | null = null
  let detachRoom: (() => void) | null = null
  let compositor: Compositor | null = null
  let ticks = 0
  let disposed = false
  try {
    compositor = new Compositor({
      size: canvas,
      clock: options.createClock(),
      document: options.document,
      scene: () => buildScene(ctx, room),
      onLayout: (layout, tiles) => {
        if (disposed) return
        removeDemand = ctx.subscriptions.setDemand(
          'recording',
          demandsFor(layout, tiles, ctx.self.value?.identity, canvas),
        )
      },
      onTick: () => {
        ticks++
        if (ticks % MIX_RESYNC_TICKS === 0) syncMix(ctx, room, mixer)
        options.onTick()
      },
    })
    const audio = mixer.track
    const recorder = new ChunkRecorder({
      stream: new MediaStream(audio ? [compositor.track, audio] : [compositor.track]),
      mimeType: options.mime,
      videoBitsPerSecond: VIDEO_BITRATES[options.resolution],
      audioBitsPerSecond: AUDIO_BITRATE,
      onChunk: options.onChunk,
      onError: options.onError,
    })
    detachRoom = watchRoom(room, () => syncMix(ctx, room, mixer))
    syncMix(ctx, room, mixer)
    void mixer.resume()
    const started = compositor
    started.start()
    return {
      get frameCount() {
        return started.frameCount
      },
      startRecorder: () => recorder.start(),
      stopRecorder: () => recorder.stop(),
      dispose() {
        if (disposed) return
        disposed = true
        detachRoom?.()
        removeDemand?.()
        started.stop()
        mixer.dispose()
      },
    }
  } catch (error) {
    detachRoom?.()
    compositor?.stop()
    mixer.dispose()
    throw error
  }
}
