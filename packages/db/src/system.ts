import type { Pool } from 'pg';

export interface NewWebhookEvent {
  provider: string;
  eventKey: string;
  payload: unknown;
  signatureValid: boolean;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  payload: unknown;
  attempts: number;
}

export interface ResolvedAccount {
  tenantId: string;
  channelAccountId: string;
  status: string;
}

/**
 * Cross-tenant plumbing for the webhook receiver and the workers (worker_user role): the raw
 * webhook inbox and the Page-to-tenant lookup. Nothing here reads tenant data; once a job knows
 * its tenant it switches to tenantDb(ctx) and works under RLS.
 */
export function createSystemDb(pool: Pool) {
  return {
    /** Stores events, ignoring ones already seen. Returns only the rows that were new. */
    async insertWebhookEvents(events: NewWebhookEvent[]): Promise<{ id: string; eventKey: string }[]> {
      const inserted: { id: string; eventKey: string }[] = [];
      for (const e of events) {
        const res = await pool.query<{ id: string }>(
          `INSERT INTO webhook_events (provider, event_key, payload, signature_valid)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (event_key) DO NOTHING RETURNING id::text AS id`,
          [e.provider, e.eventKey, JSON.stringify(e.payload), e.signatureValid],
        );
        if (res.rows[0]) inserted.push({ id: res.rows[0].id, eventKey: e.eventKey });
      }
      return inserted;
    },

    /** Marks an event as being processed. Null when it is already done or taken by another worker. */
    async claimWebhookEvent(id: string): Promise<WebhookEventRow | null> {
      const res = await pool.query<WebhookEventRow>(
        `UPDATE webhook_events SET status = 'processing', attempts = attempts + 1
         WHERE id = $1 AND status IN ('received','failed')
         RETURNING id::text AS id, provider, payload, attempts`,
        [id],
      );
      return res.rows[0] ?? null;
    },

    async finishWebhookEvent(
      id: string,
      result: { status: 'processed' | 'failed' | 'quarantined'; tenantId?: string; channelAccountId?: string; error?: string },
    ): Promise<void> {
      await pool.query(
        `UPDATE webhook_events SET status = $2, tenant_id = $3, channel_account_id = $4, error = $5,
           processed_at = CASE WHEN $2 = 'failed' THEN NULL ELSE now() END
         WHERE id = $1`,
        [id, result.status, result.tenantId ?? null, result.channelAccountId ?? null, result.error?.slice(0, 500) ?? null],
      );
    },

    /** Events that were stored but never processed (queue was down, worker crashed). */
    async stuckWebhookEventIds(olderThanSeconds: number, limit = 200): Promise<string[]> {
      const res = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM webhook_events
         WHERE status IN ('received','failed') AND attempts < 5
           AND received_at < now() - ($1::int * interval '1 second')
         ORDER BY received_at LIMIT $2`,
        [olderThanSeconds, limit],
      );
      return res.rows.map((r) => r.id);
    },

    /** (tenant_id, id) pairs of work that is due; the caller then loads each under its own tenant context. */
    async dueWork(kind: 'outbound_pending', limit = 200): Promise<{ tenantId: string; id: string }[]> {
      const res = await pool.query<{ tenant_id: string; id: string }>(
        'SELECT tenant_id::text AS tenant_id, id::text AS id FROM sys.due_work($1, $2)',
        [kind, limit],
      );
      return res.rows.map((r) => ({ tenantId: r.tenant_id, id: r.id }));
    },

    /** Which workspace owns this Page / number? Null for an unknown account. */
    async resolveChannelAccount(channelKey: string, externalId: string): Promise<ResolvedAccount | null> {
      const res = await pool.query<{ tenant_id: string; channel_account_id: string; status: string }>(
        'SELECT * FROM sys.resolve_channel_account($1, $2)',
        [channelKey, externalId],
      );
      const r = res.rows[0];
      return r ? { tenantId: r.tenant_id, channelAccountId: r.channel_account_id, status: r.status } : null;
    },
  };
}

export type SystemDb = ReturnType<typeof createSystemDb>;
