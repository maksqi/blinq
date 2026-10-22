<script setup lang="ts">
/**
 * Background blur level, noise suppression and (optionally) own mic gain, shared by the pre-join slot and the settings
 * section. Unsupported choices stay visible but disabled, with the reason underneath.
 */
import { computed } from 'vue'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useCall } from '~/composables/call'
import { effectsFor } from '~/lib/call/features/effects/controller'
import { BLUR_LABELS, BLUR_LEVELS, isBlurLevel, isNoiseMode, NOISE_LABELS, NOISE_MODES } from '~/lib/media/levels'

const props = withDefaults(
  defineProps<{
    /** Prefix for element ids (the pre-join and the settings dialog can exist at once). */
    idPrefix: string
    showGain?: boolean
    /** Small muted labels, like the pre-join device pickers. */
    compact?: boolean
  }>(),
  { showGain: false, compact: false },
)

const effects = effectsFor(useCall())
const state = effects?.state

const percent = computed(() => Math.round((state?.gain ?? 1) * 100))
const labelClass = computed(() => (props.compact ? 'text-xs text-muted-foreground' : undefined))

function onBlur(value: unknown) {
  // A single toggle group emits an empty value when the active item is clicked again: keep the level.
  if (isBlurLevel(value)) void effects?.setBlur(value)
}

function onNoise(value: unknown) {
  if (isNoiseMode(value)) void effects?.setNoise(value)
}

function onGain(value: number[] | undefined) {
  const next = value?.[0]
  if (typeof next === 'number') effects?.setGain(next / 100)
}
</script>

<template>
  <div v-if="effects && state" class="flex flex-col gap-4" data-testid="effects-controls">
    <!-- No data-disabled on the field: the dimmed label would fail contrast (F-071); the disabled toggles dim themselves
    and the reason below stays readable. -->
    <Field :class="cn(compact && 'gap-1.5')">
      <FieldLabel :id="`${idPrefix}-blur-label`" :class="labelClass">Background blur</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        class="w-full"
        :model-value="state.blur"
        :disabled="!state.blurSupport.ok"
        :aria-labelledby="`${idPrefix}-blur-label`"
        data-testid="blur-level"
        @update:model-value="onBlur"
      >
        <ToggleGroupItem
          v-for="level in BLUR_LEVELS"
          :key="level"
          :value="level"
          class="flex-1"
          :data-testid="`blur-${level}`"
        >
          {{ BLUR_LABELS[level] }}
        </ToggleGroupItem>
      </ToggleGroup>
      <FieldDescription v-if="!state.blurSupport.ok" data-testid="blur-unsupported">
        {{ state.blurSupport.reason }}
      </FieldDescription>
      <p
        v-else-if="state.blurLoading"
        role="status"
        class="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid="blur-loading"
      >
        <Spinner class="size-3.5" />
        Loading background blur…
      </p>
    </Field>

    <Field :class="cn(compact && 'gap-1.5')">
      <FieldLabel :for="`${idPrefix}-noise`" :class="labelClass">Noise suppression</FieldLabel>
      <Select :model-value="state.noise" :disabled="state.noiseBusy" @update:model-value="onNoise">
        <SelectTrigger :id="`${idPrefix}-noise`" class="w-full" data-testid="noise-mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem
            v-for="mode in NOISE_MODES"
            :key="mode"
            :value="mode"
            :disabled="mode === 'rnnoise' && !state.rnnoiseSupport.ok"
            :data-testid="`noise-${mode}`"
          >
            {{ NOISE_LABELS[mode] }}
          </SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription v-if="!state.rnnoiseSupport.ok" data-testid="rnnoise-unsupported">
        {{ state.rnnoiseSupport.reason }}
      </FieldDescription>
    </Field>

    <Field v-if="showGain" :class="cn(compact && 'gap-1.5')">
      <div class="flex items-center justify-between">
        <FieldLabel :for="`${idPrefix}-gain`" :class="labelClass">Microphone volume</FieldLabel>
        <span class="text-xs text-muted-foreground tabular-nums" data-testid="mic-gain-value">{{ percent }}%</span>
      </div>
      <Slider
        :id="`${idPrefix}-gain`"
        :model-value="[percent]"
        :min="0"
        :max="200"
        :step="5"
        aria-label="Microphone volume"
        data-testid="mic-gain"
        @update:model-value="onGain"
      />
    </Field>
  </div>
</template>
