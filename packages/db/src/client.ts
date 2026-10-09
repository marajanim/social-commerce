import { Pool } from 'pg';
import { createAuthDb, type AuthDb } from './auth-db';
import { createTenantDb, createUserDb } from './tenant-db';

export interface Database {
  tenantDb: ReturnType<typeof createTenantDb>;
  userDb: ReturnType<typeof createUserDb>;
  close(): Promise<void>;
}

/**
 * Opens the connection pool for one process. The pool itself is never exposed: code outside
 * this package can only reach the database through `tenantDb(ctx)` / `userDb(id)`.
 * Connect with the app_user login, never an owner or superuser.
 */
export function createDatabase(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  return { tenantDb: createTenantDb(pool), userDb: createUserDb(pool), close: () => pool.end() };
}

/** Pool for the auth module. Connect with the auth_user login. */
export function createAuthDatabase(
  connectionString: string,
  options: { max?: number } = {},
): { authDb: AuthDb; close(): Promise<void> } {
  const pool = new Pool({ connectionString, max: options.max ?? 5 });
  return { authDb: createAuthDb(pool), close: () => pool.end() };
}
