import { describe, expect, it, vi } from 'vitest'
import { ReceiverWatchdog, type DecodeSample, type WatchedTrack } from './receiver-watchdog'

function setup() {
  let now = 0
  const watchdog = new ReceiverWatchdog({ now: () => now, graceMs: 5_000, minPackets: 50 })
  return {
    watchdog,
    advance: (ms: number) => {
      now += ms
    },
  }
}

/** A remote track whose receiver statistics the test sets. */
function remote(identity: string, kind: 'audio' | 'video', overrides: Partial<WatchedTrack> = {}) {
  const stats: DecodeSample = { packetsReceived: 0, framesDecoded: 0 }
  const sample = vi.fn(async () => ({ ...stats }))
  const watched: WatchedTrack = { track: {}, identity, kind, ready: true, enabled: true, sample, ...overrides }
  return { watched, stats, sample }
}

describe('ReceiverWatchdog', () => {
  it('reports a subscribed track blinq never accepted after the grace time, and not before', async () => {
    const { watchdog, advance } = setup()
    const { watched } = remote('p_a', 'audio', { ready: false })
    expect(await watchdog.check([watched])).toEqual(new Set())
    advance(4_000)
    expect(await watchdog.check([watched])).toEqual(new Set())
    advance(1_000)
    expect(await watchdog.check([watched])).toEqual(new Set(['p_a']))
  })

  it('stops reporting a track once it is accepted', async () => {
    const { watchdog, advance } = setup()
    const { watched } = remote('p_a', 'audio', { ready: false })
    await watchdog.check([watched])
    advance(6_000)
    expect(await watchdog.check([watched])).toEqual(new Set(['p_a']))
    expect(await watchdog.check([{ ...watched, ready: true }])).toEqual(new Set())
  })

  it('restarts every clock after a reset (reconnecting: events are buffered on purpose)', async () => {
    const { watchdog, advance } = setup()
    const { watched } = remote('p_a', 'video', { ready: false })
    await watchdog.check([watched])
    advance(4_000)
    watchdog.reset()
    advance(2_000)
    expect(await watchdog.check([watched])).toEqual(new Set())
    advance(5_000)
    expect(await watchdog.check([watched])).toEqual(new Set(['p_a']))
  })

  it('reports an accepted video track that receives packets but decodes no frame', async () => {
    const { watchdog, advance } = setup()
    const { watched, stats } = remote('p_v', 'video')
    stats.packetsReceived = 10
    expect(await watchdog.check([watched])).toEqual(new Set())
    advance(5_000)
    stats.packetsReceived = 300
    expect(await watchdog.check([watched])).toEqual(new Set(['p_v']))
  })

  it('does not report a video track that receives too few packets to decode (paused or starting)', async () => {
    const { watchdog, advance } = setup()
    const { watched, stats } = remote('p_v', 'video')
    await watchdog.check([watched])
    advance(10_000)
    stats.packetsReceived = 20
    expect(await watchdog.check([watched])).toEqual(new Set())
  })

  it('verifies a video track at its first decoded frame and never samples it again', async () => {
    const { watchdog, advance } = setup()
    const { watched, stats, sample } = remote('p_v', 'video')
    stats.packetsReceived = 40
    stats.framesDecoded = 1
    expect(await watchdog.check([watched])).toEqual(new Set())
    stats.framesDecoded = 0
    advance(60_000)
    stats.packetsReceived = 5_000
    expect(await watchdog.check([watched])).toEqual(new Set())
    expect(sample).toHaveBeenCalledTimes(1)
  })

  it('stops reporting a stalled video track once it decodes', async () => {
    const { watchdog, advance } = setup()
    const { watched, stats } = remote('p_v', 'video')
    await watchdog.check([watched])
    advance(5_000)
    stats.packetsReceived = 100
    expect(await watchdog.check([watched])).toEqual(new Set(['p_v']))
    stats.framesDecoded = 3
    expect(await watchdog.check([watched])).toEqual(new Set())
  })

  it('never samples accepted audio or a video track the policy disabled', async () => {
    const { watchdog, advance } = setup()
    const audio = remote('p_a', 'audio')
    const paused = remote('p_v', 'video', { enabled: false })
    await watchdog.check([audio.watched, paused.watched])
    advance(10_000)
    expect(await watchdog.check([audio.watched, paused.watched])).toEqual(new Set())
    expect(audio.sample).not.toHaveBeenCalled()
    expect(paused.sample).not.toHaveBeenCalled()
  })

  it('restarts the decode clock when a disabled video track is enabled again', async () => {
    const { watchdog, advance } = setup()
    const { watched, stats } = remote('p_v', 'video')
    await watchdog.check([watched])
    advance(4_000)
    await watchdog.check([{ ...watched, enabled: false }])
    advance(2_000)
    stats.packetsReceived = 200
    expect(await watchdog.check([watched])).toEqual(new Set())
    advance(5_000)
    stats.packetsReceived = 400
    expect(await watchdog.check([watched])).toEqual(new Set(['p_v']))
  })

  it('ignores a track whose statistics are unavailable', async () => {
    const { watchdog, advance } = setup()
    const failing = remote('p_x', 'video', { sample: vi.fn(async () => Promise.reject(new Error('closed'))) })
    const missing = remote('p_y', 'video', { sample: vi.fn(async () => null) })
    await watchdog.check([failing.watched, missing.watched])
    advance(10_000)
    expect(await watchdog.check([failing.watched, missing.watched])).toEqual(new Set())
  })

  it('reports each identity once however many of its tracks stall', async () => {
    const { watchdog, advance } = setup()
    const camera = remote('p_a', 'video', { ready: false })
    const mic = remote('p_a', 'audio', { ready: false })
    const other = remote('p_b', 'audio')
    await watchdog.check([camera.watched, mic.watched, other.watched])
    advance(5_000)
    expect(await watchdog.check([camera.watched, mic.watched, other.watched])).toEqual(new Set(['p_a']))
  })
})
