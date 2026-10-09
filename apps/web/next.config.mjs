import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  output: 'standalone',
  // Trace files from the monorepo root so the standalone bundle is self-contained.
  outputFileTracingRoot: path.join(here, '../..'),
};
