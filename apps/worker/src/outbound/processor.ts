import type { WorkerDatabase } from '@sc/db';
import { deliverOutboundMessage, type DeliveryOutcome } from '@sc/inbox';
import { outboundJob } from '@sc/shared';
import { decryptSecret, type KeyRing } from '@sc/shared/crypto';

export interface OutboundDeps {
  db: Pick<WorkerDatabase, 'tenantDb'>;
  keyRing: KeyRing | null;
}

/** Delivers one pending reply. Throws on a retryable provider error so the queue backs off and tries again. */
export async function processOutboundJob(
  deps: OutboundDeps,
  data: unknown,
  attempt: { made: number; max: number },
): Promise<DeliveryOutcome> {
  const job = outboundJob.parse(data);
  const outcome = await deliverOutboundMessage(
    {
      tenantDb: (ctx) => deps.db.tenantDb(ctx),
      decryptToken: (encrypted, keyVersion) => {
        if (!deps.keyRing) throw new Error('CHANNEL_KEY_V1 is not configured on the worker');
        return decryptSecret(encrypted, keyVersion, deps.keyRing);
      },
    },
    { tenantId: job.tenantId, messageId: job.messageId, isLastAttempt: attempt.made + 1 >= attempt.max },
  );
  if (outcome === 'retry') throw new Error('provider error, will retry');
  return outcome;
}
