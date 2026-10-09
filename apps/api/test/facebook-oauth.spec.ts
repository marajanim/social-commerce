import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { addMember, createWorkspaceWithOwner } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import type { ChannelAccountDto, ChannelSetupDto, MetaPendingPagesDto } from '@sc/shared';
import { hashPassword } from '@sc/shared/password';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { RateLimiter } from '../src/modules/auth/rate-limiter';
import { META_GRAPH } from '../src/modules/channels/meta-graph';
import { EMAIL_QUEUE } from '../src/queues/email-queue';
import { OUTBOUND_QUEUE } from '../src/queues/inbox-queues';
import { FakeGraph, WEB_ORIGIN, testConfig } from './helpers';

const PASSWORD = 'correct-horse-battery';
const graph = new FakeGraph();
let db: TestDatabase;
let app: NestFastifyApplication;
let ownerA: string;
let ownerB: string;
let agentA: string;

let ip = 0;
async function login(email: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD }, remoteAddress: `10.2.0.${++ip}` });
  return res.cookies.find((c) => c.name === 'sid')?.value ?? '';
}
const get = (url: string, sid?: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, cookies: { ...(sid ? { sid } : {}), ...extra } });
const post = (url: string, sid: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url, cookies: { sid }, payload: payload as Record<string, unknown> });

/** Runs the whole redirect dance: start, then the callback Facebook would send the browser to. */
async function loginWithFacebook(sid: string, query: (state: string) => string) {
  const start = await get('/channels/meta/start', sid);
  const state = start.cookies.find((c) => c.name === 'meta_oauth_state')?.value ?? '';
  const cb = await get(`/channels/meta/callback?${query(state)}`, sid, { meta_oauth_state: state });
  return { start, cb, state, dest: new URL(String(cb.headers.location), 'http://x') };
}

const page = (id: string, name: string) => ({ id, name, accessToken: `PAGE_TOKEN_${id}_secret-value` });
const count = async (sql: string, values: unknown[] = []) => (await db.owner.query(sql, values)).rows[0].n as number;

beforeAll(async () => {
  db = await createTestDatabase();
  const passwordHash = await hashPassword(PASSWORD);
  await createWorkspaceWithOwner(db.owner, { name: 'A', slug: 'a', owner: { email: 'a@example.test', name: 'A', passwordHash } });
  const b = await createWorkspaceWithOwner(db.owner, { name: 'B', slug: 'b', owner: { email: 'b@example.test', name: 'B', passwordHash } });
  const tenantA = (await db.owner.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'a'`)).rows[0]?.id as string;
  await addMember(db.owner, tenantA, 'agent', { email: 'agent@example.test', name: 'Agent', passwordHash });
  void b;

  const mod = await Test.createTestingModule({ imports: [buildAppModule(testConfig(db.urls))] })
    .overrideProvider(EMAIL_QUEUE).useValue({ enqueue: async () => undefined })
    .overrideProvider(OUTBOUND_QUEUE).useValue({ enqueue: async () => undefined })
    .overrideProvider(META_GRAPH).useValue(graph)
    .compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await setupApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  ownerA = await login('a@example.test');
  ownerB = await login('b@example.test');
  agentA = await login('agent@example.test');
});
afterAll(async () => {
  await app?.close();
  await db?.stop();
});
beforeEach(async () => {
  app.get(RateLimiter).reset();
  Object.assign(graph, { userToken: 'LONG_LIVED_USER_TOKEN', pages: [], subscribeOk: true });
  graph.calls.exchange.length = 0;
  graph.calls.subscribed.length = 0;
  graph.calls.unsubscribed.length = 0;
  await db.owner.query(`DELETE FROM channel_oauth_sessions`);
  await db.owner.query(`DELETE FROM channel_accounts WHERE channel_key = 'messenger'`);
});

describe('start', () => {
  it('reports that Facebook login is available and which redirect address to register', async () => {
    const setup = (await get('/channels/setup', ownerA)).json<ChannelSetupDto>();
    expect(setup.oauthConfigured).toBe(true);
    expect(setup.oauthRedirectUri).toBe(`${WEB_ORIGIN}/api/channels/meta/callback`);
  });

  it('sends the browser to Facebook with a one-time state that is also kept in an HttpOnly cookie', async () => {
    const res = await get('/channels/meta/start', ownerA);
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers.location));
    expect(url.hostname).toBe('www.facebook.com');
    expect(url.pathname).toMatch(/\/dialog\/oauth$/);
    expect(url.searchParams.get('client_id')).toBe('777000');
    expect(url.searchParams.get('redirect_uri')).toBe(`${WEB_ORIGIN}/api/channels/meta/callback`);
    expect(url.searchParams.get('scope')).toContain('pages_messaging');
    expect(url.searchParams.get('response_type')).toBe('code');
    const cookie = res.cookies.find((c) => c.name === 'meta_oauth_state');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    expect(cookie?.value).toBe(url.searchParams.get('state'));
    expect(url.toString()).not.toContain('test-app-secret');
  });

  it('uses a login configuration id instead of scopes when the app is Facebook Login for Business', async () => {
    const biz = await Test.createTestingModule({ imports: [buildAppModule(testConfig(db.urls, { META_LOGIN_CONFIG_ID: '1234567890' }))] })
      .overrideProvider(EMAIL_QUEUE).useValue({ enqueue: async () => undefined })
      .overrideProvider(OUTBOUND_QUEUE).useValue({ enqueue: async () => undefined })
      .overrideProvider(META_GRAPH).useValue(graph)
      .compile();
    const other = biz.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await setupApp(other);
    await other.init();
    await other.getHttpAdapter().getInstance().ready();
    const res = await other.inject({ method: 'GET', url: '/channels/meta/start', cookies: { sid: ownerA } });
    const url = new URL(String(res.headers.location));
    expect(url.searchParams.get('config_id')).toBe('1234567890');
    expect(url.searchParams.get('override_default_response_type')).toBe('true');
    expect(url.searchParams.has('scope')).toBe(false);
    await other.close();
  });

  it('is for people who can manage channels, and needs a session', async () => {
    expect((await get('/channels/meta/start', agentA)).statusCode).toBe(403);
    expect((await get('/channels/meta/start')).statusCode).toBe(401);
  });
});

describe('callback', () => {
  it('refuses a wrong or missing state, and talks to Facebook not at all', async () => {
    const start = await get('/channels/meta/start', ownerA);
    const real = start.cookies.find((c) => c.name === 'meta_oauth_state')?.value ?? '';
    for (const [query, cookie] of [
      ['code=abc&state=forged', real],
      ['code=abc', real],
      [`code=abc&state=${real}`, ''],
    ] as const) {
      const cb = await get(`/channels/meta/callback?${query}`, ownerA, cookie ? { meta_oauth_state: cookie } : {});
      expect(new URL(String(cb.headers.location)).searchParams.get('error')).toBe('state');
    }
    expect(graph.calls.exchange).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM channel_accounts WHERE channel_key = 'messenger'`)).toBe(0);
  });

  it('connects the only Page, stores its token encrypted, and subscribes it to the webhook', async () => {
    graph.pages = [page('104500000000001', 'Shop Page')];
    const { cb, dest } = await loginWithFacebook(ownerA, (s) => `code=abc123&state=${s}`);
    expect(cb.statusCode).toBe(302);
    expect(dest.origin).toBe(WEB_ORIGIN);
    expect(dest.pathname).toBe('/channels');
    const id = dest.searchParams.get('connected');
    expect(id).toBeTruthy();
    expect(graph.calls.exchange).toEqual([{ code: 'abc123', redirectUri: `${WEB_ORIGIN}/api/channels/meta/callback` }]);
    expect(graph.calls.subscribed).toEqual(['104500000000001']);
    const { rows } = await db.owner.query(
      `SELECT a.display_name, a.status, c.encrypted_token FROM channel_accounts a JOIN channel_credentials c ON c.channel_account_id = a.id WHERE a.id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ display_name: 'Shop Page', status: 'connected' });
    expect(Buffer.from(rows[0].encrypted_token).toString('utf8')).not.toContain('PAGE_TOKEN');
    expect(await count(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'channel.connected' AND target_id = $1`, [id])).toBe(1);
    // the state cookie is single use
    expect(cb.cookies.find((c) => c.name === 'meta_oauth_state')?.value ?? '').toBe('');
  });

  it('reports each way it can fail, without storing anything', async () => {
    const run = async () => (await loginWithFacebook(ownerA, (s) => `code=abc&state=${s}`)).dest.searchParams.get('error');
    graph.userToken = null;
    expect(await run()).toBe('exchange');
    graph.userToken = 'T';
    graph.pages = null;
    expect(await run()).toBe('exchange');
    graph.pages = [];
    expect(await run()).toBe('no_pages');
    const denied = await loginWithFacebook(ownerA, (s) => `error=access_denied&state=${s}`);
    expect(denied.dest.searchParams.get('error')).toBe('denied');
    expect(await count(`SELECT count(*)::int AS n FROM channel_accounts WHERE channel_key = 'messenger'`)).toBe(0);
  });

  it('flags the channel when Facebook refuses the webhook subscription', async () => {
    graph.pages = [page('104500000000002', 'Page Two')];
    graph.subscribeOk = false;
    const { dest } = await loginWithFacebook(ownerA, (s) => `code=abc&state=${s}`);
    expect(dest.searchParams.get('error')).toBe('subscribe');
    const { rows } = await db.owner.query(`SELECT status FROM channel_accounts WHERE external_id = '104500000000002'`);
    expect(rows[0].status).toBe('needs_attention');
  });

  it('says so when the Page already belongs to another workspace', async () => {
    graph.pages = [page('104500000000003', 'Shared Page')];
    expect((await loginWithFacebook(ownerB, (s) => `code=abc&state=${s}`)).dest.searchParams.get('connected')).toBeTruthy();
    expect((await loginWithFacebook(ownerA, (s) => `code=abc&state=${s}`)).dest.searchParams.get('error')).toBe('taken');
  });
});

describe('choosing among several Pages', () => {
  async function pick() {
    graph.pages = [page('104500000000011', 'First Page'), page('104500000000012', 'Second Page')];
    const { dest } = await loginWithFacebook(ownerA, (s) => `code=abc&state=${s}`);
    const id = dest.searchParams.get('pick');
    expect(id).toBeTruthy();
    return id as string;
  }

  it('lists the Pages by name only, then connects the chosen one', async () => {
    const id = await pick();
    const list = await get(`/channels/meta/pending/${id}`, ownerA);
    expect(list.json<MetaPendingPagesDto>().pages).toEqual([
      { id: '104500000000011', name: 'First Page' },
      { id: '104500000000012', name: 'Second Page' },
    ]);
    expect(list.body).not.toContain('PAGE_TOKEN');

    const res = await post(`/channels/meta/pending/${id}/connect`, ownerA, { pageId: '104500000000012' });
    expect(res.statusCode).toBe(201);
    expect(res.json<ChannelAccountDto>()).toMatchObject({ displayName: 'Second Page', status: 'connected', externalId: '104500000000012' });
    expect(graph.calls.subscribed).toEqual(['104500000000012']);
    // the stored list (with tokens) is deleted once used
    expect((await get(`/channels/meta/pending/${id}`, ownerA)).statusCode).toBe(404);
    expect(await count(`SELECT count(*)::int AS n FROM channel_oauth_sessions`)).toBe(0);
  });

  it('only offers Pages that are not connected yet', async () => {
    const id = await pick();
    await post(`/channels/meta/pending/${id}/connect`, ownerA, { pageId: '104500000000011' });
    const again = await pick();
    expect((await get(`/channels/meta/pending/${again}`, ownerA)).json<MetaPendingPagesDto>().pages.map((p) => p.id)).toEqual(['104500000000012']);
  });

  it('rejects a Page that was not in this Facebook login', async () => {
    const id = await pick();
    expect((await post(`/channels/meta/pending/${id}/connect`, ownerA, { pageId: '999999999999' })).statusCode).toBe(404);
  });

  it('is private to the person and workspace that started it, and expires', async () => {
    const id = await pick();
    expect((await get(`/channels/meta/pending/${id}`, ownerB)).statusCode).toBe(404);
    expect((await post(`/channels/meta/pending/${id}/connect`, ownerB, { pageId: '104500000000011' })).statusCode).toBe(404);
    expect((await get(`/channels/meta/pending/${id}`, agentA)).statusCode).toBe(403);
    await db.owner.query(`UPDATE channel_oauth_sessions SET expires_at = now() - interval '1 minute'`);
    expect((await get(`/channels/meta/pending/${id}`, ownerA)).statusCode).toBe(404);
  });

  it('stores the Page tokens encrypted while waiting', async () => {
    await pick();
    const { rows } = await db.owner.query(`SELECT pages::text AS pages FROM channel_oauth_sessions`);
    expect(rows[0].pages).not.toContain('PAGE_TOKEN');
  });

  it('returns 409 when the chosen Page was taken by another workspace meanwhile', async () => {
    const id = await pick();
    graph.pages = [page('104500000000012', 'Second Page')];
    await loginWithFacebook(ownerB, (s) => `code=abc&state=${s}`); // B connects it first
    expect((await post(`/channels/meta/pending/${id}/connect`, ownerA, { pageId: '104500000000012' })).statusCode).toBe(409);
  });
});

describe('disconnect', () => {
  it('stops Facebook sending events for the Page and deletes the token', async () => {
    graph.pages = [page('104500000000021', 'Going Away')];
    const id = (await loginWithFacebook(ownerA, (s) => `code=abc&state=${s}`)).dest.searchParams.get('connected');
    const res = await app.inject({ method: 'DELETE', url: `/channels/${id}`, cookies: { sid: ownerA } });
    expect(res.statusCode).toBe(204);
    expect(graph.calls.unsubscribed).toEqual(['104500000000021']);
    expect(await count(`SELECT count(*)::int AS n FROM channel_credentials WHERE channel_account_id = $1`, [id])).toBe(0);
  });
});
