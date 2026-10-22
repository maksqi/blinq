/** Route inventory: every route in docs/API.md has a handler under server/api (and vice versa). */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../_harness'

interface Route {
  method: string
  path: string
}

interface FileRoute extends Route {
  file: string
}

const shape = (route: Route) => `${route.method} ${route.path.replace(/:[A-Za-z]+/g, ':param')}`

function fileRoutes(): FileRoute[] {
  const root = join(REPO_ROOT, 'server/api')
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort()
  return files.map((file) => {
    const segments = file.replace(/\.ts$/, '').split(/[\\/]/)
    const last = segments.pop()!
    const match = last.match(/^(.+)\.(get|post|put|patch|delete)$/)
    if (!match) throw new Error(`Handler without an HTTP method suffix: server/api/${file}`)
    const parts = [...segments, match[1]!].filter((part) => part !== 'index').map((part) => part.replace(/^\[(.+)\]$/, ':$1'))
    return {
      method: match[2]!.toUpperCase(),
      path: `/api/${parts.join('/')}`,
      file: `server/api/${file}`,
    }
  })
}

function documentedRoutes(): Route[] {
  const routes: Route[] = []
  for (const line of readFileSync(join(REPO_ROOT, 'docs/API.md'), 'utf8').split('\n')) {
    const match = line.match(/^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/)
    if (!match) continue
    // The in-call table (§7) lists paths relative to /api/calls/:roomId.
    const path = match[2]!.startsWith('/api/') ? match[2]! : `/api/calls/:roomId${match[2]}`
    routes.push({ method: match[1]!, path })
  }
  return routes
}

describe('route inventory', () => {
  const files = fileRoutes()
  const documented = documentedRoutes()

  it('finds the documented routes', () => {
    expect(documented.length).toBeGreaterThan(70)
    expect(new Set(documented.map(shape)).size).toBe(documented.length)
  })

  it('has a handler file for every route in docs/API.md', () => {
    const existing = new Set(files.map(shape))
    expect(documented.filter((route) => !existing.has(shape(route))).map(shape)).toEqual([])
  })

  it('documents every handler file in docs/API.md', () => {
    const known = new Set(documented.map(shape))
    expect(files.filter((route) => !known.has(shape(route))).map((route) => route.file)).toEqual([])
  })
})
