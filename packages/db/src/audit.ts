import * as schema from './schema';
import type { Tx } from './tenant-db';

export type AuditActorType = 'user' | 'platform_admin' | 'system' | 'ai' | 'api_key';

export interface AuditEntry {
  tenantId: string;
  actorType: AuditActorType;
  actorId?: string | null;
  /** `entity.verb`, e.g. role.permissions_changed, contact.merged, auth.login. */
  action: string;
  targetType: string;
  targetId?: string | null;
  /** Minimise personal data: store the fields that changed, not whole customer records. */
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/**
 * Appends an audit row inside the caller's transaction, so the action and its audit trail commit
 * or roll back together. The row is written without a hash; the chaining job fills that in later.
 */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    tenantId: e.tenantId,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent?.slice(0, 300) ?? null,
    correlationId: e.correlationId ?? null,
  });
}
