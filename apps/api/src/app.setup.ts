import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Shared by main.ts and tests so both run the same HTTP stack. */
export async function setupApp(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
}
