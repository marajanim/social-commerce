import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createAuthDb, type AuthDb } from './auth-db';
import { ensureLoginRoles } from './logins';
import { migrate } from './migrate';
import { createTenantDb, createUserDb } from './tenant-db';

export interface TestDatabase {
  /** Superuser pool: seeds data and inspects the catalog. Bypasses RLS, so never use it to assert isolation. */
  owner: Pool;
  /** Pool for the app_login role. One connection, so a context leak between transactions would show. */
  app: Pool;
  /** tenantDb / userDb bound to the `app` pool. */
  tenantDb: ReturnType<typeof createTenantDb>;
  userDb: ReturnType<typeof createUserDb>;
  /** Pool and facade for the auth_login role. */
  authPool: Pool;
  authDb: AuthDb;
  /** Connection strings of the logins, for apps under test. */
  urls: { owner: string; app: string; auth: string; outbox: string; audit: string };
  stop(): Promise<void>;
}

function withLogin(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** A fresh, fully migrated Postgres with the same app and auth logins the services use. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  const ownerUrl = container.getConnectionUri();
  const owner = new Pool({ connectionString: ownerUrl });
  await migrate(owner);
  await ensureLoginRoles(owner, {
    app: 'app_login',
    auth: 'auth_login',
    outbox: 'outbox_login',
    audit: 'audit_login',
  });

  const appUrl = withLogin(ownerUrl, 'app_login', 'app_login');
  const authUrl = withLogin(ownerUrl, 'auth_login', 'auth_login');
  const app = new Pool({ connectionString: appUrl, max: 1 });
  const authPool = new Pool({ connectionString: authUrl, max: 2 });

  return {
    owner,
    app,
    tenantDb: createTenantDb(app),
    userDb: createUserDb(app),
    authPool,
    authDb: createAuthDb(authPool),
    urls: {
      owner: ownerUrl,
      app: appUrl,
      auth: authUrl,
      outbox: withLogin(ownerUrl, 'outbox_login', 'outbox_login'),
      audit: withLogin(ownerUrl, 'audit_login', 'audit_login'),
    },
    async stop() {
      await app.end();
      await authPool.end();
      await owner.end();
      await container.stop();
    },
  };
}
