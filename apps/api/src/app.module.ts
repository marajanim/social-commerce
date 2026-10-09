import { Global, Module, type Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './common/auth.guard';
import { OriginGuard } from './common/origin.guard';
import { CONFIG, loadConfig, type Config } from './config';
import { DbModule } from './db/db.module';
import { HealthController } from './health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { InboxModule } from './modules/inbox/inbox.module';

/**
 * Builds the app module for a given config (tests pass their own; production reads the
 * environment). `extraControllers` is a test seam for probe routes behind the real guards.
 */
export function buildAppModule(config: Config = loadConfig(), extraControllers: Type[] = []) {
  @Global()
  @Module({ providers: [{ provide: CONFIG, useValue: config }], exports: [CONFIG] })
  class ConfigModule {}

  @Module({
    imports: [ConfigModule, DbModule, AuthModule, ChannelsModule, InboxModule],
    controllers: [HealthController, ...extraControllers],
    providers: [
      // Order matters: the Origin check runs before any session lookup.
      { provide: APP_GUARD, useClass: OriginGuard },
      { provide: APP_GUARD, useClass: AuthGuard },
    ],
  })
  class AppModule {}

  return AppModule;
}
