import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { signMetaPayload } from '@sc/channels';
import { createWorkerDatabase, type WorkerDatabase } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INBOUND_QUEUE, WEBHOOK_DB, buildWebhooksModule } from '../src/webhooks/webhooks.module';
import { testConfig } from './helpers';

let db: TestDatabase;
let workerDb: WorkerDatabase;
let app: NestFastifyApplication;
const queued: string[] = [];
const queue = { down: false };

const SECRET = 'test-app-secret';
const payload = (mid: string, text = 'hello') => ({
  object: 'page',
  entry: [{ id: '1001', time: 1, messaging: [{ sender: { id: '2002' }, recipient: { id: '1001' }, timestamp: 1, message: { mid, text } }] }],
});
const post = (body: unknown, signature?: string | null) => {
  const raw = JSON.stringify(body);
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    payload: raw,
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-hub-signature-256': signature ?? signMetaPayload(raw, SECRET) }),
    },
  });
};
const stored = async () => (await db.owner.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n as number;

beforeAll(async () => {
  db = await createTestDatabase();
  workerDb = createWorkerDatabase(db.urls.worker, { max: 3 });
  const mod = await Test.createTestingModule({ imports: [buildWebhooksModule(testConfig(db.urls))] })
    .overrideProvider(WEBHOOK_DB)
    .useValue(workerDb)
    .overrideProvider(INBOUND_QUEUE)
    .useValue({
      enqueue: async (j: { webhookEventId: string }) => {
        if (queue.down) throw new Error('redis is down');
        queued.push(j.webhookEventId);
      },
    })
    .compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await db?.stop();
});

describe('GET /webhooks/meta (handshake)', () => {
  const get = (q: string) => app.inject({ method: 'GET', url: `/webhooks/meta?${q}` });

  it('echoes hub.challenge for the right verify token', async () => {
    const res = await get('hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('12345');
  });

  it('refuses a wrong token, a wrong mode and a missing challenge', async () => {
    expect((await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).statusCode).toBe(403);
    expect((await get('hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=1')).statusCode).toBe(403);
    expect((await get('hub.mode=subscribe&hub.verify_token=test-verify-token')).statusCode).toBe(403);
  });
});

describe('POST /webhooks/meta', () => {
  it('rejects a bad or missing signature with 403 and stores nothing', async () => {
    const before = await stored();
    expect((await post(payload('m_bad'), 'sha256=' + '0'.repeat(64))).statusCode).toBe(403);
    expect((await post(payload('m_bad'), null)).statusCode).toBe(403);
    expect((await post(payload('m_bad'), signMetaPayload('{"other":1}', SECRET))).statusCode).toBe(403);
    expect(await stored()).toBe(before);
  });

  it('stores a signed event, enqueues it by id, and answers 200', async () => {
    const res = await post(payload('m_ok_1'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('EVENT_RECEIVED');
    const { rows } = await db.owner.query(`SELECT id::text, status, signature_valid, payload->'item'->'message'->>'mid' AS mid, payload->>'pageId' AS page FROM webhook_events WHERE event_key LIKE '%m_ok_1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'received', signature_valid: true, mid: 'm_ok_1', page: '1001' });
    expect(queued).toContain(rows[0].id);
  });

  it('stores a redelivered event once', async () => {
    const before = await stored();
    await post(payload('m_dup'));
    await post(payload('m_dup'));
    expect(await stored()).toBe(before + 1);
  });

  it('splits a batch into one stored event per message', async () => {
    const before = await stored();
    const batch = {
      object: 'page',
      entry: [{ id: '1001', time: 1, messaging: [
        { sender: { id: '2002' }, recipient: { id: '1001' }, timestamp: 1, message: { mid: 'm_b1', text: 'a' } },
        { sender: { id: '2002' }, recipient: { id: '1001' }, timestamp: 2, message: { mid: 'm_b2', text: 'b' } },
      ] }],
    };
    expect((await post(batch)).statusCode).toBe(200);
    expect(await stored()).toBe(before + 2);
  });

  it('still stores and answers 200 when the queue (Redis) is down', async () => {
    queue.down = true;
    const before = await stored();
    const res = await post(payload('m_redis_down'));
    queue.down = false;
    expect(res.statusCode).toBe(200);
    expect(await stored()).toBe(before + 1);
    const stuck = await workerDb.system.stuckWebhookEventIds(0);
    expect(stuck.length).toBeGreaterThan(0); // the sweeper will find and enqueue it
  });

  it('ignores payloads that are not Page events, but still answers 200', async () => {
    const before = await stored();
    expect((await post({ object: 'instagram', entry: [] })).statusCode).toBe(200);
    expect(await stored()).toBe(before);
  });

  it('answers quickly: p95 under 200 ms for 40 sequential events', async () => {
    // Warm up first (connection pool, JIT): a running server is never measured on its first requests.
    for (let i = 0; i < 10; i++) await post(payload(`m_warm_${i}`));
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await post(payload(`m_perf_${i}`));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)] ?? 0).toBeLessThan(200);
  });

});
