import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { addMember, createWorkspaceWithOwner } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import type {
  ChannelAccountDto,
  ChannelSetupDto,
  ConversationPage,
  ConversationSummary,
  MessagePage,
  MessageDto,
} from '@sc/shared';
import { hashPassword } from '@sc/shared/password';
import { expectCrossTenantNotFound, type TenantFixture } from '@sc/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { RateLimiter } from '../src/modules/auth/rate-limiter';
import { META_GRAPH } from '../src/modules/channels/meta-graph';
import { OUTBOUND_QUEUE } from '../src/queues/inbox-queues';
import { EMAIL_QUEUE } from '../src/queues/email-queue';
import { FakeGraph, testConfig } from './helpers';

const PASSWORD = 'correct-horse-battery';
const PAGE_ID = '104500000000001';
const PAGE_TOKEN = 'EAAB-page-access-token-for-tests-0001';

let db: TestDatabase;
let app: NestFastifyApplication;
let ownerA: string; // session cookies
let ownerB: string;
let agentA: string;
let tenantA: string;
let tenantB: string;
const queued: { tenantId: string; messageId: string }[] = [];
const graph = new FakeGraph();

let ip = 0;
async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
    remoteAddress: `10.1.0.${++ip}`,
  });
  expect(res.statusCode).toBe(200);
  return res.cookies.find((c) => c.name === 'sid')?.value ?? '';
}
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, sid: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, cookies: { sid }, payload: payload as Record<string, unknown>, headers });
const json = <T>(r: { json(): unknown }) => r.json() as T;
let keyN = 0;
const idem = () => `test-key-${Date.now()}-${++keyN}`;

async function simulate(sid: string, accountId: string, customerName: string, text: string): Promise<string> {
  const res = await call('POST', '/dev/simulate-message', sid, { channelAccountId: accountId, customerName, text });
  expect(res.statusCode).toBe(200);
  return json<{ conversationId: string }>(res).conversationId;
}

beforeAll(async () => {
  db = await createTestDatabase();
  const passwordHash = await hashPassword(PASSWORD);
  const a = await createWorkspaceWithOwner(db.owner, {
    name: 'Shop A',
    slug: 'shop-a',
    owner: { email: 'owner-a@example.test', name: 'Owner A', passwordHash },
  });
  const b = await createWorkspaceWithOwner(db.owner, {
    name: 'Shop B',
    slug: 'shop-b',
    owner: { email: 'owner-b@example.test', name: 'Owner B', passwordHash },
  });
  tenantA = a.tenantId;
  tenantB = b.tenantId;
  await addMember(db.owner, a.tenantId, 'analyst', { email: 'analyst@example.test', name: 'Analyst', passwordHash });
  await addMember(db.owner, a.tenantId, 'agent', { email: 'agent@example.test', name: 'Agent', passwordHash });

  const mod = await Test.createTestingModule({ imports: [buildAppModule(testConfig(db.urls))] })
    .overrideProvider(EMAIL_QUEUE)
    .useValue({ enqueue: async () => undefined })
    .overrideProvider(OUTBOUND_QUEUE)
    .useValue({ enqueue: async (j: { tenantId: string; messageId: string }) => void queued.push(j) })
    .overrideProvider(META_GRAPH)
    .useValue(graph)
    .compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await setupApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ownerA = await login('owner-a@example.test');
  ownerB = await login('owner-b@example.test');
  agentA = await login('agent@example.test');
});
afterAll(async () => {
  await app?.close();
  await db?.stop();
});
beforeEach(() => app.get(RateLimiter).reset());

describe('channels', () => {
  let messengerId: string;

  it('connects a Facebook Page after Facebook confirms the token, and stores the token encrypted', async () => {
    const res = await call('POST', '/channels/messenger', ownerA, { pageId: PAGE_ID, accessToken: PAGE_TOKEN });
    expect(res.statusCode).toBe(201);
    const dto = json<ChannelAccountDto>(res);
    expect(dto).toMatchObject({ channelKey: 'messenger', externalId: PAGE_ID, displayName: 'My Test Page', status: 'connected' });
    messengerId = dto.id;
    const { rows } = await db.owner.query(`SELECT encrypted_token, key_version FROM channel_credentials WHERE channel_account_id = $1`, [dto.id]);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].encrypted_token).toString('utf8')).not.toContain(PAGE_TOKEN);
    expect(rows[0].key_version).toBe(1);
    const audit = await db.owner.query(`SELECT action FROM audit_logs WHERE target_id = $1`, [dto.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['channel.connected']);
  });

  it('never returns the token', async () => {
    const list = await call('GET', '/channels', ownerA);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(PAGE_TOKEN);
    expect(json<ChannelAccountDto[]>(list).map((c) => c.id)).toContain(messengerId);
  });

  it('rejects a token Facebook does not accept and a token for a different Page', async () => {
    graph.identity = null;
    graph.rejectionReason = 'Error validating access token: Session has expired';
    const refused = await call('POST', '/channels/messenger', ownerA, { pageId: '999000111222', accessToken: PAGE_TOKEN });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain('Session has expired'); // Facebook's own reason is passed on
    expect(refused.body).not.toContain(PAGE_TOKEN);
    graph.identity = { id: '555000111222', name: 'Other' };
    expect((await call('POST', '/channels/messenger', ownerA, { pageId: '999000111222', accessToken: PAGE_TOKEN })).statusCode).toBe(400);
    graph.identity = { id: PAGE_ID, name: 'My Test Page' };
  });

  it('refuses the same Page in a second workspace with 409', async () => {
    const res = await call('POST', '/channels/messenger', ownerB, { pageId: PAGE_ID, accessToken: PAGE_TOKEN });
    expect(res.statusCode).toBe(409);
  });

  it('only people who may manage channels can connect one, and the list is per workspace', async () => {
    expect((await call('POST', '/channels/messenger', agentA, { pageId: '123456789', accessToken: PAGE_TOKEN })).statusCode).toBe(403);
    expect((await call('GET', '/channels', agentA)).statusCode).toBe(200); // channels.view
    expect(json<ChannelAccountDto[]>(await call('GET', '/channels', ownerB))).toEqual([]);
  });

  it('validates the body', async () => {
    expect((await call('POST', '/channels/messenger', ownerA, { pageId: 'abc', accessToken: 'short' })).statusCode).toBe(400);
  });

  it('exposes the webhook setup values to channel managers only', async () => {
    const res = await call('GET', '/channels/setup', ownerA);
    expect(json<ChannelSetupDto>(res)).toMatchObject({ verifyToken: 'test-verify-token', simulatorEnabled: true, encryptionConfigured: true });
    expect((await call('GET', '/channels/setup', agentA)).statusCode).toBe(403);
  });

  it('creates the demo website channel once', async () => {
    const one = json<ChannelAccountDto>(await call('POST', '/channels/demo', ownerA));
    const two = json<ChannelAccountDto>(await call('POST', '/channels/demo', ownerA));
    expect(one.channelKey).toBe('webchat');
    expect(two.id).toBe(one.id);
  });

  it('disconnects a channel, drops its token, and 404s for another workspace', async () => {
    expect((await call('DELETE', `/channels/${messengerId}`, ownerB)).statusCode).toBe(404);
    expect((await call('DELETE', `/channels/${messengerId}`, ownerA)).statusCode).toBe(204);
    const { rows } = await db.owner.query(`SELECT count(*)::int AS n FROM channel_credentials WHERE channel_account_id = $1`, [messengerId]);
    expect(rows[0].n).toBe(0);
    const list = json<ChannelAccountDto[]>(await call('GET', '/channels', ownerA));
    expect(list.find((c) => c.id === messengerId)?.status).toBe('disconnected');
  });
});

describe('inbox', () => {
  let demo: string;
  let conv: string;

  beforeAll(async () => {
    demo = json<ChannelAccountDto>(await call('POST', '/channels/demo', ownerA)).id;
    conv = await simulate(ownerA, demo, 'Rahim Uddin', 'দাম কত?');
  });

  it('shows a new customer message in the list with an unread badge', async () => {
    const page = json<ConversationPage>(await call('GET', '/conversations', ownerA));
    const item = page.items.find((c) => c.id === conv) as ConversationSummary;
    expect(item).toMatchObject({
      status: 'open',
      contact: { name: 'Rahim Uddin' },
      channel: { key: 'webchat' },
      preview: 'দাম কত?',
      unreadCount: 1,
    });
  });

  it('returns the thread with the customer message', async () => {
    const thread = json<MessagePage>(await call('GET', `/conversations/${conv}/messages`, ownerA));
    expect(thread.items).toHaveLength(1);
    expect(thread.items[0]).toMatchObject({ direction: 'inbound', senderType: 'customer', body: 'দাম কত?', seq: '1', status: 'received' });
    expect(thread.olderCursor).toBeNull();
  });

  it('marks the conversation read for this user only', async () => {
    expect((await call('POST', `/conversations/${conv}/read`, agentA)).statusCode).toBe(200);
    const agentView = json<ConversationPage>(await call('GET', '/conversations?unread=true', agentA));
    expect(agentView.items.find((c) => c.id === conv)).toBeUndefined();
    const ownerView = json<ConversationPage>(await call('GET', '/conversations?unread=true', ownerA));
    expect(ownerView.items.find((c) => c.id === conv)?.unreadCount).toBe(1);
    await call('POST', `/conversations/${conv}/read`, ownerA);
    expect(json<ConversationPage>(await call('GET', '/conversations?unread=true', ownerA)).items.find((c) => c.id === conv)).toBeUndefined();
  });

  it('sends a reply: stored as pending, queued once, and a repeated key is a no-op', async () => {
    const key = idem();
    const before = queued.length;
    const first = await call('POST', `/conversations/${conv}/messages`, ownerA, { body: 'জি, ৫০০ টাকা' }, { 'idempotency-key': key });
    expect(first.statusCode).toBe(202);
    const msg = json<MessageDto>(first);
    expect(msg).toMatchObject({ direction: 'outbound', senderType: 'user', status: 'pending', body: 'জি, ৫০০ টাকা', seq: '2' });
    const again = await call('POST', `/conversations/${conv}/messages`, ownerA, { body: 'জি, ৫০০ টাকা' }, { 'idempotency-key': key });
    expect(json<MessageDto>(again).id).toBe(msg.id);
    expect(queued.slice(before)).toEqual([{ tenantId: tenantA, messageId: msg.id }]);
    const thread = json<MessagePage>(await call('GET', `/conversations/${conv}/messages`, ownerA));
    expect(thread.items.map((m) => m.seq)).toEqual(['1', '2']);
  });

  it('requires an Idempotency-Key, a body, and the reply permission', async () => {
    expect((await call('POST', `/conversations/${conv}/messages`, ownerA, { body: 'x' })).statusCode).toBe(400);
    expect((await call('POST', `/conversations/${conv}/messages`, ownerA, { body: '   ' }, { 'idempotency-key': idem() })).statusCode).toBe(400);
    const analyst = await login('analyst@example.test');
    expect((await call('GET', '/conversations', analyst)).statusCode).toBe(403); // analysts have no inbox access
    expect((await call('POST', `/conversations/${conv}/messages`, analyst, { body: 'x' }, { 'idempotency-key': idem() })).statusCode).toBe(403);
  });

  it('reports send eligibility and refuses a reply outside every window', async () => {
    const e = await call('GET', `/conversations/${conv}/send-eligibility`, ownerA);
    expect(json(e)).toMatchObject({ allowed: true, messageTag: null });

    const old = await simulate(ownerA, demo, 'Old Customer', 'hello');
    await db.owner.query(`UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`, [demo]);
    const blocked = await call('POST', `/conversations/${old}/messages`, ownerA, { body: 'hi' }, { 'idempotency-key': idem() });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'channel_unavailable' });
    expect(json(await call('GET', `/conversations/${old}/send-eligibility`, ownerA))).toMatchObject({ allowed: false, reason: 'channel_unavailable' });
    await db.owner.query(`UPDATE channel_accounts SET status = 'connected' WHERE id = $1`, [demo]);
  });

  it('pages the list by cursor without gaps or repeats, newest first', async () => {
    for (let i = 0; i < 34; i++) await simulate(ownerA, demo, `Customer ${String(i).padStart(2, '0')}`, `message ${i}`);
    const first = json<ConversationPage>(await call('GET', '/conversations?limit=20', ownerA));
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = json<ConversationPage>(await call('GET', `/conversations?limit=20&cursor=${first.nextCursor}`, ownerA));
    const third = second.nextCursor
      ? json<ConversationPage>(await call('GET', `/conversations?limit=20&cursor=${second.nextCursor}`, ownerA))
      : { items: [], nextCursor: null };
    const ids = [...first.items, ...second.items, ...third.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(36);
    const times = [...first.items, ...second.items].map((c) => c.lastMessageAt as string);
    expect([...times].sort().reverse()).toEqual(times);
    expect(first.items[0]?.contact.name).toBe('Customer 33');
  });

  it('filters by name search and channel, and rejects a bad cursor', async () => {
    const hit = json<ConversationPage>(await call('GET', '/conversations?q=rahim', ownerA));
    expect(hit.items.map((c) => c.contact.name)).toEqual(['Rahim Uddin']);
    const byChannel = json<ConversationPage>(await call('GET', `/conversations?channelAccountId=${demo}&limit=100`, ownerA));
    expect(byChannel.items.every((c) => c.channel.accountId === demo)).toBe(true);
    expect((await call('GET', '/conversations?cursor=garbage', ownerA)).statusCode).toBe(400);
  });

  it('pages a long thread backwards', async () => {
    const long = await simulate(ownerA, demo, 'Chatty', 'm1');
    for (let i = 2; i <= 12; i++) await simulate(ownerA, demo, 'Chatty', `m${i}`);
    const latest = json<MessagePage>(await call('GET', `/conversations/${long}/messages?limit=5`, ownerA));
    expect(latest.items.map((m) => m.body)).toEqual(['m8', 'm9', 'm10', 'm11', 'm12']);
    const older = json<MessagePage>(await call('GET', `/conversations/${long}/messages?limit=5&beforeSeq=${latest.olderCursor}`, ownerA));
    expect(older.items.map((m) => m.body)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('turns the dev simulator off when it is disabled', async () => {
    const off = await Test.createTestingModule({ imports: [buildAppModule(testConfig(db.urls, { ENABLE_DEV_SIMULATOR: 'false' }))] })
      .overrideProvider(EMAIL_QUEUE).useValue({ enqueue: async () => undefined })
      .overrideProvider(OUTBOUND_QUEUE).useValue({ enqueue: async () => undefined })
      .compile();
    const other = off.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await setupApp(other);
    await other.init();
    await other.getHttpAdapter().getInstance().ready();
    const res = await other.inject({ method: 'POST', url: '/dev/simulate-message', cookies: { sid: ownerA }, payload: { channelAccountId: demo, customerName: 'x', text: 'y' } });
    expect(res.statusCode).toBe(404);
    await other.close();
  });
});

describe('tenant isolation', () => {
  it('another workspace gets 404 on a conversation, its thread, eligibility, read and reply', async () => {
    const demoA = json<ChannelAccountDto>(await call('POST', '/channels/demo', ownerA)).id;
    const demoB = json<ChannelAccountDto>(await call('POST', '/channels/demo', ownerB)).id;
    const convA = await simulate(ownerA, demoA, 'Isolation A', 'a');
    const convB = await simulate(ownerB, demoB, 'Isolation B', 'b');

    // The harness addresses resources through TenantFixture.teamId; here that field carries the conversation id.
    const fx = {
      a: { tenantId: tenantA, userId: '', roleId: '', teamId: convA } satisfies TenantFixture,
      b: { tenantId: tenantB, userId: '', roleId: '', teamId: convB } satisfies TenantFixture,
    };
    const cookies = new Map([[tenantA, ownerA], [tenantB, ownerB]]);
    const authAs = (t: TenantFixture) => ({ cookie: `sid=${cookies.get(t.tenantId)}` });

    for (const suffix of ['', '/messages', '/send-eligibility']) {
      await expectCrossTenantNotFound(app, fx, { method: 'GET', url: (t) => `/conversations/${t.teamId}${suffix}`, authAs });
    }
    await expectCrossTenantNotFound(app, fx, { method: 'POST', url: (t) => `/conversations/${t.teamId}/read`, authAs, payload: {} });
    await expectCrossTenantNotFound(app, fx, {
      method: 'POST',
      url: (t) => `/conversations/${t.teamId}/messages`,
      authAs: (t) => ({ ...authAs(t), 'idempotency-key': idem() }),
      payload: { body: 'hello' },
    });
    // Lists never mix workspaces either.
    const listA = json<ConversationPage>(await call('GET', '/conversations?limit=100', ownerA));
    expect(listA.items.some((c) => c.id === convB)).toBe(false);
    const listB = json<ConversationPage>(await call('GET', '/conversations?limit=100', ownerB));
    expect(listB.items.map((c) => c.id)).toEqual([convB]);
  });
});
