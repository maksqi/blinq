/**
 * Client-internal call contracts (orchestrator-owned). call-core implements them; Wave-2 features consume them.
 * A feature lives in app/lib/call/features/<feature>/index.ts, exports `defineCallFeature({...})` as default, and
 * is discovered with import.meta.glob — adding a feature never edits the core call page.
 */
import type { Component, ComputedRef, ShallowRef } from 'vue'
import type { Room, Track, TrackProcessor } from 'livekit-client'
import type { AppMessageType } from '../e2ee/envelope'
import type { ParticipantKind, ParticipantRole, RoomMetadata } from '#shared/schemas/livekit'

export type ConnectionQualityLevel = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown'

/** Reactive projection of one participant (never the raw LiveKit object). */
export interface ParticipantView {
  identity: string
  name: string
  role: ParticipantRole
  kind: ParticipantKind
  isLocal: boolean
  isSpeaking: boolean
  audioLevel: number
  connectionQuality: ConnectionQualityLevel
  micEnabled: boolean
  cameraEnabled: boolean
  screenSharing: boolean
  /** Epoch ms when the hand was raised, or null. */
  handRaisedAt: number | null
  /** Host-set volume for everyone, 0..100 (from the `vol` attribute). */
  volumeForEveryone: number
  /** False when any of this participant's publications is unencrypted (media is then blocked). */
  mediaEncrypted: boolean
  joinedAt: number
}

export type CallPhase =
  | 'loading'
  | 'needKey'
  | 'info'
  | 'prejoin'
  | 'password'
  | 'waiting'
  | 'connecting'
  | 'inCall'
  | 'reconnecting'
  | 'left'
  | 'ended'
  | 'removed'
  | 'error'

export type LayoutMode = 'grid' | 'speaker'

/** Typed app-message send/receive over the encrypted envelope. */
export interface AppMessaging {
  send(type: AppMessageType, body: unknown, options?: { to?: string[] }): Promise<void>
  /** Handler receives already-verified messages (encrypted, known sender, envelope sender = LiveKit sender). */
  on(type: AppMessageType, handler: (body: unknown, from: ParticipantView, ts: number) => void): () => void
}

/** Per-feature subscription demand (e.g. recording keeps every participant's video flowing). */
export interface VideoDemand {
  identity: string
  source: 'camera' | 'screen_share'
  width: number
  height: number
}

export interface SubscriptionControl {
  /** Register/replace a named demand source; returns a remover. */
  setDemand(sourceId: string, demands: VideoDemand[]): () => void
}

/** Audio controls exposed to features. */
export interface AudioControl {
  /** Local playback volume for one remote participant, 0..1 (multiplied by the host `vol`). */
  setLocalVolume(identity: string, volume: number): void
  getLocalVolume(identity: string): number
  /** Own microphone gain, 0..2 (1 = unchanged). */
  setMicGain(gain: number): void
  /** Remote audio tracks that are encrypted-verified and subscribed (for the recording mixer). */
  remoteAudioTracks(): MediaStreamTrack[]
}

/**
 * An audio stage media-fx inserts into call-core's mic chain: source → [insert] → gain (own mic gain) → output.
 * `connect` receives the chain's AudioContext and input node and returns the node that feeds the gain stage.
 */
export interface MicInsert {
  id: string
  connect(context: AudioContext, input: AudioNode): Promise<AudioNode>
  dispose(): void
}

/** Browser-level processing constraints applied to the microphone capture (call-core restarts/constrains the track). */
export interface MicProcessingConstraints {
  noiseSuppression: boolean
  echoCancellation: boolean
  autoGainControl: boolean
}

/**
 * Media processing hooks (media-fx inserts processors; call-core owns the tracks). They work both in pre-join
 * (preview tracks) and in-call; call-core re-applies them after device switches and republishing.
 */
export interface MediaControl {
  /** Current local camera MediaStreamTrack (after processors), or null. */
  cameraTrack(): MediaStreamTrack | null
  micTrack(): MediaStreamTrack | null
  /** Shared 48 kHz AudioContext used for the mic chain. */
  audioContext(): AudioContext
  /** Attach (or with null remove) a video processor, e.g. @livekit/track-processors BackgroundProcessor. No republish. */
  setCameraProcessor(processor: TrackProcessor<Track.Kind.Video> | null): Promise<void>
  /** Insert (or with null remove) an audio stage before the gain node, e.g. the RNNoise worklet. No republish. */
  setMicInsert(insert: MicInsert | null): Promise<void>
  /** Browser noise suppression / echo cancellation / AGC for the capture itself. */
  setMicProcessing(constraints: MicProcessingConstraints): Promise<void>
}

export interface CallEventMap {
  'participant.joined': ParticipantView
  'participant.left': { identity: string }
  'room.state': RoomMetadata
  'server.hint': { type: string }
  'call.phase': CallPhase
  /** The local participant started leaving; the phase stays `inCall` until the room is closed. */
  'call.leaving': undefined
  'unencrypted.blocked': { identity: string }
}

export interface CallEventBus {
  on<K extends keyof CallEventMap>(event: K, handler: (payload: CallEventMap[K]) => void): () => void
  emit<K extends keyof CallEventMap>(event: K, payload: CallEventMap[K]): void
}

/** Everything a feature may use. Obtained with `useCall()` inside the call page tree. */
export interface CallContext {
  /** LiveKit Room (markRaw). Prefer the typed helpers below over raw Room APIs. */
  room: Readonly<ShallowRef<Room | null>>
  roomId: Readonly<ShallowRef<string | null>>
  slug: Readonly<ShallowRef<string | null>>
  phase: Readonly<ShallowRef<CallPhase>>
  /** The meeting's name as the host set it (null until known), e.g. for file names. */
  roomName: Readonly<ShallowRef<string | null>>
  self: ComputedRef<ParticipantView | null>
  participants: ComputedRef<ParticipantView[]>
  roomState: ComputedRef<RoomMetadata | null>
  layout: Readonly<ShallowRef<LayoutMode>>
  messaging: AppMessaging
  subscriptions: SubscriptionControl
  audio: AudioControl
  media: MediaControl
  events: CallEventBus
  /** `$fetch` bound to /api/calls/:roomId (adds CSRF-safe headers, maps error codes). */
  callApi<T = unknown>(path: string, options?: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown }): Promise<T>
}

// ---- Registries ---------------------------------------------------------------------------------------------------

export interface ControlBarItem {
  id: string
  order: number
  placement: 'start' | 'center' | 'end' | 'overflow'
  component: Component
  visible?: (ctx: CallContext) => boolean
}

export interface SidePanel {
  id: string
  title: string
  icon: Component
  order: number
  component: Component
  badge?: (ctx: CallContext) => number | undefined
  visible?: (ctx: CallContext) => boolean
}

export interface TileBadge {
  id: string
  order: number
  /** Receives `{ participant: ParticipantView }` as props. */
  component: Component
}

export interface PreJoinSlot {
  id: string
  order: number
  component: Component
}

export interface SettingsSection {
  id: string
  title: string
  order: number
  component: Component
}

/** Full-screen views for terminal phases (e.g. removed/ended screens with host follow-ups). Highest order wins. */
export interface PhaseScreen {
  id: string
  phases: CallPhase[]
  order: number
  component: Component
}

/**
 * Always-mounted content of the call view: participant-side dialogs and anything else that needs a mounted component
 * but takes no room in the layout (render dialogs and portals only). Mounted once while the call view is, in every
 * phase including the terminal screens, and never remounted by layout changes.
 */
export interface CallOverlay {
  id: string
  order: number
  component: Component
}

export interface CallFeature {
  id: string
  controlBar?: ControlBarItem[]
  panels?: SidePanel[]
  tileBadges?: TileBadge[]
  preJoin?: PreJoinSlot[]
  settings?: SettingsSection[]
  phaseScreens?: PhaseScreen[]
  overlays?: CallOverlay[]
  /** Called once when the call context is ready; return a cleanup function. */
  setup?: (ctx: CallContext) => (() => void) | undefined
}

export function defineCallFeature(feature: CallFeature): CallFeature {
  return feature
}
