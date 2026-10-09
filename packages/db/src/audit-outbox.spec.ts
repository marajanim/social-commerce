import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuditChainerDatabase, createOutboxPublisherDatabase } from './client';
import { writeAudit } from './audit';
import { writeOutbox } from './outbox';
import { createTestDatabase, type TestDatabase } from './test-support';

let db: TestDatabase;
let chain: ReturnType<typeof createAuditChainerDatabase>;
let outbox: ReturnType<typeof createOutboxPublisherDatabase>;

const tenant = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
const user = randomUUID();

const audit = (tenantId: string, action: string, extra: Record<string, unknown> = {}) =>
  db.tenantDb({ tenantId }).transaction((tx) =>
    writeAudit(tx, {
      tenantId,
      actorType: 'user',
      actorId: user,
      action,
      targetType: 'thing',
      targetId: randomUUID(),
      after: { note: action, ...extra },
      ip: '203.0.113.7',
      userAgent: 'vitest',
      correlationId: `corr-${action}`,
    }),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  chain = createAuditChainerDatabase(db.urls.audit);
  outbox = createOutboxPublisherDatabase(db.urls.outbox);
  for (const [slug, id] of Object.entries(tenant)) {
    await db.owner.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2::text, $2::text)`, [id, `t-${slug}`]);
  }
});
afterAll(async () => {
  await chain?.close();
  await outbox?.close();
  await db?.stop();
});

describe('audit log', () => {
  it('is written without a hash, in the caller’s transaction', async () => {
    await audit(tenant.a, 'unhashed.first');
    const { rows } = await db.owner.query(
      `SELECT hash, prev_hash, chained_at, correlation_id, host(ip) AS ip FROM audit_logs WHERE action = 'unhashed.first'`,
    );
    expect(rows).toEqual([{ hash: null, prev_hash: null, chained_at: null, correlation_id: 'corr-unhashed.first', ip: '203.0.113.7' }]);
  });

  it('does not exist when the surrounding transaction rolls back', async () => {
    await expect(
      db.tenantDb({ tenantId: tenant.a }).transaction(async (tx) => {
        await writeAudit(tx, { tenantId: tenant.a, actorType: 'system', action: 'rolled.back', targetType: 'x' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rowCount } = await db.owner.query(`SELECT 1 FROM audit_logs WHERE action = 'rolled.back'`);
    expect(rowCount).toBe(0);
  });

  it('refuses a row claiming another tenant', async () => {
    await expect(
      db.tenantDb({ tenantId: tenant.a }).transaction((tx) =>
        writeAudit(tx, { tenantId: tenant.b, actorType: 'user', action: 'cross.tenant', targetType: 'x' }),
      ),
    ).rejects.toThrow();
  });
});

describe('audit chaining', () => {
  it('leaves rows younger than minAge alone, so in-flight transactions can commit first', async () => {
    await audit(tenant.b, 'fresh');
    expect(await chain.chainer.chainOnce({ minAgeMs: 60_000 })).toBe(0);
  });

  it('chains each tenant independently and verification passes', async () => {
    await audit(tenant.a, 'a.2');
    await audit(tenant.a, 'a.3');
    await audit(tenant.b, 'b.2');
    const n = await chain.chainer.chainOnce({ minAgeMs: 0 });
    expect(n).toBeGreaterThanOrEqual(5);

    const rows = await db.owner.query<{ tenant_id: string; action: string; prev_hash: Buffer | null; hash: Buffer }>(
      `SELECT tenant_id::text, action, prev_hash, hash FROM audit_logs WHERE tenant_id = ANY($1) AND chained_at IS NOT NULL
       ORDER BY chained_at, created_at, id`,
      [[tenant.a, tenant.b]],
    );
    const firstOf = (t: string) => rows.rows.find((r) => r.tenant_id === t);
    expect(firstOf(tenant.a)?.prev_hash).toBeNull();
    expect(firstOf(tenant.b)?.prev_hash).toBeNull(); // not linked to tenant A's chain
    const a = rows.rows.filter((r) => r.tenant_id === tenant.a);
    for (let i = 1; i < a.length; i++) expect(a[i]?.prev_hash?.equals(a[i - 1]?.hash ?? Buffer.alloc(0))).toBe(true);

    expect(await chain.chainer.verify(tenant.a)).toMatchObject({ ok: true });
    expect(await chain.chainer.verify(tenant.b)).toMatchObject({ ok: true });
  });

  it('is idempotent and continues the chain with later rows', async () => {
    expect(await chain.chainer.chainOnce({ minAgeMs: 0 })).toBe(0);
    await audit(tenant.a, 'a.late');
    expect(await chain.chainer.chainOnce({ minAgeMs: 0 })).toBe(1);
    const verdict = await chain.chainer.verify(tenant.a);
    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toBeGreaterThanOrEqual(4);
  });

  it('chains 25 concurrent writes into one valid chain', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit(tenant.c, `c.${i}`)));
    expect(await chain.chainer.chainOnce({ minAgeMs: 0 })).toBe(25);
    expect(await chain.chainer.verify(tenant.c)).toEqual({ ok: true, checked: 25 });
  });

  it('detects an edited row', async () => {
    await db.owner.query(`UPDATE audit_logs SET action = 'tampered' WHERE action = 'a.2'`);
    const verdict = await chain.chainer.verify(tenant.a);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.brokenAt.reason).toMatch(/content/);
    expect(await chain.chainer.verify(tenant.b)).toMatchObject({ ok: true }); // other tenants unaffected
    await db.owner.query(`UPDATE audit_logs SET action = 'a.2' WHERE action = 'tampered'`);
    expect(await chain.chainer.verify(tenant.a)).toMatchObject({ ok: true });
  });

  it('detects a deleted row and an edited JSON payload', async () => {
    await db.owner.query(`DELETE FROM audit_logs WHERE action = 'c.10'`);
    const gap = await chain.chainer.verify(tenant.c);
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.brokenAt.reason).toMatch(/prev_hash/);

    await db.owner.query(`UPDATE audit_logs SET after = '{"note":"changed"}' WHERE action = 'b.2'`);
    expect((await chain.chainer.verify(tenant.b)).ok).toBe(false);
  });

  it('the chainer role can only fill hash columns and cannot read other tables', async () => {
    const direct = new (await import('pg')).Pool({ connectionString: db.urls.audit });
    try {
      await expect(direct.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(direct.query('SELECT * FROM memberships')).rejects.toThrow(/permission denied/);
      await expect(direct.query('SELECT * FROM auth.user_credentials')).rejects.toThrow(/permission denied/);
      await expect(direct.query('DELETE FROM audit_logs')).rejects.toThrow(/permission denied/);
    } finally {
      await direct.end();
    }
  });
});

describe('outbox', () => {
  const published: { channel: string; message: string }[] = [];
  const collect = async (channel: string, message: string) => void published.push({ channel, message });
  const event = (tenantId: string, type = 'inbox.message.received') => ({
    tenantId,
    eventType: type,
    aggregateType: 'conversation',
    aggregateId: randomUUID(),
    payload: { hello: 'world' },
  });

  it('never publishes an event from a rolled-back transaction', async () => {
    await expect(
      db.tenantDb({ tenantId: tenant.a }).transaction(async (tx) => {
        await writeOutbox(tx, event(tenant.a, 'order.order.confirmed'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await outbox.publisher.publishOnce(collect)).toBe(0);
    expect(published).toHaveLength(0);
  });

  it('publishes a committed event once, on the tenant channel, and marks it published', async () => {
    const e = event(tenant.a);
    await db.tenantDb({ tenantId: tenant.a }).transaction((tx) => writeOutbox(tx, e));
    expect(await outbox.publisher.publishOnce(collect)).toBe(1);
    expect(published).toHaveLength(1);
    const msg = published[0];
    expect(msg?.channel).toBe(`t:${tenant.a}:events`);
    expect(JSON.parse(msg?.message ?? '{}')).toMatchObject({
      tenantId: tenant.a,
      type: 'inbox.message.received',
      aggregateId: e.aggregateId,
      payload: { hello: 'world' },
    });
    expect(await outbox.publisher.publishOnce(collect)).toBe(0);
    const { rows } = await db.owner.query('SELECT published_at FROM outbox_events WHERE aggregate_id = $1', [e.aggregateId]);
    expect(rows[0]?.published_at).toBeInstanceOf(Date);
  });

  it('keeps publishing in id order and retries what failed, without re-sending what succeeded', async () => {
    const first = event(tenant.b, 'inbox.message.received');
    const second = event(tenant.b, 'inbox.message.read');
    await db.tenantDb({ tenantId: tenant.b }).transaction(async (tx) => {
      await writeOutbox(tx, first);
      await writeOutbox(tx, second);
    });
    const before = published.length;
    let calls = 0;
    const flaky = async (channel: string, message: string) => {
      if (++calls === 2) throw new Error('redis down');
      published.push({ channel, message });
    };
    await expect(outbox.publisher.publishOnce(flaky)).rejects.toThrow('redis down');
    expect(published.length - before).toBe(1);
    expect(await outbox.publisher.publishOnce(collect)).toBe(1);
    const types = published.slice(before).map((m) => JSON.parse(m.message).type);
    expect(types).toEqual(['inbox.message.received', 'inbox.message.read']);
  });

  it('rejects event names that are not module.entity.verb', async () => {
    await expect(
      db.tenantDb({ tenantId: tenant.a }).transaction((tx) => writeOutbox(tx, event(tenant.a, 'BadName'))),
    ).rejects.toThrow(/module\.entity\.verb/);
  });

  it('is invisible across tenants to the API role, and the API cannot edit published state', async () => {
    await db.tenantDb({ tenantId: tenant.c }).transaction((tx) => writeOutbox(tx, event(tenant.c)));
    const seen = await db.tenantDb({ tenantId: tenant.a }).transaction((tx) => tx.execute(sql`SELECT tenant_id FROM outbox_events`));
    expect((seen.rows as { tenant_id: string }[]).every((r) => r.tenant_id === tenant.a)).toBe(true);
    await expect(db.app.query(`UPDATE outbox_events SET published_at = now()`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`DELETE FROM outbox_events`)).rejects.toThrow(/permission denied/);
  });

  it('the publisher role can mark events but not change them or read other tables', async () => {
    const direct = new (await import('pg')).Pool({ connectionString: db.urls.outbox });
    try {
      await expect(direct.query(`UPDATE outbox_events SET payload = '{}'`)).rejects.toThrow(/permission denied/);
      await expect(direct.query('SELECT * FROM memberships')).rejects.toThrow(/permission denied/);
      await expect(direct.query('SELECT * FROM audit_logs')).rejects.toThrow(/permission denied/);
      await expect(direct.query('DELETE FROM outbox_events')).rejects.toThrow(/permission denied/);
    } finally {
      await direct.end();
    }
  });
});
