import { execFileSync } from 'node:child_process'
import { hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { BrowserContext, Page, Request } from '@playwright/test'
import { expect, test } from '../fixtures'
import { e2eLogFile } from '../fixtures/base'
import { callState, waitForPhase, waitForRemoteFrames } from '../fixtures/livekit'
import {
  apiAs,
  leaveCalls,
  newWatchedContext,
  openToPrejoin,
  pressJoin,
  spendJoinBudget,
  waitingRequestId,
} from '../join/support'

// DoD (Stage 04, docs/SECURITY.md §3): the room key never leaves the browser. A room is created in the browser, its
// host and an invited guest meet through the waiting room, and everything that left either browser is recorded:
// request URLs, headers and bodies, WebSocket frames and the waiting-room SSE URL. Neither the key nor anything
// derived from it (media and chat keys) may appear there, nor in a pg_dump of the E2E database, nor in the app and
// Caddy logs. The join proof is allowed only in the bodies of the requests that carry it by design, and nowhere else.

interface Recorded {
  requests: Array<{ url: string; method: string; headers: Promise<Record<string, string>>; body: Buffer | null }>
  sockets: string[]
  frames: Buffer[]
}

function record(context: BrowserContext, into: Recorded) {
  const onRequest = (request: Request) => {
    into.requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.allHeaders().catch(() => request.headers()),
      body: request.postDataBuffer(),
    })
  }
  const onPage = (page: Page) => {
    page.on('websocket', (socket) => {
      into.sockets.push(socket.url())
      socket.on('framesent', (frame) => into.frames.push(Buffer.from(frame.payload)))
      socket.on('framereceived', (frame) => into.frames.push(Buffer.from(frame.payload)))
    })
  }
  context.on('request', onRequest)
  context.on('page', onPage)
  for (const page of context.pages()) onPage(page)
}

/** Every text form a secret could take: base64url, padded and unpadded base64, hex. */
function forms(bytes: Buffer): string[] {
  const base64 = bytes.toString('base64')
  return [
    bytes.toString('base64url'),
    base64,
    base64.replace(/=+$/, ''),
    bytes.toString('hex'),
    bytes.toString('hex').toUpperCase(),
  ]
}

function derive(key: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, Buffer.from(info, 'utf8'), 32))
}

function findIn(haystack: Buffer | string, secrets: Map<string, Buffer>): string[] {
  const text = typeof haystack === 'string' ? haystack : haystack.toString('latin1')
  const hits: string[] = []
  for (const [label, bytes] of secrets) {
    const raw = typeof haystack === 'string' ? false : haystack.includes(bytes)
    if (raw || forms(bytes).some((form) => text.includes(form))) hits.push(label)
  }
  return hits
}

test.describe('key hygiene', () => {
  test('the room key and its derivations never leave the browser', async ({
    page,
    context,
    browser,
    rooms,
    guards,
    secrets,
  }) => {
    test.setTimeout(120_000)
    const recorded: Recorded = { requests: [], sockets: [], frames: [] }
    record(context, recorded)

    // The host creates the room in the browser (waiting room on, so the guest goes through the SSE).
    const host = await rooms.createUser({ displayName: 'Kim Keyholder' })
    await rooms.useIdentity(context, host)
    await page.goto('/dashboard')
    // A click before hydration does nothing (the button has no handler yet), so wait for the app and its chunks.
    await page.waitForFunction(() => Boolean((document.querySelector('#__nuxt') as { __vue_app__?: unknown } | null)?.__vue_app__))
    await page.waitForLoadState('networkidle')
    await page.getByTestId('new-room').click()
    await page.getByTestId('create-room-dialog').getByLabel('Name').fill('Key hygiene')
    await spendJoinBudget(2)
    const [hostJoin] = await Promise.all([
      page.waitForResponse((res) => /^\/api\/join\/[a-z-]+$/.test(new URL(res.url()).pathname)),
      (async () => {
        await page.getByTestId('create-room-submit').click()
        await expect(page.getByTestId('prejoin')).toBeVisible({ timeout: 20_000 })
        await pressJoin(page)
      })(),
    ])
    const grant = (await hostJoin.json()) as { epoch: string; status: string; roomId: string }
    expect(grant.status).toBe('admitted')
    await waitForPhase(page, 'inCall')
    const slug = new URL(page.url()).pathname.slice(3)

    // K exists only in this browser: read it from the key vault.
    const vault = await page.evaluate((id) => localStorage.getItem(`blinq:keys:${id}`), host.id)
    const entry = Object.values(JSON.parse(vault!) as Record<string, { k: string; slug: string }>).find(
      (item) => item.slug === slug,
    )!
    secrets.track(entry.k, 'room key (browser-made)')
    const key = Buffer.from(entry.k, 'base64url')
    expect(key).toHaveLength(32)
    const proof = derive(key, Buffer.alloc(0), `blinq/v1/join|${slug}`)
    secrets.track(proof.toString('base64url'), 'join proof (browser-made)')
    const epoch = Buffer.from(grant.epoch, 'base64url')
    const forbidden = new Map<string, Buffer>([
      ['room key', key],
      ['media key', derive(key, epoch, `blinq/v1/media|${slug}`)],
      ['chat key', derive(key, epoch, `blinq/v1/chat|${slug}`)],
    ])
    const forbiddenWithProof = new Map([...forbidden, ['join proof', proof]])

    // An invite from the room page, opened by a guest in another browser context.
    const roomPage = await context.newPage()
    await roomPage.goto('/dashboard')
    await roomPage.getByTestId('room-item').filter({ hasText: slug }).getByTestId('room-name').click()
    await roomPage.getByTestId('invite-create').click()
    const link = await roomPage.getByTestId('invite-link').first().inputValue()
    await roomPage.close()

    const guestContext = await newWatchedContext(browser, guards)
    record(guestContext, recorded)
    const guest = await guestContext.newPage()
    await openToPrejoin(guest, link)
    const requestId = await waitingRequestId(guest, slug, () => pressJoin(guest, 'Gil Guest'))
    await expect(guest.getByTestId('waiting-room')).toBeVisible()
    const admit = await apiAs(host, 'POST', `/api/calls/${grant.roomId}/lobby/${requestId}/admit`)
    expect(admit.status).toBe(204)
    await waitForPhase(guest, 'inCall')
    const guestIdentity = (await callState(guest))!.identity!
    const hostIdentity = (await callState(page))!.identity!
    await waitForRemoteFrames(page, guestIdentity, 5)
    await waitForRemoteFrames(guest, hostIdentity, 5)

    await leaveCalls(guest, page)
    await guestContext.close()
    // Let the access log lines of closed WebSocket and SSE connections reach the files.
    await page.waitForTimeout(1_500)

    // 1. Request URLs (pages, API, SSE, the WebSocket handshake) and headers carry none of it.
    const urls = [...recorded.requests.map((request) => request.url), ...recorded.sockets]
    for (const url of urls) expect(findIn(url, forbiddenWithProof), url).toEqual([])
    for (const request of recorded.requests) {
      expect(findIn(JSON.stringify(await request.headers), forbiddenWithProof), `headers of ${request.url}`).toEqual([])
    }
    const sse = recorded.requests.filter((request) => request.url.includes('/events'))
    expect(sse.length).toBeGreaterThan(0)
    for (const request of sse) {
      expect(new URL(request.url).pathname).toBe(`/api/join/requests/${requestId}/events`)
      expect(new URL(request.url).search).toBe('')
    }

    // 2. Bodies: the proof only where it belongs, the key and its media and chat keys never.
    const proofCarriers = new Set(['/api/rooms', `/api/join/${slug}/info`, `/api/join/${slug}`])
    let proofsSeen = 0
    for (const request of recorded.requests) {
      if (!request.body) continue
      const path = new URL(request.url).pathname
      const allowed = proofCarriers.has(path) && request.method === 'POST'
      expect(
        findIn(request.body, allowed ? forbidden : forbiddenWithProof),
        `body of ${request.method} ${path}`,
      ).toEqual([])
      if (allowed && findIn(request.body, new Map([['proof', proof]])).length) proofsSeen++
    }
    // The scanner works: the proof was seen where it is supposed to be (create, info and join of host and guest).
    expect(proofsSeen).toBeGreaterThanOrEqual(5)

    // 3. WebSocket frames (LiveKit signaling) in both directions.
    expect(recorded.frames.length).toBeGreaterThan(10)
    for (const frame of recorded.frames) expect(findIn(frame, forbiddenWithProof)).toEqual([])

    // 4. The database: the server stores sha256(proof) and never anything else derived from the key.
    // The dev stack's Postgres in host mode; the Docker runner (scripts/e2e-docker.sh) names its own container.
    const url = new URL(process.env.DATABASE_URL!)
    const postgres = process.env.E2E_POSTGRES_CONTAINER ?? 'blinq-dev-postgres-1'
    const dump = execFileSync(
      'docker',
      ['exec', postgres, 'pg_dump', '-U', decodeURIComponent(url.username), url.pathname.slice(1)],
      { maxBuffer: 512 * 1024 * 1024 },
    )
    expect(dump.toString('utf8')).toContain(slug)
    expect(findIn(dump, forbiddenWithProof)).toEqual([])

    // 5. The app and Caddy logs of the whole run so far.
    for (const name of ['app.log', 'caddy.log'] as const) {
      const log = readFileSync(e2eLogFile(name))
      expect(findIn(log, forbiddenWithProof), name).toEqual([])
    }
  })
})
