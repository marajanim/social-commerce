import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@sc/db';
import { schema } from '@sc/db';
import type { PermissionScope, WorkspaceSummary } from '@sc/shared';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../db/db.module';

export interface Membership {
  roleKey: string;
  permissions: Map<string, PermissionScope>;
}

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The user's workspaces, resolved before any tenant is chosen (sys.user_workspaces). */
  async listFor(userId: string): Promise<WorkspaceSummary[]> {
    const res = await this.db.userDb(userId).transaction((tx) =>
      tx.execute<{ tenant_id: string; tenant_name: string; role_key: string }>(
        sql`SELECT tenant_id, tenant_name, role_key FROM sys.user_workspaces() ORDER BY tenant_name`,
      ),
    );
    return res.rows.map((r) => ({ tenantId: r.tenant_id, name: r.tenant_name, roleKey: r.role_key }));
  }

  /** The user's active membership in this tenant with its permissions, or null. Under RLS. */
  async membership(userId: string, tenantId: string): Promise<Membership | null> {
    const rows = await this.db.tenantDb({ tenantId, userId }).transaction((tx) =>
      tx
        .select({
          roleKey: schema.roles.key,
          permission: schema.rolePermissions.permissionKey,
          scope: schema.rolePermissions.scope,
        })
        .from(schema.memberships)
        .innerJoin(
          schema.roles,
          and(eq(schema.roles.tenantId, schema.memberships.tenantId), eq(schema.roles.id, schema.memberships.roleId)),
        )
        .leftJoin(
          schema.rolePermissions,
          and(
            eq(schema.rolePermissions.tenantId, schema.roles.tenantId),
            eq(schema.rolePermissions.roleId, schema.roles.id),
          ),
        )
        .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, 'active'))),
    );
    const first = rows[0];
    if (!first) return null;
    const permissions = new Map<string, PermissionScope>();
    for (const r of rows) if (r.permission) permissions.set(r.permission, r.scope as PermissionScope);
    return { roleKey: first.roleKey, permissions };
  }
}
