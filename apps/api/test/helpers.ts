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

import type { MetaGraph, MetaPage } from '../src/modules/channels/meta-graph';

/** A scripted stand-in for Meta's Graph API. Tests set the fields to simulate Facebook's answers. */
export class FakeGraph implements MetaGraph {
  identity: { id: string; name: string } | null = { id: '104500000000001', name: 'My Test Page' };
  rejectionReason = 'Invalid OAuth access token data.';
  userToken: string | null = 'LONG_LIVED_USER_TOKEN';
  pages: MetaPage[] | null = [];
  subscribeOk = true;
  readonly calls = { exchange: [] as { code: string; redirectUri: string }[], subscribed: [] as string[], unsubscribed: [] as string[] };

  getPageIdentity = async () => (this.identity ? { ok: true as const, ...this.identity } : { ok: false as const, reason: this.rejectionReason });
  exchangeCode = async (i: { code: string; redirectUri: string }) => {
    this.calls.exchange.push({ code: i.code, redirectUri: i.redirectUri });
    return this.userToken;
  };
  listPages = async () => this.pages;
  subscribePage = async (pageId: string) => {
    this.calls.subscribed.push(pageId);
    return this.subscribeOk;
  };
  unsubscribePage = async (pageId: string) => void this.calls.unsubscribed.push(pageId);
}
