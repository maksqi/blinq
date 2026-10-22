import { test } from '../e2e/fixtures'
import { DEFAULT_OPTIONS, runSwarm } from './swarm'

/**
 * Single-machine swarm run against the E2E stack (tests/load/playwright.config.ts): a host account creates a room for
 * 25 people (no waiting room) and an unlimited invite through the real API, then `runSwarm` joins the observer and
 * SWARM_BOTS guests through that invite link and prints the JSON summary (also written to SWARM_OUT).
 *
 * Environment: SWARM_BOTS (8), SWARM_DURATION seconds of steady state (60), SWARM_JOIN_INTERVAL ms (4500),
 * SWARM_BOTS_PER_BROWSER (4), SWARM_VIDEO_SIZE (640x360), SWARM_SFU_CONTAINER (E2E_LIVEKIT_CONTAINER, else
 * blinq-dev-livekit-1), SWARM_OUT.
 *
 * In the Docker runner (scripts/e2e-docker.sh, the default on macOS) E2E_LIVEKIT_CONTAINER names the runner's own
 * LiveKit. Browsers and the SFU share one network namespace there, so media never crosses eth0 and the SFU Mbit/s
 * columns read about 0; the SFU CPU and memory columns are real.
 */
const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

test('browser swarm on this machine', async ({ rooms }) => {
  const host = await rooms.createUser({ displayName: 'Load Host' })
  const room = await rooms.createRoom(host, { name: 'Load test', waitingRoom: false, maxParticipants: 25 })
  const link = rooms.inviteLink(room, await rooms.createInvite(room, host, { expiresIn: '1h', maxUses: null }))
  const bots = env('SWARM_BOTS', 8)

  const summary = await runSwarm({
    ...DEFAULT_OPTIONS,
    link,
    bots,
    durationSec: env('SWARM_DURATION', 60),
    joinIntervalMs: env('SWARM_JOIN_INTERVAL', DEFAULT_OPTIONS.joinIntervalMs),
    botsPerBrowser: env('SWARM_BOTS_PER_BROWSER', DEFAULT_OPTIONS.botsPerBrowser),
    videoSize: process.env.SWARM_VIDEO_SIZE ?? DEFAULT_OPTIONS.videoSize,
    namePrefix: 'Bot',
    sfuContainer: process.env.SWARM_SFU_CONTAINER ?? process.env.E2E_LIVEKIT_CONTAINER ?? 'blinq-dev-livekit-1',
    out: process.env.SWARM_OUT,
    log: (line) => console.log(`swarm: ${line}`),
  })
  console.log(JSON.stringify(summary, null, 2))
  await test.info().attach('swarm.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })
})
