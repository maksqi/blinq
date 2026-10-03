/**
 * Shared helpers of the production smoke specs. scripts/smoke-prod.sh passes the stack's parameters as SMOKE_*
 * variables; nothing here talks to the dev stack.
 */
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { BrowserContext } from '@playwright/test'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set: run the smoke specs with sh scripts/smoke-prod.sh`)
  return value
}

export const smoke = {
  baseURL: process.env.SMOKE_BASE_URL ?? 'https://blinq.localhost',
  get domain() {
    return new URL(this.baseURL).hostname
  },
  turnDomain: () => required('SMOKE_TURN_DOMAIN'),
  /** Caddy's internal root certificate (TLS_MODE=internal), copied out of the caddy_data volume. */
  caCert: () => readFileSync(required('SMOKE_CA_FILE')),
  /** The bootstrap admin from .env.smoke (ADMIN_PASSWORD is its first-login password). */
  adminEmail: () => required('ADMIN_EMAIL'),
  adminPassword: () => required('ADMIN_PASSWORD'),
  nodeIp: () => required('SMOKE_NODE_IP'),
  rtcPortRange: (): [number, number] => {
    const [start, end] = required('SMOKE_RTC_PORT_RANGE').split('-').map(Number)
    return [start ?? 0, end ?? 0]
  },
}

/** A TLS connection to Caddy on 127.0.0.1:443, verified against the internal root for `servername`. */
export function connectTls(servername: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: 443, servername, ca: [smoke.caCert()], timeout: 10_000 })
    socket.once('secureConnect', () => resolve(socket))
    socket.once('error', reject)
    socket.once('timeout', () => socket.destroy(new Error(`TLS connection for ${servername} timed out`)))
  })
}

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * An HTTPS request through Caddy with full control over the body framing: `chunked` sends no Content-Length, which
 * the app's own size check cannot see. The response is resolved as soon as it arrives, even if the upload is cut off.
 */
export function rawRequest(options: {
  method: string
  path: string
  headers?: Record<string, string>
  body?: Buffer
  chunked?: boolean
}): Promise<RawResponse> {
  const url = new URL(options.path, smoke.baseURL)
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers }
    if (options.body && !options.chunked) headers['content-length'] = String(options.body.length)
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: 443,
        servername: url.hostname,
        ca: [smoke.caCert()],
        method: options.method,
        path: url.pathname + url.search,
        headers: { host: url.host, ...headers },
        timeout: 20_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('timeout', () => req.destroy(new Error(`${options.method} ${options.path} timed out`)))
    // The server may answer and close before the whole body is written; the response event wins then.
    req.on('error', (error) => reject(error))
    if (options.body && options.chunked) {
      const piece = 64 * 1024
      for (let offset = 0; offset < options.body.length; offset += piece) {
        req.write(options.body.subarray(offset, offset + piece))
      }
      req.end()
    } else {
      req.end(options.body)
    }
  })
}

export interface PageProblems {
  cspViolations: string[]
  errors: string[]
}

/** Records CSP violations, console errors and uncaught errors of every page in `context`. */
export async function watchProblems(context: BrowserContext): Promise<PageProblems> {
  const problems: PageProblems = { cspViolations: [], errors: [] }
  await context.exposeBinding('__smokeCspViolation', (_source, text: string) => {
    problems.cspViolations.push(text)
  })
  await context.addInitScript(() => {
    addEventListener(
      'securitypolicyviolation',
      (event) => {
        const report = (globalThis as unknown as { __smokeCspViolation?: (text: string) => void }).__smokeCspViolation
        report?.(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline code'} on ${event.documentURI}`)
      },
      true,
    )
  })
  context.on('console', (message) => {
    if (message.type() === 'error') problems.errors.push(`console: ${message.text()} (${message.location().url})`)
  })
  context.on('weberror', (webError) => {
    problems.errors.push(`uncaught: ${webError.error().message}`)
  })
  return problems
}
