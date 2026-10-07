import { defineConfig } from '@playwright/test'

/**
 * Two e2e projects over the BUILT app (npm run e2e builds first):
 *   electron — the desktop app via Playwright's _electron (tests/e2e/electron)
 *   browser  — out/main/server-node.js + headless Chromium (tests/e2e/browser)
 * One worker: every spec launches its own app/server on a random port and temp data dirs.
 */
export default defineConfig({
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  // Per-agent output dir (PW_OUT) so parallel worktree runs never wipe each other's artifacts.
  outputDir: process.env.PW_OUT ?? 'test-results/e2e',
  tsconfig: './tsconfig.e2e.json',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'electron', testDir: './tests/e2e/electron' },
    { name: 'browser', testDir: './tests/e2e/browser' }
  ]
})
