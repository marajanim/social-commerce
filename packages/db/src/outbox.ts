import * as schema from './schema';
import type { Tx } from './tenant-db';

export interface OutboxEventInput {
  tenantId: string;
  /** `module.entity.verb`, e.g. inbox.message.received. */
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

const EVENT_TYPE = /^[a-z_]+\.[a-z_]+\.[a-z_]+$/;

/**
 * Writes an event in the caller's transaction. It becomes visible to the publisher only when
 * that transaction commits, so a rolled-back change never emits an event. Never publish to
 * Redis or emit a socket event directly from a request handler: call this instead.
 */
export async function writeOutbox(tx: Tx, event: OutboxEventInput): Promise<void> {
  if (!EVENT_TYPE.test(event.eventType)) {
    throw new Error(`event type must look like module.entity.verb, got "${event.eventType}"`);
  }
  await tx.insert(schema.outboxEvents).values({
    tenantId: event.tenantId,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
  });
}

/** What the publisher sends on `t:{tenantId}:events`. `id` is stable: consumers dedupe on it. */
export interface PublishedEvent {
  id: string;
  tenantId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: string;
}

export const eventChannel = (tenantId: string) => `t:${tenantId}:events`;
