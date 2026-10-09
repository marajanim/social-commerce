import { randomUUID } from 'node:crypto';
import { messengerEventKey, splitMessengerPayload } from '@sc/channels';
import { createOutboxPublisherDatabase, createWorkerDatabase, eventChannel, type WorkerDatabase } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import { createOutboundMessage } from '@sc/inbox';
import { startRedis, type TestRedis } from '@sc/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processWebhookEvent, type InboundDeps } from './inbound/processor';
import { startOutboxLoop } from './jobs/outbox-loop';
import { sweepOnce } from './jobs/sweeper';
import { processOutboundJob } from './outbound/processor';

let db: TestDatabase;
let workerDb: WorkerDatabase;
let redis: TestRedis;
let deps: InboundDeps;
const tenantId = randomUUID();
const userId = randomUUID();
const accountId = randomUUID();
const PAGE = '1001';
const OUR_APP = '777000';
const profileCalls: string[] = [];

const messaging = (item: Record<string, unknown>, page = PAGE) => ({
  object: 'page',
  entry: [{ id: page, time: 1, messaging: [{ sender: { id: '2002' }, recipient: { id: page }, timestamp: Date.now(), ...item }] }],
});

/** Stores a webhook payload the way the receiver does and returns the event ids. */
async function receive(payload: unknown): Promise<string[]> {
  const items = splitMessengerPayload(payload);
  const inserted = await workerDb.system.insertWebhookEvents(
    items.map((i) => ({ provider: 'messenger', eventKey: messengerEventKey(i), payload: i, signatureValid: true })),
  );
  return inserted.map((e) => e.id);
}
const run = async (payload: unknown) => {
  const ids = await receive(payload);
  const outcomes = [];
  for (const id of ids) outcomes.push(await processWebhookEvent(deps, id));
  return { ids, outcomes };
};
const q = (text: string, values?: unknown[]) => db.owner.query(text, values);

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await startRedis();
  workerDb = createWorkerDatabase(db.urls.worker, { max: 4 });
  deps = {
    db: workerDb,
    keyRing: null,
    ownAppId: OUR_APP,
    fetchProfile: async (_t, psid) => {
      profileCalls.push(psid);
      return { name: 'Karim Ahmed', picUrl: 'https://pics.example/k.jpg' };
    },
  };
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1,'T','t')`, [tenantId]);
  await q(`INSERT INTO users (id, email, name) VALUES ($1,'a@example.test','A')`, [userId]);
  const role = randomUUID();
  await q(`INSERT INTO roles (id, tenant_id, key, name) VALUES ($1,$2,'owner','Owner')`, [role, tenantId]);
  await q(`INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [tenantId, userId, role]);
  await q(`INSERT INTO channel_accounts (id, tenant_id, channel_key, external_id, display_name) VALUES ($1,$2,'messenger',$3,'My Page')`, [accountId, tenantId, PAGE]);
});
afterAll(async () => {
  await workerDb?.close();
  await redis?.stop();
  await db?.stop();
});

describe('inbound processing', () => {
  it('turns a stored webhook event into a conversation under the right tenant', async () => {
    const { outcomes, ids } = await run(messaging({ message: { mid: 'm_1', text: 'দাম কত?' } }));
    expect(outcomes).toEqual(['processed']);
    const conv = (await q(`SELECT c.tenant_id, c.last_message_preview, c.last_seq::int AS seq, ct.display_name
      FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.tenant_id = $1`, [tenantId])).rows[0];
    expect(conv).toMatchObject({ tenant_id: tenantId, last_message_preview: 'দাম কত?', seq: 1 });
    const ev = (await q(`SELECT status, tenant_id, channel_account_id FROM webhook_events WHERE id = $1`, [ids[0]])).rows[0];
    expect(ev).toMatchObject({ status: 'processed', tenant_id: tenantId, channel_account_id: accountId });
  });

  it('replaying the same webhook event stores one message', async () => {
    const payload = messaging({ message: { mid: 'm_replay', text: 'once' } });
    const [id] = await receive(payload);
    expect(await processWebhookEvent(deps, id as string)).toBe('processed');
    expect(await processWebhookEvent(deps, id as string)).toBe('skipped'); // already claimed and done
    expect(await receive(payload)).toEqual([]); // redelivery from Meta: same event key, nothing new stored
    const n = (await q(`SELECT count(*)::int AS n FROM messages WHERE body = 'once'`)).rows[0].n;
    expect(n).toBe(1);
  });

  it('quarantines an event for an unknown Page and never assigns it to a tenant', async () => {
    const { ids, outcomes } = await run(messaging({ message: { mid: 'm_unknown', text: 'lost' } }, '9999999'));
    expect(outcomes).toEqual(['quarantined']);
    const ev = (await q(`SELECT status, tenant_id FROM webhook_events WHERE id = $1`, [ids[0]])).rows[0];
    expect(ev).toEqual({ status: 'quarantined', tenant_id: null });
    expect((await q(`SELECT count(*)::int AS n FROM messages WHERE body = 'lost'`)).rows[0].n).toBe(0);
  });

  it('quarantines events for a disconnected channel', async () => {
    await q(`UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`, [accountId]);
    const { outcomes } = await run(messaging({ message: { mid: 'm_disc', text: 'x' } }));
    await q(`UPDATE channel_accounts SET status = 'connected' WHERE id = $1`, [accountId]);
    expect(outcomes).toEqual(['quarantined']);
  });

  it('ignores echoes of our own sends, but stores a reply typed in Business Suite as a human reply', async () => {
    const own = await run(messaging({ sender: { id: PAGE }, recipient: { id: '2002' }, message: { mid: 'm_echo_ours', text: 'ours', is_echo: true, app_id: Number(OUR_APP) } }));
    expect(own.outcomes).toEqual(['ignored']);
    const human = await run(messaging({ sender: { id: PAGE }, recipient: { id: '2002' }, message: { mid: 'm_echo_human', text: 'from Business Suite', is_echo: true, app_id: 263902037430900 } }));
    expect(human.outcomes).toEqual(['processed']);
    const rows = (await q(`SELECT body, direction, sender_type, payload->>'source' AS source FROM messages WHERE body IN ('ours','from Business Suite')`)).rows;
    expect(rows).toEqual([{ body: 'from Business Suite', direction: 'outbound', sender_type: 'system', source: 'external_app' }]);
  });

  it('looks up the customer profile once, for a new customer only', async () => {
    profileCalls.length = 0;
    // the key ring is what enables profile lookups, so use one for this test
    const { randomBytes } = await import('node:crypto');
    const { encryptSecret } = await import('@sc/shared/crypto');
    const ring = { keys: new Map([[1, randomBytes(32)]]), current: 1 };
    const enc = encryptSecret('PAGE_TOKEN', ring);
    await q(`INSERT INTO channel_credentials (tenant_id, channel_account_id, encrypted_token, key_version, token_type) VALUES ($1,$2,$3,1,'page')
             ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET encrypted_token = EXCLUDED.encrypted_token`, [tenantId, accountId, enc.ciphertext]);
    const withKey: InboundDeps = { ...deps, keyRing: ring };
    const first = await receive({ ...messaging({ message: { mid: 'm_p1', text: 'hi' } }), entry: [{ id: PAGE, time: 1, messaging: [{ sender: { id: '3003' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'm_p1', text: 'hi' } }] }] });
    await processWebhookEvent(withKey, first[0] as string);
    const second = await receive({ object: 'page', entry: [{ id: PAGE, time: 1, messaging: [{ sender: { id: '3003' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'm_p2', text: 'again' } }] }] });
    await processWebhookEvent(withKey, second[0] as string);
    expect(profileCalls).toEqual(['3003']);
    const name = (await q(`SELECT ct.display_name FROM contacts ct JOIN contact_identities i ON i.contact_id = ct.id WHERE i.external_user_id = '3003'`)).rows[0];
    expect(name.display_name).toBe('Karim Ahmed');
  });

  it.each(['echo', 'failed lookup'] as const)('recovers a missing profile after %s', async (cause) => {
    const { randomBytes } = await import('node:crypto');
    const { encryptSecret } = await import('@sc/shared/crypto');
    const ring = { keys: new Map([[1, randomBytes(32)]]), current: 1 };
    const enc = encryptSecret('PAGE_TOKEN', ring);
    await q(`UPDATE channel_credentials SET encrypted_token = $1 WHERE channel_account_id = $2`, [enc.ciphertext, accountId]);
    const psid = cause === 'echo' ? '4004' : '5005';
    let calls = 0;
    const withKey: InboundDeps = { ...deps, keyRing: ring, fetchProfile: async () => {
      calls++;
      return cause === 'failed lookup' && calls === 1 ? null : { name: 'Recovered Name', picUrl: null };
    } };
    const process = async (mid: string, echo = false) => {
      const ids = await receive(messaging({
        sender: { id: echo ? PAGE : psid }, recipient: { id: echo ? psid : PAGE },
        message: { mid, text: 'profile recovery', ...(echo ? { is_echo: true } : {}) },
      }));
      await processWebhookEvent(withKey, ids[0] as string);
    };
    await process(`m_${psid}_1`, cause === 'echo');
    expect((await q(`SELECT profile_name FROM contact_identities WHERE external_user_id = $1`, [psid])).rows[0].profile_name).toBeNull();
    // A teammate's custom name must survive enrichment.
    if (cause === 'echo') await q(`UPDATE contacts SET display_name = 'VIP customer' WHERE id = (SELECT contact_id FROM contact_identities WHERE external_user_id = $1)`, [psid]);
    await process(`m_${psid}_2`);
    await process(`m_${psid}_3`);
    const row = (await q(`SELECT i.profile_name, ct.display_name FROM contact_identities i JOIN contacts ct ON ct.id = i.contact_id WHERE i.external_user_id = $1`, [psid])).rows[0];
    expect(row.profile_name).toBe('Recovered Name');
    expect(row.display_name).toBe(cause === 'echo' ? 'VIP customer' : 'Recovered Name');
    expect(calls).toBe(cause === 'echo' ? 1 : 2);
  });

  it('applies delivery and read receipts to messages we sent', async () => {
    const inbound = await run(messaging({ message: { mid: 'm_r1', text: 'receipts' } }));
    expect(inbound.outcomes).toEqual(['processed']);
    const conv = (await q(`SELECT c.id FROM conversations c JOIN contact_identities i ON i.id = c.contact_identity_id WHERE i.external_user_id = '2002' AND c.status <> 'resolved'`)).rows[0].id as string;
    const out = await workerDb.tenantDb({ tenantId, userId }).transaction((tx) => createOutboundMessage(tx, { tenantId, userId, conversationId: conv, body: 'reply', idempotencyKey: randomUUID() }));
    await processOutboundJob({ db: workerDb, keyRing: null }, { tenantId, messageId: out.messageId }, { made: 0, max: 5 }).catch(() => undefined);
    // no key ring on this worker: the send fails to authenticate, so mark it sent by hand to test receipts
    await q(`UPDATE messages SET status = 'sent', sent_at = now() - interval '1 minute' WHERE id = $1`, [out.messageId]);
    const wm = Date.now();
    await run({ object: 'page', entry: [{ id: PAGE, time: 1, messaging: [{ sender: { id: '2002' }, recipient: { id: PAGE }, timestamp: wm, delivery: { mids: [], watermark: wm } }] }] });
    expect((await q(`SELECT status FROM messages WHERE id = $1`, [out.messageId])).rows[0].status).toBe('delivered');
    await run({ object: 'page', entry: [{ id: PAGE, time: 1, messaging: [{ sender: { id: '2002' }, recipient: { id: PAGE }, timestamp: wm + 1, read: { watermark: wm + 1 } }] }] });
    expect((await q(`SELECT status FROM messages WHERE id = $1`, [out.messageId])).rows[0].status).toBe('read');
  });

  it('marks an event failed when processing throws, and lets a retry finish it', async () => {
    const [id] = await receive(messaging({ message: { mid: 'm_flaky', text: 'flaky' } }));
    let boom = true;
    const flaky: InboundDeps = {
      ...deps,
      db: { ...workerDb, tenantDb: (ctx) => { if (boom) { boom = false; throw new Error('db hiccup'); } return workerDb.tenantDb(ctx); } },
    };
    await expect(processWebhookEvent(flaky, id as string)).rejects.toThrow('db hiccup');
    expect((await q(`SELECT status, attempts FROM webhook_events WHERE id = $1`, [id])).rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await processWebhookEvent(deps, id as string)).toBe('processed');
  });
});

describe('outbox to Redis', () => {
  it('publishes a committed event to the tenant channel within 1 second, and never a rolled-back one', async () => {
    const outbox = createOutboxPublisherDatabase(db.urls.outbox);
    const pub = new Redis(redis.url);
    const sub = new Redis(redis.url);
    const received: { type: string; at: number }[] = [];
    await sub.subscribe(eventChannel(tenantId));
    sub.on('message', (_c, m) => received.push({ type: JSON.parse(m).type, at: Date.now() }));
    const loop = startOutboxLoop({ publisher: outbox.publisher, redis: pub, intervalMs: 100 });
    try {
      const { writeOutbox } = await import('@sc/db');
      await expect(
        workerDb.tenantDb({ tenantId }).transaction(async (tx) => {
          await writeOutbox(tx, { tenantId, eventType: 'inbox.test.rolledback', aggregateType: 'x', aggregateId: randomUUID(), payload: {} });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      const t0 = Date.now();
      await workerDb.tenantDb({ tenantId }).transaction((tx) =>
        writeOutbox(tx, { tenantId, eventType: 'inbox.test.committed', aggregateType: 'x', aggregateId: randomUUID(), payload: {} }),
      );
      for (let i = 0; i < 40 && !received.some((r) => r.type === 'inbox.test.committed'); i++) await new Promise((r) => setTimeout(r, 50));
      const hit = received.find((r) => r.type === 'inbox.test.committed');
      expect(hit).toBeDefined();
      expect((hit?.at ?? Infinity) - t0).toBeLessThan(1000);
      expect(received.some((r) => r.type === 'inbox.test.rolledback')).toBe(false);
    } finally {
      await loop.stop();
      await sub.quit();
      await pub.quit();
      await outbox.close();
    }
  });

  it('delivers an ingested customer message to Redis subscribers', async () => {
    const outbox = createOutboxPublisherDatabase(db.urls.outbox);
    const pub = new Redis(redis.url);
    const sub = new Redis(redis.url);
    const seen: string[] = [];
    await sub.subscribe(eventChannel(tenantId));
    sub.on('message', (_c, m) => seen.push(JSON.parse(m).type));
    const loop = startOutboxLoop({ publisher: outbox.publisher, redis: pub, intervalMs: 100 });
    try {
      await run(messaging({ message: { mid: 'm_live', text: 'live' } }));
      for (let i = 0; i < 40 && !seen.includes('inbox.message.received'); i++) await new Promise((r) => setTimeout(r, 50));
      expect(seen).toContain('inbox.message.received');
    } finally {
      await loop.stop();
      await sub.quit();
      await pub.quit();
      await outbox.close();
    }
  });
});

describe('sweeper', () => {
  it('re-enqueues stored events and pending replies that no worker picked up', async () => {
    const [stuckId] = await receive(messaging({ message: { mid: 'm_stuck', text: 'stuck' } }));
    const inbound = await run(messaging({ message: { mid: 'm_for_reply', text: 'reply me' } }));
    expect(inbound.outcomes).toEqual(['processed']);
    const conv = (await q(`SELECT c.id FROM conversations c JOIN contact_identities i ON i.id = c.contact_identity_id WHERE i.external_user_id = '2002' AND c.status <> 'resolved'`)).rows[0].id as string;
    // A reply stored five minutes ago that nobody delivered.
    const stuckReply = randomUUID();
    await q(`UPDATE conversations SET last_seq = last_seq + 1 WHERE id = $1`, [conv]);
    await q(
      `INSERT INTO messages (id, tenant_id, conversation_id, seq, direction, sender_type, sender_user_id, content_type, body, status, created_at)
       SELECT $1, tenant_id, id, last_seq, 'outbound', 'user', $2, 'text', 'stuck reply', 'pending', now() - interval '5 minutes'
       FROM conversations WHERE id = $3`,
      [stuckReply, userId, conv],
    );
    await q(`UPDATE webhook_events SET received_at = now() - interval '5 minutes' WHERE id = $1`, [stuckId]);

    const added: { queue: string; data: unknown }[] = [];
    const sink = (queue: string) => ({ add: async (_n: string, data: unknown) => void added.push({ queue, data }) });
    const swept = await sweepOnce({ db: workerDb, inbound: sink('inbound'), outbound: sink('outbound') });
    expect(swept.webhookEvents).toBeGreaterThanOrEqual(1);
    expect(added).toContainEqual({ queue: 'inbound', data: { webhookEventId: stuckId } });
    expect(added).toContainEqual({ queue: 'outbound', data: { tenantId, messageId: stuckReply } });
  });
});

describe('worker role', () => {
  it('cannot read sessions or password hashes, and cannot see tenant rows without a tenant context', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: db.urls.worker });
    try {
      await expect(pool.query('SELECT * FROM auth.sessions')).rejects.toThrow(/permission denied/);
      await expect(pool.query('SELECT * FROM auth.user_credentials')).rejects.toThrow(/permission denied/);
      expect((await pool.query('SELECT count(*)::int AS n FROM conversations')).rows[0].n).toBe(0);
      await expect(pool.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
    } finally {
      await pool.end();
    }
  });

  it('the app role cannot call the system lookups or read raw webhook events', async () => {
    await expect(db.app.query(`SELECT * FROM sys.resolve_channel_account('messenger', '1001')`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT * FROM sys.due_work('outbound_pending', 10)`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query('SELECT * FROM webhook_events')).rejects.toThrow(/permission denied/);
  });
});
