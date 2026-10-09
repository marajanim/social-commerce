import { defineConfig } from 'vitest/config';

// Container start-up (image pull on a cold machine) is slow.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 120_000 } });
