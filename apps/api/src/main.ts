import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildAppModule } from './app.module';
import { setupApp } from './app.setup';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    buildAppModule(config),
    // Behind Caddy/Cloudflare in production, so req.ip must come from X-Forwarded-For.
    new FastifyAdapter({ trustProxy: config.NODE_ENV === 'production' }),
  );
  app.enableShutdownHooks();
  await setupApp(app);
  await app.listen(config.API_PORT, '0.0.0.0');
}

void bootstrap();
