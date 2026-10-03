import type { Page } from '@playwright/test'
import type { MediaControl } from '~/lib/contracts/call'
import { expect, test } from '../fixtures'
import { inboundAudio, waitForRemoteFrames, type JoinedPeer } from '../fixtures/livekit'

// The MediaControl plug points media-fx uses (Stage 07): a mic insert before the gain stage, browser mic processing
// and a camera processor all apply to the live call without republishing (the publication sids never change).
// Stays on the /dev/call harness (decision): the product UI cannot plug in a custom insert or processor, and only the
// harness exposes the MediaControl and the publication sids (`state.harness`). The UI's own processors (blur, noise
// suppression) are covered on top of it by tests/e2e/media.
type Sids = Record<string, string>
interface HarnessWindow {
  __blinqTest: { state: { harness: { media: MediaControl; publications(): Sids } } }
  __processor?: { processedTrack?: MediaStreamTrack }
}

function publications(page: Page): Promise<Sids> {
  return page.evaluate(() => (window as unknown as HarnessWindow).__blinqTest.state.harness.publications())
}

/** Audio energy the viewer receives from the publisher during `ms`. */
async function energyOver(viewer: JoinedPeer, publisher: JoinedPeer, ms = 2_000): Promise<number> {
  const read = async () => (await inboundAudio(viewer.page, publisher.identity))[0]?.totalAudioEnergy ?? 0
  const start = await read()
  await viewer.page.waitForTimeout(ms)
  return (await read()) - start
}

test.describe('media control', () => {
  test('mic insert, mic processing and a camera processor apply without republishing', async ({ joinAs }) => {
    const host = await joinAs('host', { name: 'Hana Host' })
    const peer = await joinAs('participant', { name: 'Pete Peer', room: host.room })
    await waitForRemoteFrames(peer.page, host.identity, 5)
    await expect
      .poll(async () => (await inboundAudio(peer.page, host.identity))[0]?.totalAudioEnergy ?? 0)
      .toBeGreaterThan(0)
    const before = await publications(host.page)
    expect(before.microphone).toMatch(/^TR_/)
    expect(before.camera).toMatch(/^TR_/)
    const live = await energyOver(peer, host)
    expect(live).toBeGreaterThan(0)

    // A silent insert (gain 0) between the mic source and the gain stage silences the published track…
    await host.page.evaluate(async () => {
      const { media } = (window as unknown as HarnessWindow).__blinqTest.state.harness
      let node: GainNode | null = null
      await media.setMicInsert({
        id: 'silence',
        async connect(context, input) {
          node = context.createGain()
          node.gain.value = 0
          input.connect(node)
          return node
        },
        dispose() {
          node?.disconnect()
        },
      })
    })
    await host.page.waitForTimeout(1_000)
    expect(await energyOver(peer, host)).toBeLessThan(live * 0.05)

    // …and removing it restores the audio.
    await host.page.evaluate(() =>
      (window as unknown as HarnessWindow).__blinqTest.state.harness.media.setMicInsert(null),
    )
    await host.page.waitForTimeout(1_000)
    expect(await energyOver(peer, host)).toBeGreaterThan(live * 0.3)

    // Browser processing re-acquires the microphone behind the chain.
    await host.page.evaluate(() =>
      (window as unknown as HarnessWindow).__blinqTest.state.harness.media.setMicProcessing({
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: true,
      }),
    )
    await host.page.waitForTimeout(1_000)
    expect(await energyOver(peer, host)).toBeGreaterThan(live * 0.3)

    // A camera processor (pass-through) attaches live and survives camera off/on.
    await host.page.evaluate(async () => {
      const w = window as unknown as HarnessWindow
      const processor = {
        name: 'pass-through',
        processedTrack: undefined as MediaStreamTrack | undefined,
        async init({ track }: { track: MediaStreamTrack }) {
          this.processedTrack = track.clone()
        },
        async restart({ track }: { track: MediaStreamTrack }) {
          this.processedTrack?.stop()
          this.processedTrack = track.clone()
        },
        async destroy() {
          this.processedTrack?.stop()
        },
      }
      w.__processor = processor
      await w.__blinqTest.state.harness.media.setCameraProcessor(processor as never)
    })
    await waitForRemoteFrames(peer.page, host.identity, 10)
    const camera = host.page.getByRole('button', { name: 'Camera', exact: true })
    await camera.click()
    await expect(camera).toHaveAttribute('aria-pressed', 'false')
    await camera.click()
    await expect(camera).toHaveAttribute('aria-pressed', 'true')
    await waitForRemoteFrames(peer.page, host.identity, 10)
    const processed = await host.page.evaluate(() => {
      const w = window as unknown as HarnessWindow
      return w.__blinqTest.state.harness.media.cameraTrack()?.id === w.__processor?.processedTrack?.id
    })
    expect(processed).toBe(true)

    await host.page.evaluate(() =>
      (window as unknown as HarnessWindow).__blinqTest.state.harness.media.setCameraProcessor(null),
    )
    await waitForRemoteFrames(peer.page, host.identity, 10)

    // Nothing was republished.
    expect(await publications(host.page)).toEqual(before)
  })
})
