import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { addMember, createWorkspaceWithOwner } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import { hashPassword } from '@sc/shared/password';
import { startRedis, type TestRedis } from '@sc/testing';
import { Redis } from 'ioredis';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../src/modules/auth/session.service';
import { WorkspacesService } from '../src/modules/auth/workspaces.service';
import { buildRealtimeModule } from '../src/realtime/realtime.module';
import { attachRealtime } from '../src/realtime/realtime.server';
import { EMAIL_QUEUE } from '../src/queues/email-queue';
import { testConfig, WEB_ORIGIN } from './helpers';

let db: TestDatabase;
let redis: TestRedis;
let app: NestFastifyApplication;
let close: () => Promise<void>;
let url: string;
let publisher: Redis;
const tokens: Record<string, string> = {};
const tenants: Record<string, string> = {};
const sockets: Socket[] = [];

const open = (cookie?: string): Promise<{ socket: Socket; error?: string }> =>
  new Promise((resolve) => {
    const socket = connect(url, {
      transports: ['websocket'],
      extraHeaders: cookie ? { cookie } : {},
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    socket.on('connect', () => resolve({ socket }));
    socket.on('connect_error', (e) => resolve({ socket, error: e.message }));
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await startRedis();
  publisher = new Redis(redis.url);
  const passwordHash = await hashPassword('correct-horse-battery');
  const a = await createWorkspaceWithOwner(db.owner, { name: 'A', slug: 'a', owner: { email: 'a@example.test', name: 'A', passwordHash } });
  const b = await createWorkspaceWithOwner(db.owner, { name: 'B', slug: 'b', owner: { email: 'b@example.test', name: 'B', passwordHash } });
  await addMember(db.owner, a.tenantId, 'analyst', { email: 'analyst@example.test', name: 'N', passwordHash });
  tenants.a = a.tenantId;
  tenants.b = b.tenantId;

  const config = testConfig(db.urls, { REDIS_URL: redis.url });
  const mod = await Test.createTestingModule({ imports: [buildRealtimeModule(config)] })
    .overrideProvider(EMAIL_QUEUE)
    .useValue({ enqueue: async () => undefined })
    .compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const sessions = app.get(SessionService);
  for (const [name, userId, tenantId] of [
    ['a', a.userId, a.tenantId],
    ['b', b.userId, b.tenantId],
  ] as const) tokens[name] = (await sessions.create(userId, tenantId, {})).token;
  const analystId = (await db.owner.query<{ id: string }>(`SELECT id FROM users WHERE email = 'analyst@example.test'`)).rows[0]?.id as string;
  tokens.analyst = (await sessions.create(analystId, a.tenantId, {})).token;

  const realtime = await attachRealtime({
    httpServer: app.getHttpServer(),
    sessions,
    workspaces: app.get(WorkspacesService),
    redisUrl: redis.url,
    allowedOrigin: WEB_ORIGIN,
  });
  close = realtime.close;
  await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await close?.();
  await app?.close();
  await publisher?.quit();
  await redis?.stop();
  await db?.stop();
});

const event = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ id: '1', type, payload: {}, ...extra });

describe('realtime gateway', () => {
  it('refuses a connection with no session, a made-up session, or without inbox access', async () => {
    expect((await open()).error).toBe('unauthorized');
    expect((await open('sid=not-a-real-token')).error).toBe('unauthorized');
    expect((await open(`sid=${tokens.analyst}`)).error).toBe('unauthorized'); // analysts have no inbox.view
  });

  it('pushes a tenant’s event to that tenant’s clients only', async () => {
    const a = await open(`sid=${tokens.a}`);
    const b = await open(`sid=${tokens.b}`);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.socket.on('event', (e: { type: string }) => gotA.push(e.type));
    b.socket.on('event', (e: { type: string }) => gotB.push(e.type));

    const t0 = Date.now();
    await publisher.publish(`t:${tenants.a}:events`, event('inbox.message.received'));
    await publisher.publish(`t:${tenants.b}:events`, event('inbox.message.sent'));
    for (let i = 0; i < 40 && (gotA.length < 1 || gotB.length < 1); i++) await wait(25);
    expect(gotA).toEqual(['inbox.message.received']);
    expect(gotB).toEqual(['inbox.message.sent']);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('trusts the channel name, not the event body, for the tenant', async () => {
    const a = await open(`sid=${tokens.a}`);
    const got: string[] = [];
    a.socket.on('event', (e: { type: string }) => got.push(e.type));
    // tenant B's channel claiming to belong to tenant A in its body
    await publisher.publish(`t:${tenants.b}:events`, event('inbox.spoofed', { tenantId: tenants.a }));
    await wait(300);
    expect(got).not.toContain('inbox.spoofed');
  });

  it('survives a malformed message and keeps delivering', async () => {
    const a = await open(`sid=${tokens.a}`);
    const got: string[] = [];
    a.socket.on('event', (e: { type: string }) => got.push(e.type));
    await publisher.publish(`t:${tenants.a}:events`, '{not json');
    await publisher.publish(`t:${tenants.a}:events`, event('inbox.after.garbage'));
    for (let i = 0; i < 40 && got.length < 1; i++) await wait(25);
    expect(got).toEqual(['inbox.after.garbage']);
  });

  it('refuses a session that was signed out', async () => {
    const sessions = app.get(SessionService);
    const info = await sessions.validate(tokens.a as string);
    await sessions.revoke(info?.sessionId as Buffer);
    expect((await open(`sid=${tokens.a}`)).error).toBe('unauthorized');
  });
});
