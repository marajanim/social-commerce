import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { emailJob, QUEUES, type EmailJob } from '@sc/shared';
import { Queue } from 'bullmq';
import { CONFIG, type Config } from '../config';

export const EMAIL_QUEUE = Symbol('EMAIL_QUEUE');

export interface EmailQueue {
  enqueue(job: EmailJob): Promise<void>;
}

/** The API never talks SMTP: it enqueues, and the worker sends. */
@Injectable()
export class BullEmailQueue implements EmailQueue, OnApplicationShutdown {
  private readonly queue: Queue;

  constructor(@Inject(CONFIG) config: Config) {
    this.queue = new Queue(QUEUES.email, {
      connection: { url: config.REDIS_URL },
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 100, removeOnFail: 1000 },
    });
  }

  async enqueue(job: EmailJob): Promise<void> {
    await this.queue.add(job.template, emailJob.parse(job));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

@Module({
  providers: [{ provide: EMAIL_QUEUE, useClass: BullEmailQueue }],
  exports: [EMAIL_QUEUE],
})
export class QueuesModule {}
