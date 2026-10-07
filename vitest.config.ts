import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@server': resolve(__dirname, 'src/server'),
      '@web': resolve(__dirname, 'src/web')
    }
  },
  define: { __VESPER_TEST__: 'true' },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: 'forks'
  }
})
