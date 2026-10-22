/**
 * Receiver statistics per remote track (`getStats`), used by the test hooks (`state.inboundVideo`,
 * `state.inboundAudio`) and the connection-quality details. Only encrypted, subscribed tracks exist here: the policy
 * never subscribes anything else.
 */
import { Track, type Room } from 'livekit-client'
import { sourceName } from './subscription-manager'

export interface InboundVideoStats {
  identity: string
  source: string
  trackSid: string
  frameWidth: number
  frameHeight: number
  framesDecoded: number
  framesReceived: number
  packetsReceived: number
  bytesReceived: number
}

export interface InboundAudioStats {
  identity: string
  source: string
  trackSid: string
  audioLevel: number
  totalAudioEnergy: number
  packetsReceived: number
  bytesReceived: number
}

export interface InboundStats {
  video: Record<string, InboundVideoStats>
  audio: Record<string, InboundAudioStats>
}

type Report = Record<string, unknown>

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function inboundRtp(stats: RTCStatsReport, kind: 'audio' | 'video'): Report | undefined {
  let found: Report | undefined
  stats.forEach((report: Report) => {
    if (report.type === 'inbound-rtp' && (report.kind ?? report.mediaType) === kind) {
      // Several reports can exist around a layer switch; the one with more decoded frames is current.
      if (!found || num(report.framesDecoded) >= num(found.framesDecoded)) found = report
    }
  })
  return found
}

/** Packets received and frames decoded by one video receiver (the receiver watchdog's sample); null without a report. */
export async function videoDecodeSample(
  receiver: Pick<RTCRtpReceiver, 'getStats'>,
): Promise<{ packetsReceived: number; framesDecoded: number } | null> {
  const report = inboundRtp(await receiver.getStats(), 'video')
  return report ? { packetsReceived: num(report.packetsReceived), framesDecoded: num(report.framesDecoded) } : null
}

export async function collectInboundStats(room: Room): Promise<InboundStats> {
  const result: InboundStats = { video: {}, audio: {} }
  const jobs: Promise<void>[] = []
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const track = publication.track
      const receiver = track?.receiver
      if (!track || !receiver || !publication.isEncrypted) continue
      jobs.push(
        receiver
          .getStats()
          .then((stats) => {
            const base = {
              identity: participant.identity,
              source: sourceName(publication.source),
              trackSid: publication.trackSid,
            }
            if (publication.kind === Track.Kind.Video) {
              const report = inboundRtp(stats, 'video')
              if (!report) return
              result.video[publication.trackSid] = {
                ...base,
                frameWidth: num(report.frameWidth),
                frameHeight: num(report.frameHeight),
                framesDecoded: num(report.framesDecoded),
                framesReceived: num(report.framesReceived),
                packetsReceived: num(report.packetsReceived),
                bytesReceived: num(report.bytesReceived),
              }
            } else {
              const report = inboundRtp(stats, 'audio')
              if (!report) return
              result.audio[publication.trackSid] = {
                ...base,
                audioLevel: num(report.audioLevel),
                totalAudioEnergy: num(report.totalAudioEnergy),
                packetsReceived: num(report.packetsReceived),
                bytesReceived: num(report.bytesReceived),
              }
            }
          })
          .catch(() => undefined),
      )
    }
  }
  await Promise.all(jobs)
  return result
}
