import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['smart_contracts/**/*.spec.ts'],
    testTimeout: 60000,
  },
})
