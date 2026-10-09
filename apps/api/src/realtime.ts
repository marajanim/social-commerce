import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadConfig } from './config';
import { SessionService } from './modules/auth/session.service';
import { WorkspacesService } from './modules/auth/workspaces.service';
import { buildRealtimeModule } from './realtime/realtime.module';
import { attachRealtime } from './realtime/realtime.server';

// Entrypoint of the realtime gateway (Socket.IO). Its own process so thousands of open sockets
// never compete with REST requests for the same event loop.
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(buildRealtimeModule(config), new FastifyAdapter());
  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const realtime = await attachRealtime({
    httpServer: app.getHttpServer(),
    sessions: app.get(SessionService),
    workspaces: app.get(WorkspacesService),
    redisUrl: config.REDIS_URL,
    allowedOrigin: config.WEB_ORIGIN,
  });
  await app.listen(config.REALTIME_PORT, '0.0.0.0');
  const stop = () => void realtime.close().then(() => app.close());
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

void bootstrap();
