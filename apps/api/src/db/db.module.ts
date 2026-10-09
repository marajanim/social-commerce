import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createAuthDatabase, createDatabase, type AuthDb, type Database } from '@sc/db';
import { CONFIG, type Config } from '../config';

export const DATABASE = Symbol('DATABASE');
export const AUTH_DB = Symbol('AUTH_DB');
const AUTH_CLOSE = Symbol('AUTH_CLOSE');

/** One pool per role. Tests override DATABASE and AUTH_DB with their containers. */
@Global()
@Module({
  providers: [
    { provide: DATABASE, inject: [CONFIG], useFactory: (c: Config): Database => createDatabase(c.APP_DATABASE_URL) },
    {
      provide: AUTH_CLOSE,
      inject: [CONFIG],
      useFactory: (c: Config) => createAuthDatabase(c.AUTH_DATABASE_URL),
    },
    { provide: AUTH_DB, inject: [AUTH_CLOSE], useFactory: (a: { authDb: AuthDb }): AuthDb => a.authDb },
  ],
  exports: [DATABASE, AUTH_DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH_CLOSE) private readonly auth: { close(): Promise<void> },
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.db.close(), this.auth.close()]);
  }
}
