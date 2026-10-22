import { defineConfig } from '@playwright/test'

/**
 * Single-machine load run (docs/PERFORMANCE.md §3.2): `tests/load/onbox.spec.ts` creates a room and an invite on the E2E
 * stack and runs the browser swarm (`tests/load/swarm.ts`) against it. Never part of `pnpm test:e2e` (its testDir is
 * tests/e2e). Run through scripts/e2e.sh (the Docker runner on macOS), which builds and starts the test build, the e2e
 * Caddy and the database:
 *
 *   SWARM_BOTS=12 SWARM_DURATION=120 sh scripts/e2e.sh --config tests/load/playwright.config.ts
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'onbox.spec.ts',
  outputDir: '../../test-results/load',
  workers: 1,
  retries: 0,
  timeout: 60 * 60_000,
  reporter: [['list']],
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080' },
})
