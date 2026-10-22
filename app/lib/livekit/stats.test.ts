import { describe, expect, it } from 'vitest'
import { videoDecodeSample } from './stats'

const receiverWith = (reports: Array<Record<string, unknown>>) => ({
  getStats: async () => new Map(reports.map((report, index) => [String(index), report])) as unknown as RTCStatsReport,
})

describe('videoDecodeSample', () => {
  it("reads packets and decoded frames of the receiver's inbound video report", async () => {
    const receiver = receiverWith([
      { type: 'transport', packetsReceived: 999 },
      { type: 'inbound-rtp', kind: 'video', packetsReceived: 120, framesDecoded: 0 },
    ])
    expect(await videoDecodeSample(receiver)).toEqual({ packetsReceived: 120, framesDecoded: 0 })
  })

  it('takes the report with more decoded frames around a layer switch', async () => {
    const receiver = receiverWith([
      { type: 'inbound-rtp', kind: 'video', packetsReceived: 10, framesDecoded: 2 },
      { type: 'inbound-rtp', mediaType: 'video', packetsReceived: 400, framesDecoded: 90 },
    ])
    expect(await videoDecodeSample(receiver)).toEqual({ packetsReceived: 400, framesDecoded: 90 })
  })

  it('is null without an inbound video report', async () => {
    const receiver = receiverWith([{ type: 'inbound-rtp', kind: 'audio', packetsReceived: 50 }])
    expect(await videoDecodeSample(receiver)).toBeNull()
  })
})
