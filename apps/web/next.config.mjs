import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  output: 'standalone',
  // Trace files from the monorepo root so the standalone bundle is self-contained.
  outputFileTracingRoot: path.join(here, '../..'),
  // Same-origin API: the browser talks to /api/*, Next forwards to the API process.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
};
