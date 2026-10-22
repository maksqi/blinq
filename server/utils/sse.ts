/**
 * Server-sent events (server-core, docs/API.md §6.1).
 *
 *   export default defineEventHandler(async (event) => {
 *     const stream = createSseStream(event)
 *     stream.send('status', { status: 'waiting' })            // queued until start()
 *     stream.onClose(subscribeTo('lobby.decided', (e) => { ...; stream.close() }))
 *     return stream.start()
 *   })
 *
 * - `send(event, data, id?)` writes `event:` + one JSON `data:` line; `comment(text)` writes `: text`.
 * - A `: ping` comment every 15 s keeps proxies from closing idle streams.
 * - `close()` ends the response; `onClose(cb)` runs once on close or client disconnect.
 * - `closeAllSseStreams()` ends every open stream (graceful shutdown).
 * - `createSseStreamGroups()` counts open streams per key, for caps (waiting-room streams per request and per IP).
 * (decision) h3's `createEventStream` cannot write comment lines, so this is a minimal equivalent on `sendStream`.
 */
import { sendStream, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'

export const SSE_HEARTBEAT_MS = 15_000

export interface SseStream {
  send(event: string, data: unknown, id?: string): void
  comment(text: string): void
  close(): void
  onClose(listener: () => void): void
  readonly closed: boolean
  /** Sends the headers and streams until closed. Return its promise from the handler. */
  start(): Promise<void>
}

const openStreams = new Set<SseStream>()

const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ')

export function formatSseEvent(event: string, data: unknown, id?: string): string {
  const json = JSON.stringify(data ?? {})
  return `${id ? `id: ${singleLine(id)}\n` : ''}event: ${singleLine(event)}\ndata: ${json}\n\n`
}

export function formatSseComment(text: string): string {
  return `: ${singleLine(text)}\n\n`
}

export function createSseStream(event: H3Event, options: { heartbeatMs?: number } = {}): SseStream {
  const encoder = new TextEncoder()
  const listeners: Array<() => void> = []
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      finish()
    },
  })

  const write = (text: string) => {
    if (closed || !controller) return
    try {
      controller.enqueue(encoder.encode(text))
    } catch {
      finish()
    }
  }

  const heartbeat = setInterval(() => write(formatSseComment('ping')), options.heartbeatMs ?? SSE_HEARTBEAT_MS)
  heartbeat.unref?.()

  function finish() {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    openStreams.delete(stream)
    try {
      controller?.close()
    } catch {
      // Already closed by the consumer.
    }
    for (const listener of listeners.splice(0)) {
      try {
        listener()
      } catch {
        // Cleanup callbacks must not break other cleanups.
      }
    }
  }

  const stream: SseStream = {
    send: (name, data, id) => write(formatSseEvent(name, data, id)),
    comment: (text) => write(formatSseComment(text)),
    close: finish,
    onClose(listener) {
      if (closed) listener()
      else listeners.push(listener)
    },
    get closed() {
      return closed
    },
    start() {
      setResponseStatus(event, 200)
      setResponseHeaders(event, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      })
      return sendStream(event, readable)
    },
  }

  // Client disconnects surface as 'close' on the response.
  event.node.res.once('close', finish)
  openStreams.add(stream)
  return stream
}

export function closeAllSseStreams(): void {
  for (const stream of [...openStreams]) stream.close()
}

export function openSseStreamCount(): number {
  return openStreams.size
}

/**
 * Open streams grouped by a key (a request id, a client network), for per-key caps (F-019). A stream leaves its
 * group when it closes, so nothing leaks after disconnects.
 */
export interface SseStreamGroups {
  count(key: string): number
  /** The oldest open stream of the group. */
  oldest(key: string): SseStream | undefined
  add(key: string, stream: SseStream): void
  readonly size: number
}

export function createSseStreamGroups(): SseStreamGroups {
  const groups = new Map<string, SseStream[]>()
  return {
    count: (key) => groups.get(key)?.length ?? 0,
    oldest: (key) => groups.get(key)?.[0],
    add(key, stream) {
      if (stream.closed) return
      const list = groups.get(key) ?? []
      list.push(stream)
      groups.set(key, list)
      stream.onClose(() => {
        const current = groups.get(key)
        if (!current) return
        const index = current.indexOf(stream)
        if (index !== -1) current.splice(index, 1)
        if (current.length === 0) groups.delete(key)
      })
    },
    get size() {
      return groups.size
    },
  }
}
