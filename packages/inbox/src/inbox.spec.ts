import { randomUUID } from 'node:crypto';
import type { InboundMessageEvent, SendResult } from '@sc/channels';
import { schema } from '@sc/db';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStatusEvent, ingestInboundMessage } from './ingest';
import { createOutboundMessage, deliverOutboundMessage, SendBlockedError } from './outbound';

let db: TestDatabase;
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const userId = randomUUID();
const accountId = randomUUID();
const demoAccountId = randomUUID();
const account = { id: accountId, channelKey: 'messenger' };

const event = (over: Partial<InboundMessageEvent> = {}): InboundMessageEvent => ({
  kind: 'message',
  externalAccountId: 'PAGE1',
  externalUserId: 'PSID1',
  providerMessageId: `m_${randomUUID()}`,
  timestamp: new Date(),
  contentType: 'text',
  body: 'hello',
  attachments: [],
  isEcho: false,
  ...over,
});
const ingest = (e: InboundMessageEvent, acct = account) =>
  db.tenantDb({ tenantId, userId }).transaction((tx) => ingestInboundMessage(tx, { tenantId, account: acct, event: e }));

beforeAll(async () => {
  db = await createTestDatabase();
  const q = (t: string, v?: unknown[]) => db.owner.query(t, v);
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1,'T','t'), ($2,'U','u')`, [tenantId, otherTenantId]);
  await q(`INSERT INTO users (id, email, name) VALUES ($1,'agent@example.test','Agent')`, [userId]);
  const role = randomUUID();
  await q(`INSERT INTO roles (id, tenant_id, key, name) VALUES ($1,$2,'owner','Owner')`, [role, tenantId]);
  await q(`INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [tenantId, userId, role]);
  await q(`INSERT INTO channel_accounts (id, tenant_id, channel_key, external_id, display_name) VALUES ($1,$2,'messenger','PAGE1','My Page')`, [accountId, tenantId]);
  await q(`INSERT INTO channel_accounts (id, tenant_id, channel_key, external_id, display_name) VALUES ($1,$2,'webchat','demo','Demo site')`, [demoAccountId, tenantId]);
});
afterAll(() => db?.stop());

describe('ingestInboundMessage', () => {
  it('creates contact, identity and conversation for a new customer', async () => {
    const r = await ingest(event({ externalUserId: 'NEW1', body: 'Is this in stock?' }));
    expect(r).toMatchObject({ duplicate: false, newConversation: true, seq: 1n });
    const { rows } = await db.owner.query(
      `SELECT c.last_message_preview, c.status, c.window_expires_at IS NOT NULL AS has_window, i.external_user_id
       FROM conversations c JOIN contact_identities i ON i.id = c.contact_identity_id WHERE c.id = $1`,
      [r.conversationId],
    );
    expect(rows[0]).toMatchObject({ last_message_preview: 'Is this in stock?', status: 'open', has_window: true, external_user_id: 'NEW1' });
  });

  it('stores a replayed provider message once', async () => {
    const e = event({ externalUserId: 'DUP1' });
    const first = await ingest(e);
    const second = await ingest(e);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const { rows } = await db.owner.query('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [first.conversationId]);
    expect(rows[0].n).toBe(1);
  });

  it('gives 20 parallel messages in one conversation seq 1..20 with no gaps, and one contact', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => ingest(event({ externalUserId: 'RACE1', body: `m${i}` }))));
    expect(results.every((r) => !r.duplicate)).toBe(true);
    expect(results.filter((r) => r.newConversation)).toHaveLength(1);
    const seqs = results.map((r) => Number(r.seq)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const { rows } = await db.owner.query(
      `SELECT (SELECT count(*)::int FROM contact_identities WHERE external_user_id = 'RACE1') AS identities,
              (SELECT count(*)::int FROM conversations c JOIN contact_identities i ON i.id = c.contact_identity_id WHERE i.external_user_id = 'RACE1') AS conversations`,
    );
    expect(rows[0]).toEqual({ identities: 1, conversations: 1 });
  });

  it('reopens a conversation resolved within 30 days, and starts a new one after that', async () => {
    const first = await ingest(event({ externalUserId: 'REOPEN1' }));
    await db.owner.query(`UPDATE conversations SET status = 'resolved', resolved_at = now() - interval '5 days' WHERE id = $1`, [first.conversationId]);
    const again = await ingest(event({ externalUserId: 'REOPEN1' }));
    expect(again.conversationId).toBe(first.conversationId);
    expect(again.seq).toBe(2n);
    expect((await db.owner.query('SELECT status FROM conversations WHERE id = $1', [first.conversationId])).rows[0].status).toBe('open');

    await db.owner.query(`UPDATE conversations SET status = 'resolved', resolved_at = now() - interval '45 days' WHERE id = $1`, [first.conversationId]);
    const later = await ingest(event({ externalUserId: 'REOPEN1' }));
    expect(later.conversationId).not.toBe(first.conversationId);
    expect(later.newConversation).toBe(true);
  });

  it('stores an echo as an outbound message from outside the app and does not open the window', async () => {
    const first = await ingest(event({ externalUserId: 'ECHO1' }));
    const before = (await db.owner.query('SELECT last_inbound_at FROM conversations WHERE id = $1', [first.conversationId])).rows[0];
    const r = await ingest(event({ externalUserId: 'ECHO1', isEcho: true, body: 'Replied from Business Suite' }));
    expect(r.conversationId).toBe(first.conversationId);
    const msg = (await db.owner.query(`SELECT direction, sender_type, status, payload->>'source' AS source FROM messages WHERE conversation_id = $1 AND seq = 2`, [first.conversationId])).rows[0];
    expect(msg).toEqual({ direction: 'outbound', sender_type: 'system', status: 'sent', source: 'external_app' });
    const after = (await db.owner.query('SELECT last_inbound_at FROM conversations WHERE id = $1', [first.conversationId])).rows[0];
    expect(after.last_inbound_at).toEqual(before.last_inbound_at);
  });

  it('writes an outbox event with the message, in the same transaction', async () => {
    const r = await ingest(event({ externalUserId: 'OUTBOX1' }));
    const { rows } = await db.owner.query(`SELECT event_type, payload FROM outbox_events WHERE aggregate_id = $1`, [r.conversationId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('inbox.message.received');
    expect(rows[0].payload).toMatchObject({ conversationId: r.conversationId, messageId: r.messageId, seq: '1' });
  });

  it('keeps the same customer id on two channel accounts as two separate contacts', async () => {
    const a = await ingest(event({ externalUserId: 'SHARED' }));
    const b = await ingest(event({ externalUserId: 'SHARED' }), { id: demoAccountId, channelKey: 'webchat' });
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  it('is invisible to another tenant', async () => {
    const r = await ingest(event({ externalUserId: 'ISO1' }));
    const seen = await db.tenantDb({ tenantId: otherTenantId }).transaction((tx) => tx.select().from(schema.conversations).where(eq(schema.conversations.id, r.conversationId as string)));
    expect(seen).toHaveLength(0);
  });
});

describe('applyStatusEvent', () => {
  it('marks earlier outbound messages delivered and then read, and never moves status backwards', async () => {
    const inbound = await ingest(event({ externalUserId: 'STATUS1' }));
    const out = await db.tenantDb({ tenantId, userId }).transaction((tx) =>
      createOutboundMessage(tx, { tenantId, userId, conversationId: inbound.conversationId as string, body: 'hi', idempotencyKey: randomUUID() }),
    );
    const sentAt = new Date();
    await db.owner.query(`UPDATE messages SET status = 'sent', sent_at = $2 WHERE id = $1`, [out.messageId, sentAt]);
    const later = new Date(sentAt.getTime() + 1000);
    const apply = (status: 'delivered' | 'read', wm: Date) =>
      db.tenantDb({ tenantId, userId }).transaction((tx) =>
        applyStatusEvent(tx, { tenantId, accountId, externalUserId: 'STATUS1', status, watermark: wm }),
      );
    const status = async () => (await db.owner.query('SELECT status FROM messages WHERE id = $1', [out.messageId])).rows[0].status;

    expect(await apply('delivered', new Date(sentAt.getTime() - 5000))).toEqual([]); // watermark before the send
    expect(await apply('delivered', later)).toEqual([inbound.conversationId]);
    expect(await status()).toBe('delivered');
    await apply('read', later);
    expect(await status()).toBe('read');
    expect(await apply('delivered', later)).toEqual([]); // a late "delivered" after "read" is ignored
    expect(await status()).toBe('read');
  });
});

describe('createOutboundMessage', () => {
  const create = (conversationId: string, key: string, now?: Date) =>
    db.tenantDb({ tenantId, userId }).transaction((tx) =>
      createOutboundMessage(tx, { tenantId, userId, conversationId, body: 'Reply', idempotencyKey: key, now }),
    );

  it('stores a pending reply in the next seq and returns the first message for a repeated key', async () => {
    const inbound = await ingest(event({ externalUserId: 'OUT1' }));
    const conv = inbound.conversationId as string;
    const key = randomUUID();
    const [a, b] = await Promise.all([create(conv, key), create(conv, key)]);
    expect(a.messageId).toBe(b.messageId);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    const { rows } = await db.owner.query(`SELECT seq, status, sender_type FROM messages WHERE conversation_id = $1 AND direction = 'outbound'`, [conv]);
    expect(rows).toEqual([{ seq: '2', status: 'pending', sender_type: 'user' }]);
  });

  it('numbers two quick replies in order', async () => {
    const inbound = await ingest(event({ externalUserId: 'OUT2' }));
    const conv = inbound.conversationId as string;
    const one = await create(conv, randomUUID());
    const two = await create(conv, randomUUID());
    expect([one.seq, two.seq]).toEqual([2n, 3n]);
  });

  it('uses the HUMAN_AGENT tag after 24 hours and blocks after 7 days', async () => {
    const inbound = await ingest(event({ externalUserId: 'OUT3' }));
    const conv = inbound.conversationId as string;
    const in48h = new Date(Date.now() + 48 * 3_600_000);
    const tagged = await create(conv, randomUUID(), in48h);
    const row = (await db.owner.query('SELECT message_tag FROM messages WHERE id = $1', [tagged.messageId])).rows[0];
    expect(row.message_tag).toBe('HUMAN_AGENT');
    await expect(create(conv, randomUUID(), new Date(Date.now() + 8 * 24 * 3_600_000))).rejects.toBeInstanceOf(SendBlockedError);
  });

  it('refuses a conversation of another tenant', async () => {
    const inbound = await ingest(event({ externalUserId: 'OUT4' }));
    await expect(
      db.tenantDb({ tenantId: otherTenantId }).transaction((tx) =>
        createOutboundMessage(tx, { tenantId: otherTenantId, userId, conversationId: inbound.conversationId as string, body: 'x', idempotencyKey: randomUUID() }),
      ),
    ).rejects.toThrow(/not found/);
  });

  it('blocks a reply when the channel is disconnected', async () => {
    const inbound = await ingest(event({ externalUserId: 'OUT5' }));
    await db.owner.query(`UPDATE channel_accounts SET status = 'disconnected' WHERE id = $1`, [accountId]);
    await expect(create(inbound.conversationId as string, randomUUID())).rejects.toMatchObject({ reason: 'channel_unavailable' });
    await db.owner.query(`UPDATE channel_accounts SET status = 'connected' WHERE id = $1`, [accountId]);
  });
});

describe('deliverOutboundMessage', () => {
  const deps = (send: (k: string, r: unknown) => Promise<SendResult>) => ({
    tenantDb: (ctx: { tenantId: string }) => db.tenantDb({ ...ctx, userId }),
    decryptToken: () => 'PAGE_TOKEN',
    send: send as never,
  });
  async function pending(externalUserId: string) {
    const inbound = await ingest(event({ externalUserId }));
    const out = await db.tenantDb({ tenantId, userId }).transaction((tx) =>
      createOutboundMessage(tx, { tenantId, userId, conversationId: inbound.conversationId as string, body: 'Reply', idempotencyKey: randomUUID() }),
    );
    return out;
  }
  const row = async (id: string) => (await db.owner.query('SELECT status, provider_message_id, failure_code FROM messages WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    await db.owner.query(
      `INSERT INTO channel_credentials (tenant_id, channel_account_id, encrypted_token, key_version, token_type) VALUES ($1,$2,'\\x00',1,'page')`,
      [tenantId, accountId],
    );
  });

  it('sends, records the provider id and does nothing the second time', async () => {
    const out = await pending('DEL1');
    let calls = 0;
    const send = async (_k: string, r: unknown): Promise<SendResult> => {
      calls++;
      expect(r).toMatchObject({ token: 'PAGE_TOKEN', externalAccountId: 'PAGE1', recipientId: 'DEL1', body: 'Reply' });
      return { ok: true, providerMessageId: `m_out_${calls}` };
    };
    expect(await deliverOutboundMessage(deps(send), { tenantId, messageId: out.messageId, isLastAttempt: false })).toBe('sent');
    expect(await row(out.messageId)).toMatchObject({ status: 'sent', provider_message_id: 'm_out_1' });
    expect(await deliverOutboundMessage(deps(send), { tenantId, messageId: out.messageId, isLastAttempt: false })).toBe('skipped');
    expect(calls).toBe(1);
  });

  it('keeps a retryable failure pending, then fails it on the last attempt', async () => {
    const out = await pending('DEL2');
    const send = async (): Promise<SendResult> => ({ ok: false, kind: 'retryable', code: '4', reason: 'rate limit' });
    expect(await deliverOutboundMessage(deps(send), { tenantId, messageId: out.messageId, isLastAttempt: false })).toBe('retry');
    expect((await row(out.messageId)).status).toBe('pending');
    expect(await deliverOutboundMessage(deps(send), { tenantId, messageId: out.messageId, isLastAttempt: true })).toBe('failed');
    expect(await row(out.messageId)).toMatchObject({ status: 'failed', failure_code: '4' });
  });

  it('marks the channel as needing attention when the token is rejected', async () => {
    const out = await pending('DEL3');
    const send = async (): Promise<SendResult> => ({ ok: false, kind: 'auth', code: '190', reason: 'Invalid OAuth access token' });
    expect(await deliverOutboundMessage(deps(send), { tenantId, messageId: out.messageId, isLastAttempt: false })).toBe('failed');
    const acct = (await db.owner.query('SELECT status FROM channel_accounts WHERE id = $1', [accountId])).rows[0];
    expect(acct.status).toBe('needs_attention');
    await db.owner.query(`UPDATE channel_accounts SET status = 'connected' WHERE id = $1`, [accountId]);
  });

  it('re-checks the window just before sending', async () => {
    const out = await pending('DEL4');
    await db.owner.query(`UPDATE conversations SET last_inbound_at = now() - interval '9 days' WHERE id = $1`, [out.conversationId]);
    let called = false;
    const send = async (): Promise<SendResult> => {
      called = true;
      return { ok: true, providerMessageId: 'x' };
    };
    expect(await deliverOutboundMessage(deps(send), { tenantId, messageId: out.messageId, isLastAttempt: false })).toBe('failed');
    expect(called).toBe(false);
    expect((await row(out.messageId)).failure_code).toBe('window_closed');
  });

  it('delivers a website-chat reply without a stored token', async () => {
    const inbound = await ingest(event({ externalUserId: 'WEB1' }), { id: demoAccountId, channelKey: 'webchat' });
    const out = await db.tenantDb({ tenantId, userId }).transaction((tx) =>
      createOutboundMessage(tx, { tenantId, userId, conversationId: inbound.conversationId as string, body: 'Hi', idempotencyKey: randomUUID() }),
    );
    const outcome = await deliverOutboundMessage(
      { tenantDb: (ctx) => db.tenantDb({ ...ctx, userId }), decryptToken: () => '' },
      { tenantId, messageId: out.messageId, isLastAttempt: false },
    );
    expect(outcome).toBe('sent');
    expect((await row(out.messageId)).provider_message_id).toMatch(/^wc_/);
  });

  it('only sends what is pending and owned by its tenant', async () => {
    const out = await pending('DEL5');
    const outcome = await deliverOutboundMessage(
      { ...deps(async () => ({ ok: true, providerMessageId: 'z' })), tenantDb: (ctx) => db.tenantDb({ ...ctx, tenantId: otherTenantId }) },
      { tenantId: otherTenantId, messageId: out.messageId, isLastAttempt: false },
    );
    expect(outcome).toBe('skipped');
    expect((await row(out.messageId)).status).toBe('pending');
  });
});
