import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from './config';
import { buildWebhooksModule } from './webhooks/webhooks.module';

// Entrypoint of the webhook receiver: a separate process from the REST API, so a flood of provider
// events can never starve user requests. Connects as worker_login, never sees sessions or users.
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    buildWebhooksModule(),
    new FastifyAdapter({ trustProxy: config.NODE_ENV === 'production' }),
    { rawBody: true },
  );
  app.enableShutdownHooks();
  await app.listen(config.WEBHOOK_PORT, '0.0.0.0');
}

void bootstrap();
