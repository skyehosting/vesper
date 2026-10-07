import { defineConfig } from '@playwright/test'

/**
 * Soak and leak gates (07 D14): long runs over the built app, opt-in via `npm run soak` (mandatory before Phase 5).
 * Specs live in tests/soak and use the same launchers as e2e (tests/e2e/launch.ts).
 */
export default defineConfig({
  testDir: './tests/soak',
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.PW_OUT ?? 'test-results/soak',
  tsconfig: './tsconfig.e2e.json'
})
