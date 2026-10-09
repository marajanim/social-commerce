import type { Pool } from 'pg';
import { eventChannel, type PublishedEvent } from './outbox';

export type PublishFn = (channel: string, message: string) => Promise<void>;

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
}

/**
 * Publishes committed outbox rows, oldest first, then marks them published. Delivery is
 * at-least-once: a crash between publish and the update re-sends, so consumers dedupe on
 * `event.id`. Ids are assigned at insert, so two transactions can commit out of id order;
 * consumers must not rely on strict order across aggregates (messages carry their own seq).
 * Runs as outbox_publisher: it can read and mark outbox_events and nothing else.
 */
export function createOutboxPublisher(pool: Pool) {
  return {
    async publishOnce(publish: PublishFn, limit = 100): Promise<number> {
      const client = await pool.connect();
      const done: string[] = [];
      let failure: unknown;
      try {
        await client.query('BEGIN');
        const rows = await client.query<OutboxRow>(
          `SELECT id::text AS id, tenant_id::text AS tenant_id, event_type, aggregate_type,
                  aggregate_id::text AS aggregate_id, payload, created_at
           FROM outbox_events WHERE published_at IS NULL
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        for (const r of rows.rows) {
          const event: PublishedEvent = {
            id: r.id,
            tenantId: r.tenant_id,
            type: r.event_type,
            aggregateType: r.aggregate_type,
            aggregateId: r.aggregate_id,
            payload: r.payload,
            createdAt: r.created_at.toISOString(),
          };
          try {
            await publish(eventChannel(r.tenant_id), JSON.stringify(event));
            done.push(r.id);
          } catch (err) {
            failure = err;
            break;
          }
        }
        if (done.length > 0) {
          await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [done]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      if (failure) throw failure;
      return done.length;
    },
  };
}

export type OutboxPublisher = ReturnType<typeof createOutboxPublisher>;
