import { randomBytes } from 'node:crypto';
import { loadConfig, type Config } from '../src/config';

export const WEB_ORIGIN = 'http://localhost:3000';

/** A complete Config for tests, built through the real loader so defaults and validation match production. */
export function testConfig(
  urls: { app: string; auth: string; worker?: string },
  extra: Record<string, string> = {},
): Config {
  return loadConfig({
    NODE_ENV: 'test',
    APP_DATABASE_URL: urls.app,
    AUTH_DATABASE_URL: urls.auth,
    ...(urls.worker ? { WORKER_DATABASE_URL: urls.worker } : {}),
    REDIS_URL: 'redis://localhost:1',
    WEB_ORIGIN,
    COOKIE_SECURE: 'true',
    ENABLE_DEV_SIMULATOR: 'true',
    META_APP_ID: '777000',
    META_APP_SECRET: 'test-app-secret',
    META_VERIFY_TOKEN: 'test-verify-token',
    CHANNEL_KEY_V1: randomBytes(32).toString('base64'),
    ...extra,
  });
}
