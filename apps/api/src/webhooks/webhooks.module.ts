import {
  type RawBodyRequest,
  Controller,
  ForbiddenException,
  Get,
  Global,
  HttpCode,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { messengerEventKey, splitMessengerPayload, verifyMetaSignature } from '@sc/channels';
import { createWorkerDatabase, type WorkerDatabase } from '@sc/db';
import { INBOX_QUEUES, inboundJob, type InboundJob } from '@sc/shared';
import { Queue } from 'bullmq';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../common/decorators';
import { CONFIG, loadConfig, type Config } from '../config';

export const WEBHOOK_DB = Symbol('WEBHOOK_DB');
export const INBOUND_QUEUE = Symbol('INBOUND_QUEUE');

export interface InboundQueue {
  enqueue(job: InboundJob): Promise<void>;
}

@Injectable()
export class BullInboundQueue implements InboundQueue, OnApplicationShutdown {
  private readonly queue: Queue;

  constructor(@Inject(CONFIG) config: Config) {
    this.queue = new Queue(INBOX_QUEUES.inbound, {
      connection: { url: config.REDIS_URL },
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 500, removeOnFail: 2000 },
    });
  }

  async enqueue(job: InboundJob): Promise<void> {
    const data = inboundJob.parse(job);
    await this.queue.add('process', data, { jobId: data.webhookEventId });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

/**
 * Meta's webhook endpoint. It only verifies, stores and enqueues, then answers 200:
 * no business logic, no outside calls, no AI. Everything slow happens in the inbound worker.
 */
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(WEBHOOK_DB) private readonly db: WorkerDatabase,
    @Inject(INBOUND_QUEUE) private readonly queue: InboundQueue,
  ) {}

  /** Subscription handshake: echo hub.challenge when the verify token matches. */
  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    const expected = this.config.META_VERIFY_TOKEN;
    if (mode !== 'subscribe' || !expected || token !== expected || !challenge) throw new ForbiddenException();
    void reply.type('text/plain').send(challenge);
  }

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<FastifyRequest>): Promise<string> {
    const secret = this.config.META_APP_SECRET;
    const raw = req.rawBody;
    const signature = req.headers['x-hub-signature-256'];
    if (!secret || !raw || !verifyMetaSignature(raw, typeof signature === 'string' ? signature : undefined, secret)) {
      throw new ForbiddenException();
    }

    // Meta batches several events per request; store each one so it is processed (and deduped) alone.
    const items = splitMessengerPayload(req.body);
    const fresh = await this.db.system.insertWebhookEvents(
      items.map((i) => ({
        provider: 'messenger',
        eventKey: messengerEventKey(i),
        payload: i,
        signatureValid: true,
      })),
    );
    for (const e of fresh) {
      // Redis being down must not lose the event: it is stored, and the worker's sweeper re-enqueues it.
      await this.queue.enqueue({ webhookEventId: e.id }).catch(() => undefined);
    }
    return 'EVENT_RECEIVED';
  }
}

@Module({
  providers: [
    {
      provide: WEBHOOK_DB,
      inject: [CONFIG],
      useFactory: (c: Config) => {
        if (!c.WORKER_DATABASE_URL) throw new Error('WORKER_DATABASE_URL is required by the webhook receiver');
        return createWorkerDatabase(c.WORKER_DATABASE_URL, { max: 5 });
      },
    },
    { provide: INBOUND_QUEUE, useClass: BullInboundQueue },
  ],
  exports: [WEBHOOK_DB, INBOUND_QUEUE],
})
export class WebhookInfraModule implements OnApplicationShutdown {
  constructor(@Inject(WEBHOOK_DB) private readonly db: WorkerDatabase) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

/** Builds the receiver app (tests override WEBHOOK_DB and INBOUND_QUEUE with fakes). */
export function buildWebhooksModule(config: Config = loadConfig()) {
  @Global()
  @Module({ providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] })
  class ConfigModule {}

  @Module({ imports: [ConfigModule, WebhookInfraModule], controllers: [MetaWebhookController] })
  class WebhooksModule {}
  return WebhooksModule;
}
