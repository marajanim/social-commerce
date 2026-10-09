import { createAuditChainerDatabase, createOutboxPublisherDatabase, createWorkerDatabase } from '@sc/db';
import { INBOX_QUEUES, QUEUES } from '@sc/shared';
import { loadKeyRing, type KeyRing } from '@sc/shared/crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createTransport } from 'nodemailer';
import { processEmailJob } from './email/processor';
import { createHealthServer } from './health-server';
import { processWebhookEvent } from './inbound/processor';
import { startAuditLoop } from './jobs/audit-loop';
import { startOutboxLoop } from './jobs/outbox-loop';
import { sweepOnce } from './jobs/sweeper';
import { processOutboundJob } from './outbound/processor';

const env = process.env;
const redisUrl = env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');
const connection = { url: redisUrl };

let keyRing: KeyRing | null = null;
try {
  keyRing = loadKeyRing(env);
} catch (err) {
  if (err instanceof Error && !err.message.startsWith('No CHANNEL_KEY')) throw err;
  console.warn('CHANNEL_KEY_V1 is not set: sending to Messenger and profile lookups are disabled');
}

const closers: (() => Promise<unknown> | unknown)[] = [];
const log = (what: string) => (err: unknown) =>
  console.error(`${what}: ${err instanceof Error ? err.message : String(err)}`);

// ---- email (password reset, verification) ----
const transport = createTransport({
  host: env.SMTP_HOST ?? 'localhost',
  port: Number(env.SMTP_PORT ?? 1025),
  secure: env.SMTP_SECURE === 'true',
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
});
const from = env.MAIL_FROM ?? 'Social Commerce <no-reply@localhost>';
const emailWorker = new Worker(QUEUES.email, (job) => processEmailJob(job.data, transport, from), {
  connection,
  concurrency: 5,
});
emailWorker.on('failed', (job, err) => {
  // Job data holds a tokenised link, so log only the id, template and error message.
  console.error(`email job ${job?.id ?? '?'} (${job?.name ?? '?'}) failed: ${err.message}`);
});
closers.push(() => emailWorker.close());

// ---- inbox: inbound + outbound + sweeper (worker_login) ----
if (env.WORKER_DATABASE_URL) {
  const db = createWorkerDatabase(env.WORKER_DATABASE_URL);
  closers.push(() => db.close());

  const inboundWorker = new Worker(
    INBOX_QUEUES.inbound,
    (job) => {
      const id = (job.data as { webhookEventId?: string }).webhookEventId;
      if (!id) throw new Error('inbound job without webhookEventId');
      return processWebhookEvent({ db, keyRing, ownAppId: env.META_APP_ID }, id);
    },
    { connection, concurrency: 10 },
  );
  inboundWorker.on('failed', (job, err) => console.error(`inbound job ${job?.id ?? '?'} failed: ${err.message}`));

  const outboundWorker = new Worker(
    INBOX_QUEUES.outbound,
    (job) => processOutboundJob({ db, keyRing }, job.data, { made: job.attemptsMade, max: job.opts.attempts ?? 1 }),
    { connection, concurrency: 10 },
  );
  outboundWorker.on('failed', (job, err) => console.error(`outbound job ${job?.id ?? '?'} failed: ${err.message}`));
  closers.push(
    () => inboundWorker.close(),
    () => outboundWorker.close(),
  );

  const inboundQueue = new Queue(INBOX_QUEUES.inbound, {
    connection,
    defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 500, removeOnFail: 2000 },
  });
  const outboundQueue = new Queue(INBOX_QUEUES.outbound, {
    connection,
    defaultJobOptions: { attempts: 6, backoff: { type: 'exponential', delay: 3_000 }, removeOnComplete: 500, removeOnFail: 2000 },
  });
  closers.push(
    () => inboundQueue.close(),
    () => outboundQueue.close(),
  );
  const sweeper = setInterval(() => {
    sweepOnce({ db, inbound: inboundQueue, outbound: outboundQueue }).catch(log('sweeper'));
  }, 15_000);
  closers.push(() => clearInterval(sweeper));
} else {
  console.warn('WORKER_DATABASE_URL is not set: inbox processing is disabled');
}

// ---- realtime backbone: outbox -> Redis pub/sub (outbox_login) ----
if (env.OUTBOX_DATABASE_URL) {
  const outbox = createOutboxPublisherDatabase(env.OUTBOX_DATABASE_URL);
  const publisherRedis = new Redis(redisUrl);
  const loop = startOutboxLoop({ publisher: outbox.publisher, redis: publisherRedis, onError: log('outbox publisher') });
  closers.push(
    () => loop.stop(),
    () => publisherRedis.quit(),
    () => outbox.close(),
  );
}

// ---- audit chaining (audit_login) ----
if (env.AUDIT_DATABASE_URL) {
  const audit = createAuditChainerDatabase(env.AUDIT_DATABASE_URL);
  const loop = startAuditLoop({
    chainer: audit.chainer,
    onError: log('audit chaining'),
    onBroken: (b) => console.error(`AUDIT CHAIN BROKEN tenant=${b.tenantId ?? 'platform'} row=${b.id}: ${b.reason}`),
  });
  closers.push(
    () => loop.stop(),
    () => audit.close(),
  );
}

const health = createHealthServer().listen(Number(env.WORKER_PORT ?? 4001), '0.0.0.0');
closers.push(() => health.close());

async function shutdown(): Promise<void> {
  await Promise.allSettled(closers.map((c) => c()));
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
