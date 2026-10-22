<script setup lang="ts">
/**
 * Host controls (control bar, hosts and co-hosts): lock the meeting; for the host also the live settings (waiting room,
 * screen share, self-unmute, chat); mute all; end the meeting for all. Every change is one `PATCH /settings` field.
 * The displayed value is the room metadata (server truth); a switch shows a pending state until the `{ state }` answer
 * or the metadata confirms it, and falls back with an error toast when the request fails.
 */
import { KeyRoundIcon, MicOffIcon, PhoneOffIcon, ShieldCheckIcon } from '@lucide/vue'
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import RotateKeyLink from './RotateKeyLink.vue'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useCall } from '~/composables/call'
import { rotateReminderText } from '~/lib/call/features/host-actions/removal'
import { callActions, hostActionsState } from '~/lib/call/features/host-actions/state'
import {
  PendingSettings,
  visibleControls,
  type LiveSettingKey,
  type LiveSettings,
} from '~/lib/call/features/room-settings/controls'

const ctx = useCall()
const actions = callActions(ctx)
const hostState = hostActionsState(ctx)

const open = shallowRef(false)
const trigger = useTemplateRef<HTMLButtonElement>('trigger')
const muteAllOpen = shallowRef(false)
const endOpen = shallowRef(false)
const preventSelfUnmute = shallowRef(false)
const mutingAll = shallowRef(false)
const ending = shallowRef(false)

const actor = computed(() => {
  const self = ctx.self.value
  return self ? { identity: self.identity, role: self.role, kind: self.kind } : null
})
const controls = computed(() => new Set(visibleControls(actor.value)))
const state = computed(() => ctx.roomState.value)

// The pending bookkeeping is a plain object; `version` re-renders after each change.
const pending = new PendingSettings()
const version = shallowRef(0)
watch(state, (next) => {
  pending.onState(next)
  version.value++
})

function display<K extends LiveSettingKey>(key: K): LiveSettings[K] | undefined {
  void version.value
  return pending.display(key, state.value)
}
function isPending(key: LiveSettingKey): boolean {
  void version.value
  return pending.isPending(key)
}

async function change<K extends LiveSettingKey>(key: K, value: LiveSettings[K]) {
  if (isPending(key) || display(key) === value) return
  pending.request(key, value)
  version.value++
  const result = await actions.updateSettings({ [key]: value })
  if (result.ok) pending.succeed(key, result.value)
  else pending.fail(key)
  version.value++
}

const TOGGLES: Array<{ key: Exclude<LiveSettingKey, 'screenSharePolicy'>; label: string; hint: string }> = [
  { key: 'locked', label: 'Lock meeting', hint: 'Nobody new can join or ask to join.' },
  { key: 'waitingRoom', label: 'Waiting room', hint: 'People wait until a host lets them in.' },
  { key: 'allowSelfUnmute', label: 'Let participants unmute themselves', hint: 'Off: only hosts can give voice.' },
  { key: 'chatEnabled', label: 'Chat', hint: 'Everyone can send messages.' },
]
const toggles = computed(() => TOGGLES.filter((toggle) => controls.value.has(toggle.key)))

function onSharePolicy(value: unknown) {
  if (value === 'everyone' || value === 'hosts') void change('screenSharePolicy', value)
}

function openMuteAll() {
  open.value = false
  preventSelfUnmute.value = false
  muteAllOpen.value = true
}

function openEnd() {
  open.value = false
  endOpen.value = true
}

// Both dialogs open from a button inside the popover, which is gone when they close: hand focus back to the Host
// controls button instead of letting it fall to <body> (WCAG 2.4.3, F-072).
function focusTrigger(event: Event) {
  if (!trigger.value?.isConnected) return
  event.preventDefault()
  trigger.value.focus()
}

async function muteAll() {
  mutingAll.value = true
  try {
    const result = await actions.muteAll(preventSelfUnmute.value)
    if (result.ok) muteAllOpen.value = false
  } finally {
    mutingAll.value = false
  }
}

async function endForAll() {
  ending.value = true
  try {
    const result = await actions.end()
    if (result.ok) endOpen.value = false
  } finally {
    ending.value = false
  }
}

const reminder = computed(() => (hostState.removedCount.value > 0 ? rotateReminderText(ctx.self.value?.role) : null))
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        ref="trigger"
        type="button"
        aria-label="Host controls"
        title="Host controls"
        data-control="host-controls"
        :class="
          cn(
            'relative inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            open ? 'bg-primary/25 text-primary hover:bg-primary/30' : 'bg-white/10 hover:bg-white/18',
          )
        "
      >
        <ShieldCheckIcon class="size-5" aria-hidden="true" />
        <span v-if="state?.locked" class="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-amber-400" />
        <span v-if="state?.locked" class="sr-only">(meeting locked)</span>
      </button>
    </PopoverTrigger>
    <PopoverContent
      side="top"
      align="end"
      :side-offset="10"
      :collision-padding="12"
      class="flex max-h-[min(36rem,calc(100dvh-7rem))] w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-1 overflow-y-auto p-2"
      data-testid="host-controls"
    >
      <h2 class="px-2 pt-1 pb-2 text-sm font-semibold">Host controls</h2>

      <div
        v-for="toggle in toggles"
        :key="toggle.key"
        class="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-white/4"
        :data-setting="toggle.key"
        :data-pending="isPending(toggle.key) || undefined"
      >
        <div class="flex min-w-0 flex-col">
          <Label :for="`host-setting-${toggle.key}`" class="text-sm font-medium">{{ toggle.label }}</Label>
          <span class="text-xs text-muted-foreground">{{ toggle.hint }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Spinner v-if="isPending(toggle.key)" class="size-3.5 text-muted-foreground" />
          <Switch
            :id="`host-setting-${toggle.key}`"
            :model-value="display(toggle.key) === true"
            :disabled="isPending(toggle.key) || !state"
            :data-testid="`setting-${toggle.key}`"
            @update:model-value="(value: boolean) => change(toggle.key, value)"
          />
        </div>
      </div>

      <div
        v-if="controls.has('screenSharePolicy')"
        class="flex flex-col gap-2 rounded-md px-2 py-2"
        data-setting="screenSharePolicy"
        :data-pending="isPending('screenSharePolicy') || undefined"
      >
        <div class="flex items-center justify-between gap-2">
          <span id="host-setting-share" class="text-sm font-medium">Who can share their screen</span>
          <Spinner v-if="isPending('screenSharePolicy')" class="size-3.5 text-muted-foreground" />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          class="w-full"
          aria-labelledby="host-setting-share"
          :model-value="display('screenSharePolicy')"
          :disabled="isPending('screenSharePolicy') || !state"
          data-testid="setting-screenSharePolicy"
          @update:model-value="onSharePolicy"
        >
          <ToggleGroupItem value="everyone" class="flex-1" data-testid="share-everyone">Everyone</ToggleGroupItem>
          <ToggleGroupItem value="hosts" class="flex-1" data-testid="share-hosts">Hosts and co-hosts</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div v-if="controls.has('muteAll') || controls.has('end')" class="mt-1 flex flex-col gap-1 border-t pt-2">
        <Button
          v-if="controls.has('muteAll')"
          variant="ghost"
          class="justify-start"
          data-testid="host-mute-all"
          @click="openMuteAll"
        >
          <MicOffIcon aria-hidden="true" />
          Mute all
        </Button>
        <Button
          v-if="controls.has('end')"
          variant="destructive"
          class="justify-start"
          data-testid="host-end-meeting"
          @click="openEnd"
        >
          <PhoneOffIcon aria-hidden="true" />
          End meeting for all
        </Button>
      </div>

      <div
        v-if="reminder"
        class="mt-1 flex items-start gap-2 rounded-md bg-amber-950/50 p-2.5 text-xs text-amber-100 ring-1 ring-amber-400/25"
        data-testid="rotate-key-reminder"
      >
        <KeyRoundIcon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div class="flex flex-col gap-1.5">
          <p>{{ reminder }}</p>
          <RotateKeyLink v-if="ctx.self.value?.role === 'host' && ctx.roomId.value" :room-id="ctx.roomId.value" />
        </div>
      </div>
    </PopoverContent>
  </Popover>

  <Dialog v-model:open="muteAllOpen">
    <DialogContent class="sm:max-w-md" data-testid="mute-all-dialog" @close-auto-focus="focusTrigger">
      <DialogHeader>
        <DialogTitle>Mute everyone?</DialogTitle>
        <DialogDescription
          >Mutes every participant's microphone. Hosts and co-hosts stay as they are.</DialogDescription
        >
      </DialogHeader>
      <div class="flex items-start gap-3">
        <Checkbox id="mute-all-prevent" v-model="preventSelfUnmute" data-testid="mute-all-prevent" />
        <div class="flex flex-col gap-1">
          <Label for="mute-all-prevent">Prevent self-unmute</Label>
          <span class="text-xs text-muted-foreground">Participants can speak again only when a host gives voice.</span>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" :disabled="mutingAll" @click="muteAllOpen = false">Cancel</Button>
        <Button :disabled="mutingAll" data-testid="mute-all-confirm" @click="muteAll">
          <Spinner v-if="mutingAll" />
          Mute all
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog v-model:open="endOpen">
    <AlertDialogContent data-testid="end-meeting-dialog" @close-auto-focus="focusTrigger">
      <AlertDialogHeader>
        <AlertDialogTitle>End the meeting for everyone?</AlertDialogTitle>
        <AlertDialogDescription>
          Everyone leaves the call, and people in the waiting room are turned away.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="ending">Cancel</AlertDialogCancel>
        <Button variant="destructive" :disabled="ending" data-testid="end-meeting-confirm" @click="endForAll">
          <Spinner v-if="ending" />
          End meeting
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
