import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema';

export type AuthTx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

/**
 * Access for the auth module only. Connects as auth_user, which can read the auth schema
 * (password hashes, sessions, one-time tokens) and look users up by email, and nothing else.
 */
export function createAuthDb(pool: Pool) {
  const db = drizzle(pool, { schema });
  return {
    transaction<T>(fn: (tx: AuthTx) => Promise<T>): Promise<T> {
      return db.transaction(fn);
    },
  };
}

export type AuthDb = ReturnType<typeof createAuthDb>;
