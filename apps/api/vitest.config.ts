import { defineConfig } from 'vitest/config';

// Specs are compiled by tsc first (tsconfig.test.json) because esbuild drops the
// decorator metadata Nest DI needs. Vitest runs the emitted JS.
export default defineConfig({ test: { include: ['dist-test/**/*.spec.js'] } });
