/**
 * Server allowances `ParticipantView` lacks (`micAllowed`, `cameraAllowed`, `volumeLevel`) from
 * `GET /api/calls/:roomId/participants`, one store per call (keyed by the `CallContext`).
 *
 * Only moderators fetch (the moderation menu is theirs). Refetch: when the people panel opens, on the
 * `participant.changed` hint, after each own action and on `participant.joined/left` (debounced 200 ms). Failures keep
 * the last good list. Nothing is fetched once the local participant starts leaving: the server ends their row while the
 * phase is still `inCall`, so a fetch then would only answer 403.
 */
import { onMounted, shallowRef, type ShallowRef } from 'vue'
import type { CallParticipantInfo } from '#shared/schemas/calls'
import type { CallContext } from '../../../contracts/call'
import { useCall } from '~/composables/call'

export const INFO_DEBOUNCE_MS = 200

export interface ParticipantInfoStore {
  /** By identity; empty until the first successful fetch. */
  readonly byIdentity: ShallowRef<ReadonlyMap<string, CallParticipantInfo>>
  readonly loaded: ShallowRef<boolean>
  /** Debounced refetch (200 ms by default). */
  refresh(delayMs?: number): void
  refreshNow(): Promise<void>
  dispose(): void
}

export function isModeratorRole(role: string | undefined | null): boolean {
  return role === 'host' || role === 'cohost'
}

const stores = new WeakMap<CallContext, ParticipantInfoStore>()

function createStore(ctx: CallContext): ParticipantInfoStore {
  const byIdentity = shallowRef<ReadonlyMap<string, CallParticipantInfo>>(new Map())
  const loaded = shallowRef(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null
  let again = false
  let disposed = false
  let leaving = false
  const stopTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const offLeaving = ctx.events.on('call.leaving', () => {
    leaving = true
    stopTimer()
  })

  const enabled = () =>
    !disposed &&
    !leaving &&
    ctx.phase.value === 'inCall' &&
    Boolean(ctx.roomId.value) &&
    isModeratorRole(ctx.self.value?.role)

  async function fetchOnce(): Promise<void> {
    try {
      const { items } = await ctx.callApi<{ items: CallParticipantInfo[] }>('/participants')
      if (disposed) return
      byIdentity.value = new Map(items.map((item) => [item.identity, item]))
      loaded.value = true
    } catch {
      // Keep the last good list; the next hint or action refetches.
    }
  }

  async function refreshNow(): Promise<void> {
    if (!enabled()) return
    if (inflight) {
      again = true
      return inflight
    }
    inflight = (async () => {
      do {
        again = false
        await fetchOnce()
      } while (again && enabled())
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    byIdentity,
    loaded,
    refresh(delayMs = INFO_DEBOUNCE_MS) {
      if (disposed || leaving) return
      stopTimer()
      timer = setTimeout(() => {
        timer = null
        void refreshNow()
      }, delayMs)
    },
    refreshNow,
    dispose() {
      disposed = true
      stopTimer()
      offLeaving()
    },
  }
}

export function participantInfoStore(ctx: CallContext): ParticipantInfoStore {
  let store = stores.get(ctx)
  if (!store) {
    store = createStore(ctx)
    stores.set(ctx, store)
  }
  return store
}

/** In components: the store of the surrounding call; refetches when the component mounts (panel open). */
export function useParticipantInfo(): ParticipantInfoStore {
  const store = participantInfoStore(useCall())
  onMounted(() => store.refresh(0))
  return store
}
