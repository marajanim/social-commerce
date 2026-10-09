import { QUEUES } from '@sc/shared';
import { Worker } from 'bullmq';
import { createTransport } from 'nodemailer';
import { createHealthServer } from './health-server';
import { processEmailJob } from './email/processor';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is not set');

const transport = createTransport({
  host: process.env.SMTP_HOST ?? 'localhost',
  port: Number(process.env.SMTP_PORT ?? 1025),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
});
const from = process.env.MAIL_FROM ?? 'Social Commerce <no-reply@localhost>';

const emailWorker = new Worker(QUEUES.email, (job) => processEmailJob(job.data, transport, from), {
  connection: { url: redisUrl },
  concurrency: 5,
});
emailWorker.on('failed', (job, err) => {
  // Job data holds a tokenised link, so log only the id, template and error message.
  console.error(`email job ${job?.id ?? '?'} (${job?.name ?? '?'}) failed: ${err.message}`);
});

const health = createHealthServer().listen(Number(process.env.WORKER_PORT ?? 4001), '0.0.0.0');

async function shutdown(): Promise<void> {
  await emailWorker.close();
  health.close();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
