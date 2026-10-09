import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig, type Config } from '../config';
import { DbModule } from '../db/db.module';
import { HealthController } from '../health.controller';
import { AuthModule } from '../modules/auth/auth.module';

/** The realtime process reuses the auth module's session and membership checks. */
export function buildRealtimeModule(config: Config = loadConfig()) {
  @Global()
  @Module({ providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] })
  class ConfigModule {}

  @Module({ imports: [ConfigModule, DbModule, AuthModule], controllers: [HealthController] })
  class RealtimeAppModule {}
  return RealtimeAppModule;
}
