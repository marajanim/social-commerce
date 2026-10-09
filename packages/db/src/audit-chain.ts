import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// Hash chain over audit_logs, per tenant (rows with no tenant form one platform chain).
// hash = sha256(prev_hash || canonical row). The chaining job runs as audit_chainer, so request
// handlers never race on "the previous hash"; a verifier recomputes the chain to detect edits.

const LOCK_KEY = 726_500_002;

interface Row {
  key: string; // created_at as text, the exact primary-key value
  id: string;
  tenant_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  correlation_id: string | null;
  created_at: string;
  prev_hash: Buffer | null;
  hash: Buffer | null;
}

const COLUMNS = `
  created_at::text AS key, id::text AS id, tenant_id::text AS tenant_id, actor_type,
  actor_id::text AS actor_id, action, target_type, target_id::text AS target_id, before, after,
  host(ip) AS ip, user_agent, correlation_id,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  prev_hash, hash`;

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',')}}`;
}

export function computeAuditHash(prev: Buffer | null, r: Row): Buffer {
  const body = canonical([
    r.id,
    r.tenant_id,
    r.actor_type,
    r.actor_id,
    r.action,
    r.target_type,
    r.target_id,
    r.before,
    r.after,
    r.ip,
    r.user_agent,
    r.correlation_id,
    r.created_at,
  ]);
  return createHash('sha256')
    .update(prev ?? Buffer.alloc(0))
    .update(body)
    .digest();
}

export type ChainVerification =
  | { ok: true; checked: number }
  | { ok: false; checked: number; brokenAt: { id: string; tenantId: string | null; reason: string } };

export interface ChainOptions {
  /** Only chain rows older than this, so transactions still in flight can commit first. */
  minAgeMs?: number;
  batchSize?: number;
}

export function createAuditChainer(pool: Pool) {
  async function lastHash(client: PoolClient, tenantId: string | null): Promise<Buffer | null> {
    const res = await client.query<{ hash: Buffer }>(
      `SELECT hash FROM audit_logs
       WHERE tenant_id IS NOT DISTINCT FROM $1::uuid AND chained_at IS NOT NULL
       ORDER BY chained_at DESC, created_at DESC, id DESC LIMIT 1`,
      [tenantId],
    );
    return res.rows[0]?.hash ?? null;
  }

  return {
    /** Chains pending rows for every tenant. Returns how many rows were chained. */
    async chainOnce(options: ChainOptions = {}): Promise<number> {
      const minAgeMs = options.minAgeMs ?? 5_000;
      const batchSize = options.batchSize ?? 1_000;
      const client = await pool.connect();
      let total = 0;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const cutoff = `now() - ($1::int * interval '1 millisecond')`;
        const tenants = await client.query<{ tenant_id: string | null }>(
          `SELECT DISTINCT tenant_id::text AS tenant_id FROM audit_logs
           WHERE chained_at IS NULL AND created_at < ${cutoff}`,
          [minAgeMs],
        );
        for (const { tenant_id: tenantId } of tenants.rows) {
          let prev = await lastHash(client, tenantId);
          for (;;) {
            const pending = await client.query<Row>(
              `SELECT ${COLUMNS} FROM audit_logs
               WHERE tenant_id IS NOT DISTINCT FROM $1::uuid AND chained_at IS NULL AND created_at < ${cutoff.replace('$1', '$2')}
               ORDER BY created_at, id LIMIT $3`,
              [tenantId, minAgeMs, batchSize],
            );
            if (pending.rows.length === 0) break;
            for (const row of pending.rows) {
              const hash = computeAuditHash(prev, row);
              await client.query(
                `UPDATE audit_logs SET prev_hash = $1, hash = $2, chained_at = now()
                 WHERE created_at = $3::timestamptz AND id = $4::uuid`,
                [prev, hash, row.key, row.id],
              );
              prev = hash;
              total += 1;
            }
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return total;
    },

    /** Recomputes one tenant's chain (or the platform chain for null) and reports the first break. */
    async verify(tenantId: string | null): Promise<ChainVerification> {
      const res = await pool.query<Row>(
        `SELECT ${COLUMNS} FROM audit_logs
         WHERE tenant_id IS NOT DISTINCT FROM $1::uuid AND chained_at IS NOT NULL
         ORDER BY chained_at, created_at, id`,
        [tenantId],
      );
      let prev: Buffer | null = null;
      let checked = 0;
      for (const row of res.rows) {
        const fail = (reason: string): ChainVerification => ({
          ok: false,
          checked,
          brokenAt: { id: row.id, tenantId, reason },
        });
        const linked = (row.prev_hash === null && prev === null) || (row.prev_hash !== null && prev !== null && row.prev_hash.equals(prev));
        if (!linked) return fail('prev_hash does not match the previous row');
        const expected = computeAuditHash(prev, row);
        if (!row.hash || !row.hash.equals(expected)) return fail('row content does not match its hash');
        prev = row.hash;
        checked += 1;
      }
      return { ok: true, checked };
    },

    /** Verifies every tenant that has chained rows (the nightly check). */
    async verifyAll(): Promise<ChainVerification[]> {
      const tenants = await pool.query<{ tenant_id: string | null }>(
        'SELECT DISTINCT tenant_id::text AS tenant_id FROM audit_logs WHERE chained_at IS NOT NULL',
      );
      return Promise.all(tenants.rows.map((t) => this.verify(t.tenant_id)));
    },
  };
}

export type AuditChainer = ReturnType<typeof createAuditChainer>;
