import type { WorkerDatabase } from '@sc/db';

export interface JobSink {
  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<unknown>;
}

/**
 * Safety net for the two places work can be stored but not queued (Redis down, worker crashed):
 * webhook events nobody processed, and pending replies nobody delivered. Re-enqueues them; both
 * processors are idempotent, so an extra job is harmless.
 */
export async function sweepOnce(
  deps: { db: Pick<WorkerDatabase, 'system'>; inbound: JobSink; outbound: JobSink },
  options: { olderThanSeconds?: number } = {},
): Promise<{ webhookEvents: number; replies: number }> {
  const stuck = await deps.db.system.stuckWebhookEventIds(options.olderThanSeconds ?? 30);
  for (const id of stuck) {
    await deps.inbound.add('process', { webhookEventId: id }, { jobId: `sweep-${id}-${Date.now()}` });
  }
  const pending = await deps.db.system.dueWork('outbound_pending');
  for (const p of pending) {
    await deps.outbound.add('deliver', { tenantId: p.tenantId, messageId: p.id }, { jobId: `sweep-${p.id}-${Date.now()}` });
  }
  return { webhookEvents: stuck.length, replies: pending.length };
}
