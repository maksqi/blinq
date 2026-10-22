import { computed, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallContext, ParticipantView } from '../../../contracts/call'
import { createEventBus } from '../../event-bus'
import { participantInfoStore } from './useParticipantInfo'

function context(role: 'host' | 'participant' = 'host') {
  const callApi = vi.fn(async () => ({ items: [{ identity: 'p_peer', micAllowed: true, cameraAllowed: true, volumeLevel: 100 }] }))
  const ctx = {
    phase: shallowRef('inCall'),
    roomId: shallowRef('room-1'),
    self: computed(() => ({ identity: 'p_self', role }) as unknown as ParticipantView),
    events: createEventBus(),
    callApi,
  } as unknown as CallContext
  return { ctx, callApi }
}

describe('participantInfoStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fetches the allowances for moderators after the debounce', async () => {
    const { ctx, callApi } = context()
    const store = participantInfoStore(ctx)
    store.refresh()
    await vi.advanceTimersByTimeAsync(200)
    expect(callApi).toHaveBeenCalledWith('/participants')
    expect(store.byIdentity.value.get('p_peer')?.micAllowed).toBe(true)
  })

  it('never fetches for participants', async () => {
    const { ctx, callApi } = context('participant')
    await participantInfoStore(ctx).refreshNow()
    expect(callApi).not.toHaveBeenCalled()
  })

  it('drops a pending refetch and fetches nothing once the local participant starts leaving', async () => {
    const { ctx, callApi } = context()
    const store = participantInfoStore(ctx)
    store.refresh()
    ctx.events.emit('call.leaving', undefined)
    await vi.advanceTimersByTimeAsync(500)
    store.refresh(0)
    await store.refreshNow()
    await vi.advanceTimersByTimeAsync(500)
    expect(callApi).not.toHaveBeenCalled()
  })
})
