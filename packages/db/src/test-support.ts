import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from './migrate';
import { createTenantDb } from './tenant-db';

export interface TestDatabase {
  /** Superuser pool: seeds data and inspects the catalog. Bypasses RLS, so never use it to assert isolation. */
  owner: Pool;
  /** Pool for a login that is a member of app_user only. One connection, so leaks between transactions would show. */
  app: Pool;
  /** tenantDb bound to the `app` pool. */
  tenantDb: ReturnType<typeof createTenantDb>;
  stop(): Promise<void>;
}

/** A fresh, fully migrated Postgres with an app_user login, as the API will connect. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const pg = { url: container.getConnectionUri(), pool: new Pool({ connectionString: container.getConnectionUri() }) };
  await migrate(pg.pool);

  await pg.pool.query("CREATE ROLE app_login LOGIN PASSWORD 'app_login' IN ROLE app_user");
  const url = new URL(pg.url);
  url.username = 'app_login';
  url.password = 'app_login';
  const app = new Pool({ connectionString: url.toString(), max: 1 });

  return {
    owner: pg.pool,
    app,
    tenantDb: createTenantDb(app),
    async stop() {
      await app.end();
      await pg.pool.end();
      await container.stop();
    },
  };
}
