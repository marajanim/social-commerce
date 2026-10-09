import { Pool } from 'pg';
import { createTenantDb } from './tenant-db';

export interface Database {
  tenantDb: ReturnType<typeof createTenantDb>;
  close(): Promise<void>;
}

/**
 * Opens the connection pool for one process. The pool itself is never exposed: code outside
 * this package can only reach the database through `tenantDb(ctx)`.
 */
export function createDatabase(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  return { tenantDb: createTenantDb(pool), close: () => pool.end() };
}
