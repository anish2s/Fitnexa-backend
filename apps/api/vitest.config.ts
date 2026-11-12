import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['tests/helpers/global-setup.ts'],
    setupFiles: ['tests/helpers/setup-env.ts'],
    testTimeout: 20000,
    hookTimeout: 120000,
    // DB-backed suites share one server; run files sequentially to keep them independent.
    fileParallelism: false,
  },
});
