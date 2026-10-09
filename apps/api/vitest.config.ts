import { defineConfig } from 'vitest/config';

// Specs are compiled by tsc first (tsconfig.test.json) because esbuild drops the
// decorator metadata Nest DI needs. Vitest runs the emitted JS. Isolation tests start Postgres.
export default defineConfig({
  test: { include: ['dist-test/**/*.spec.js'], testTimeout: 120_000, hookTimeout: 120_000 },
});
