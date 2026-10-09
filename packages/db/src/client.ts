import { Pool } from 'pg';
import { createAuditChainer } from './audit-chain';
import { createAuthDb, type AuthDb } from './auth-db';
import { createOutboxPublisher } from './outbox-publisher';
import { createSystemDb, type SystemDb } from './system';
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

/** Pool for the outbox publisher job. Connect with the outbox_login role. */
export function createOutboxPublisherDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 2 });
  return { publisher: createOutboxPublisher(pool), close: () => pool.end() };
}

/** Pool for the audit chaining job. Connect with the audit_login role. */
export function createAuditChainerDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 2 });
  return { chainer: createAuditChainer(pool), close: () => pool.end() };
}

export interface WorkerDatabase extends Database {
  system: SystemDb;
}

/** Pool for workers and the webhook receiver. Connect with the worker_login role. */
export function createWorkerDatabase(connectionString: string, options: { max?: number } = {}): WorkerDatabase {
  const pool = new Pool({ connectionString, max: options.max ?? 10 });
  return {
    tenantDb: createTenantDb(pool),
    userDb: createUserDb(pool),
    system: createSystemDb(pool),
    close: () => pool.end(),
  };
}
