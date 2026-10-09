import { defineConfig } from 'vitest/config';

// Specs are compiled by tsc first (tsconfig.test.json) because esbuild drops the
// decorator metadata Nest DI needs. Vitest runs the emitted JS. Isolation tests start Postgres.
export default defineConfig({
  // Each spec file starts its own Postgres (and sometimes Redis) container: run a few at a time.
  test: { include: ['dist-test/**/*.spec.js'], testTimeout: 120_000, hookTimeout: 180_000, maxWorkers: 2, minWorkers: 1 },
});
