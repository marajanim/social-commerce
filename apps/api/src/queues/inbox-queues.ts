import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { INBOX_QUEUES, outboundJob, type OutboundJob } from '@sc/shared';
import { Queue } from 'bullmq';
import { CONFIG, type Config } from '../config';

export const OUTBOUND_QUEUE = Symbol('OUTBOUND_QUEUE');

export interface OutboundQueue {
  enqueue(job: OutboundJob): Promise<void>;
}

/**
 * Delivery happens in the worker. Call this only AFTER the transaction that stored the pending
 * message has committed; if Redis is down the worker's sweeper still finds the pending row.
 */
@Injectable()
export class BullOutboundQueue implements OutboundQueue, OnApplicationShutdown {
  private readonly queue: Queue;

  constructor(@Inject(CONFIG) config: Config) {
    this.queue = new Queue(INBOX_QUEUES.outbound, {
      connection: { url: config.REDIS_URL },
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 3_000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      },
    });
  }

  async enqueue(job: OutboundJob): Promise<void> {
    const data = outboundJob.parse(job);
    // One job per message: re-enqueueing the same message is a no-op while it is retained.
    await this.queue.add('deliver', data, { jobId: data.messageId });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

@Module({
  providers: [{ provide: OUTBOUND_QUEUE, useClass: BullOutboundQueue }],
  exports: [OUTBOUND_QUEUE],
})
export class InboxQueuesModule {}
