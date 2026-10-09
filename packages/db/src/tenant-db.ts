import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema';

export type Schema = typeof schema;
/** The query builder handed to code running inside a tenant transaction. */
export type Tx = Parameters<Parameters<NodePgDatabase<Schema>['transaction']>[0]>[0];

export interface TenantContext {
  tenantId: string;
  /** Needed for the `users` policy and `sys.user_workspaces()`. */
  userId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

/**
 * The only way application code touches tenant data. Every call opens a transaction and sets
 * the tenant with a transaction-local setting (`set_config(..., true)`), so the value disappears
 * on commit or rollback and can never leak into the next request on a pooled connection.
 * Never use a session-level SET for app.* values.
 */
export function createTenantDb(pool: Pool) {
  const db = drizzle(pool, { schema });

  return function tenantDb(ctx: TenantContext) {
    assertUuid('tenantId', ctx.tenantId);
    if (ctx.userId !== undefined) assertUuid('userId', ctx.userId);

    return {
      transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        return db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`);
          await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true)`);
          return fn(tx);
        });
      },
    };
  };
}

export type TenantDb = ReturnType<ReturnType<typeof createTenantDb>>;

/**
 * Context with only a user (no tenant yet), for `sys.user_workspaces()` at login. Transaction-local
 * like tenantDb, and the only other place app.* is set.
 */
export function createUserDb(pool: Pool) {
  const db = drizzle(pool, { schema });
  return function userDb(userId: string) {
    assertUuid('userId', userId);
    return {
      transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
        return db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
          return fn(tx);
        });
      },
    };
  };
}
