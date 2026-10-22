<script setup lang="ts">
/**
 * End-to-end encryption status. Green ("Encrypted") only when this client encrypts and every remote publication is
 * encrypted and decryptable; the popover shows the safety code everyone can compare.
 */
import { LockKeyholeIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon } from '@lucide/vue'
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useCallSession, useCallUi } from '~/composables/call'

const session = useCallSession()
const ui = useCallUi()
const store = session.store

const nameOf = (identity: string) => store.participants.find((p) => p.identity === identity)?.name ?? 'Someone'

const view = computed(() => {
  switch (store.e2eeBadge) {
    case 'encrypted':
      return {
        icon: ShieldCheckIcon,
        label: 'Encrypted',
        tone: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
        title: 'End-to-end encrypted',
        text: 'Audio, video and chat are encrypted on your device. The server only forwards data it cannot read.',
      }
    case 'blocked':
      return {
        icon: ShieldAlertIcon,
        label: 'Unencrypted media blocked',
        tone: 'bg-red-500/15 text-red-300 ring-red-400/30',
        title: 'Some media is not encrypted',
        text: `${store.blocked.map(nameOf).join(', ')} sent media without encryption. blinq blocked it, so you won't see or hear it.`,
      }
    case 'warning':
      return {
        icon: ShieldAlertIcon,
        label: 'Encryption problem',
        tone: 'bg-amber-500/15 text-amber-200 ring-amber-400/30',
        title: "Some media can't be decrypted",
        text: `Media from ${store.undecryptable.map(nameOf).join(', ')} can't be decrypted. Rejoin; if it keeps happening, compare safety codes and ask for a fresh link.`,
      }
    case 'off':
      return {
        icon: ShieldOffIcon,
        label: 'Not encrypted',
        tone: 'bg-red-500/15 text-red-300 ring-red-400/30',
        title: 'Encryption is off',
        text: 'This test client connects without end-to-end encryption.',
      }
    default:
      return {
        icon: LockKeyholeIcon,
        label: 'Securing…',
        tone: 'bg-white/10 text-white/80 ring-white/15',
        title: 'Setting up encryption',
        text: 'The meeting key is being applied.',
      }
  }
})
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <button
        type="button"
        data-testid="e2ee-badge"
        :data-state="store.e2eeBadge"
        :aria-label="`${view.title}. Show safety code`"
        :class="
          cn(
            'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 transition-colors hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-sm:h-11 max-sm:min-w-11 pointer-coarse:h-11 pointer-coarse:min-w-11',
            view.tone,
          )
        "
      >
        <component :is="view.icon" class="size-4" aria-hidden="true" />
        <span class="hidden sm:inline">{{ view.label }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" :side-offset="8" class="w-[min(22rem,calc(100vw-2rem))]">
      <PopoverHeader>
        <PopoverTitle class="flex items-center gap-2">
          <component :is="view.icon" class="size-4" aria-hidden="true" />
          {{ view.title }}
        </PopoverTitle>
        <PopoverDescription>{{ view.text }}</PopoverDescription>
      </PopoverHeader>
      <div v-if="store.safetyCode" class="mt-3 rounded-lg bg-muted px-3 py-2.5">
        <p class="text-xs text-muted-foreground">Safety code</p>
        <p class="mt-1 font-mono text-base tracking-[0.12em] tabular-nums" data-testid="safety-code">
          {{ store.safetyCode }}
        </p>
      </div>
      <Button
        v-if="store.safetyCode"
        variant="secondary"
        size="sm"
        class="mt-3 w-full"
        @click="ui.safetyCodeOpen.value = true"
      >
        How to compare codes
      </Button>
    </PopoverContent>
  </Popover>
</template>
