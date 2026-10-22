<script setup lang="ts">
/**
 * One video tile: video or avatar, name, muted mic, active-speaker ring, connection quality, raised hand, registry tile
 * badges, and the blocked or cannot-decrypt state. The tile reports its rendered size to the subscription policy.
 */
import { HandIcon, MicOffIcon, MonitorUpIcon, ShieldAlertIcon, KeyRoundIcon } from '@lucide/vue'
import { computed, shallowRef } from 'vue'
import { cn } from '@/lib/utils'
import ConnectionQualityIcon from './ConnectionQualityIcon.vue'
import TileMenu from './TileMenu.vue'
import VideoTrackView from './VideoTrackView.vue'
import { useCallSession, useVideoTile } from '~/composables/call'
import { callRegistry } from '~/lib/call/features'
import type { ParticipantView } from '~/lib/contracts/call'
import { initials } from '~/lib/shell/initials'

const props = withDefaults(
  defineProps<{
    participant: ParticipantView
    source?: 'camera' | 'screen_share'
    /** Pinned or presentation stage: exempt from the pixel budget. */
    priority?: boolean
    variant?: 'grid' | 'stage' | 'strip'
  }>(),
  { source: 'camera', priority: false, variant: 'grid' },
)

const session = useCallSession()
const store = session.store
const root = shallowRef<HTMLElement | null>(null)

const isScreen = computed(() => props.source === 'screen_share')
const blocked = computed(() => store.blocked.includes(props.participant.identity))
const undecryptable = computed(() => !blocked.value && store.undecryptable.includes(props.participant.identity))

const track = computed(() => {
  // Re-read on camera changes (the session bumps trackVersion on every track event as well).
  void props.participant.cameraEnabled
  void props.participant.screenSharing
  if (props.participant.isLocal) return isScreen.value ? null : session.previewTrack()
  return session.videoTrack(props.participant.identity, props.source)
})

useVideoTile(root, () => ({
  identity: props.participant.identity,
  source: props.source,
  priority: props.priority,
  isLocal: props.participant.isLocal,
}))

const AVATAR_TINTS = [
  'from-chart-1/45 to-chart-2/15',
  'from-chart-2/40 to-chart-1/15',
  'from-chart-3/35 to-chart-5/15',
  'from-chart-4/40 to-chart-2/15',
  'from-chart-5/35 to-chart-4/15',
]
const tint = computed(() => {
  let hash = 0
  for (const char of props.participant.identity) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]
})
const avatarSize = computed(() =>
  props.variant === 'strip' ? 'size-10 text-sm' : props.variant === 'stage' ? 'size-24 text-3xl' : 'size-16 text-xl',
)
const label = computed(() => {
  const name = props.participant.isLocal ? `${props.participant.name} (you)` : props.participant.name
  return isScreen.value ? `${props.participant.name} is presenting` : name
})
const badges = callRegistry.tileBadges
</script>

<template>
  <div
    ref="root"
    data-testid="participant-tile"
    :data-identity="participant.identity"
    :data-source="source"
    :data-local="participant.isLocal || undefined"
    :data-speaking="participant.isSpeaking || undefined"
    :data-blocked="blocked || undefined"
    :data-undecryptable="undecryptable || undefined"
    :aria-label="label"
    role="group"
    :class="
      cn(
        'group/tile relative isolate flex items-center justify-center overflow-hidden rounded-xl bg-card ring-1 ring-white/6 transition-shadow',
        !isScreen && `bg-linear-to-br ${tint}`,
        isScreen && 'bg-black',
        participant.isSpeaking && !isScreen && 'ring-2 ring-primary',
      )
    "
  >
    <VideoTrackView
      v-if="track && !blocked"
      :track="track"
      :mirror="participant.isLocal && !isScreen"
      :fit="isScreen ? 'contain' : 'cover'"
      :remote="!participant.isLocal"
      class="absolute inset-0"
    />
    <div v-else-if="!blocked && !undecryptable" class="flex flex-col items-center gap-2">
      <span
        :class="
          cn(
            'flex items-center justify-center rounded-full bg-background/45 font-semibold text-foreground ring-1 ring-foreground/10',
            avatarSize,
          )
        "
        aria-hidden="true"
      >
        <MonitorUpIcon v-if="isScreen" class="size-1/2" />
        <template v-else>{{ initials(participant.name) }}</template>
      </span>
    </div>

    <div
      v-if="blocked"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-red-950/80 p-3 text-center text-red-100"
      data-testid="tile-blocked"
    >
      <ShieldAlertIcon class="size-6" aria-hidden="true" />
      <p class="text-xs font-medium sm:text-sm">Unencrypted media blocked</p>
    </div>
    <div
      v-else-if="undecryptable && !track"
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-amber-950/70 p-3 text-center text-amber-100"
      data-testid="tile-undecryptable"
    >
      <KeyRoundIcon class="size-6" aria-hidden="true" />
      <p class="text-xs font-medium sm:text-sm">Can't decrypt this media</p>
    </div>
    <p
      v-if="undecryptable && track"
      class="absolute inset-x-2 top-2 rounded-md bg-amber-950/80 px-2 py-1 text-center text-xs text-amber-100"
      data-testid="tile-undecryptable"
    >
      Can't decrypt this media
    </p>

    <div class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
      <span
        v-if="participant.handRaisedAt"
        role="img"
        aria-label="Hand raised"
        data-testid="tile-hand"
        class="inline-flex size-6 items-center justify-center rounded-md bg-amber-400 text-amber-950"
      >
        <HandIcon class="size-3.5" aria-hidden="true" />
      </span>
      <component :is="badge.component" v-for="badge in badges" :key="badge.id" :participant="participant" />
      <ConnectionQualityIcon v-if="!participant.isLocal && !isScreen" :quality="participant.connectionQuality" />
      <TileMenu v-if="!isScreen" :participant="participant" />
    </div>

    <div
      class="absolute bottom-1.5 left-1.5 z-10 flex max-w-[calc(100%-0.75rem)] items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-white"
    >
      <MicOffIcon
        v-if="!participant.micEnabled && !isScreen"
        class="size-3.5 shrink-0 text-red-300"
        aria-label="Microphone off"
        role="img"
        data-testid="tile-mic-off"
      />
      <span :class="cn('truncate font-medium', variant === 'strip' ? 'text-[0.6875rem]' : 'text-xs')">{{ label }}</span>
    </div>
  </div>
</template>
