#!/usr/bin/env node
/**
 * Prepares a sub-agent's git worktree: frozen-lockfile install, per-agent database on the shared dev Postgres,
 * migrations, and a .env with the agent's own PORT and DATABASE_URL.
 *
 *   node scripts/worktree-setup.mjs <agent-name> <port>
 *
 * Requires the shared dev stack (`pnpm dev:deps`, run by the orchestrator). Never stops or recreates it.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const [agent, portArg] = process.argv.slice(2)
if (!agent || !portArg || !/^[a-z][a-z0-9-]{1,30}$/.test(agent) || !/^\d{4,5}$/.test(portArg)) {
  console.error('usage: node scripts/worktree-setup.mjs <agent-name> <port>   (e.g. auth 3001)')
  process.exit(2)
}

const port = Number(portArg)
const database = `blinq_${agent.replace(/-/g, '_')}`
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

// 1. Dependencies (pnpm store is shared, so this is fast).
run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])

// 2. Per-agent database on the shared dev Postgres container.
const psql = (sql) =>
  capture('docker', ['exec', 'blinq-dev-postgres-1', 'psql', '-U', 'blinq', '-d', 'postgres', '-tAc', sql])
try {
  if (psql(`SELECT 1 FROM pg_database WHERE datname = '${database}'`) !== '1') {
    psql(`CREATE DATABASE "${database}" OWNER blinq`)
  }
} catch {
  console.error('worktree-setup: the shared dev stack is not running. Ask the orchestrator to run `pnpm dev:deps`.')
  process.exit(1)
}

// 3. .env: start from the copy provided by .worktreeinclude (or the dev template) and override agent values.
if (!existsSync('.env')) copyFileSync('.env.dev.example', '.env')
const overrides = {
  PORT: String(port),
  PUBLIC_URL: `http://localhost:${port}`,
  DATABASE_URL: `postgres://blinq:blinq-dev@127.0.0.1:55432/${database}`,
}
const lines = readFileSync('.env', 'utf8')
  .split('\n')
  .filter((line) => !Object.keys(overrides).some((key) => line.startsWith(`${key}=`)))
writeFileSync(
  '.env',
  `${lines.join('\n').trimEnd()}\n\n# worktree-setup (${agent})\n${Object.entries(overrides)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
)

// 4. Migrations.
run('pnpm', ['cli', 'migrate'])

// 5. Vendored browser assets (MediaPipe, RNNoise), once media-fx provides the script.
if (existsSync('scripts/vendor-assets.mjs')) run('node', ['scripts/vendor-assets.mjs'])

console.log(`\nworktree ready: agent=${agent} port=${port} database=${database}`)
console.log(`start the app with: pnpm dev   (http://localhost:${port})`)
console.log('run E2E with:       sh scripts/e2e.sh --project=chromium tests/e2e/<area>   (the Docker runner on macOS)')
