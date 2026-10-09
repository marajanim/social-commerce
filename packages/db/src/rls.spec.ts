import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import { createTestDatabase, type TestDatabase } from './test-support';
import { schema } from './index';

let t: TestDatabase;
const tenantA = randomUUID();
const tenantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const roleA = randomUUID();
const roleB = randomUUID();

// Tables with tenant_id that are deliberately outside the generic policy. Empty today;
// webhook_events (M1-3) is the first expected entry and needs a reason here.
const RLS_EXEMPT = new Set<string>();

beforeAll(async () => {
  t = await createTestDatabase();
  const q = (text: string, values?: unknown[]) => t.owner.query(text, values);
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1,'A','a'), ($2,'B','b')`, [tenantA, tenantB]);
  await q(`INSERT INTO users (id, email, name) VALUES ($1,'a@x.test','A'), ($2,'b@x.test','B')`, [userA, userB]);
  await q(`INSERT INTO roles (id, tenant_id, key, name) VALUES ($1,$3,'owner','Owner'), ($2,$4,'owner','Owner')`, [
    roleA,
    roleB,
    tenantA,
    tenantB,
  ]);
  await q(`INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3), ($4,$5,$6)`, [
    tenantA,
    userA,
    roleA,
    tenantB,
    userB,
    roleB,
  ]);
  await q(`INSERT INTO teams (tenant_id, name) VALUES ($1,'support'), ($2,'support')`, [tenantA, tenantB]);
  await q(
    `INSERT INTO audit_logs (tenant_id, actor_type, action, target_type) VALUES ($1,'system','x.y','t'), ($2,'system','x.y','t')`,
    [tenantA, tenantB],
  );
});
afterAll(() => t?.stop());

describe('migrations', () => {
  it('create the identity, audit and outbox tables on a fresh database', async () => {
    const { rows } = await t.owner.query<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
       WHERE table_schema IN ('public','auth')`,
    );
    const names = rows.map((r) => r.t);
    for (const table of [
      'public.tenants',
      'public.users',
      'auth.user_credentials',
      'public.permissions',
      'public.roles',
      'public.role_permissions',
      'public.memberships',
      'public.teams',
      'public.team_members',
      'public.audit_logs',
      'public.outbox_events',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('are idempotent: a second run applies nothing', async () => {
    expect(await migrate(t.owner)).toEqual([]);
  });
});

describe('forced RLS coverage', () => {
  it('every table with a tenant_id column (partitions included) has forced RLS and a policy', async () => {
    const { rows } = await t.owner.query<{
      name: string;
      enabled: boolean;
      forced: boolean;
      policies: number;
    }>(`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`);
    expect(rows.length).toBeGreaterThan(5);
    const bad = rows.filter((r) => !RLS_EXEMPT.has(r.name) && !(r.enabled && r.forced && r.policies > 0));
    expect(bad.map((r) => r.name)).toEqual([]);
  });

  it('tenants and users, which have no tenant_id column, are also forced', async () => {
    const { rows } = await t.owner.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('tenants','users') AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.relforcerowsecurity)).toBe(true);
  });

  it('app_user cannot bypass RLS and is not a superuser', async () => {
    const { rows } = await t.owner.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname IN ('app_user','app_login')`,
    );
    expect(rows.every((r) => !r.rolbypassrls && !r.rolsuper)).toBe(true);
  });
});

describe('tenantDb', () => {
  it('scopes reads to the tenant in the context', async () => {
    const seen = await t.tenantDb({ tenantId: tenantA }).transaction((tx) => tx.select().from(schema.teams));
    expect(seen.map((r) => r.tenantId)).toEqual([tenantA]);
    const roles = await t.tenantDb({ tenantId: tenantB }).transaction((tx) => tx.select().from(schema.roles));
    expect(roles.map((r) => r.tenantId)).toEqual([tenantB]);
  });

  it('hides the other tenant: reading B’s row by id as A returns nothing', async () => {
    const rows = await t
      .tenantDb({ tenantId: tenantA })
      .transaction((tx) => tx.select().from(schema.tenants));
    expect(rows.map((r) => r.id)).toEqual([tenantA]);
  });

  it('blocks inserting a row that claims another tenant', async () => {
    await expect(
      t.tenantDb({ tenantId: tenantA }).transaction((tx) =>
        tx.insert(schema.teams).values({ tenantId: tenantB, name: 'sneaky' }),
      ),
    ).rejects.toThrow();
  });

  it('blocks a membership that points at another tenant’s role (composite FK)', async () => {
    await expect(
      t.owner.query(`INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [
        tenantA,
        userB,
        roleB,
      ]),
    ).rejects.toThrow(/foreign key/i);
  });

  it('rejects a context that is not a UUID before touching the database', () => {
    expect(() => t.tenantDb({ tenantId: "x'; DROP TABLE tenants;--" })).toThrow(/UUID/);
  });

  it('carries no tenant context into the next transaction on the same pooled connection', async () => {
    // t.app has max = 1, so both queries below use the very same connection.
    await t.tenantDb({ tenantId: tenantA, userId: userA }).transaction(async (tx) => {
      const r = await tx.execute<{ v: string }>(
        sql`SELECT current_setting('app.tenant_id') AS v`,
      );
      expect(r.rows[0]?.v).toBe(tenantA);
    });
    const after = await t.app.query<{ tenant: string | null; user: string | null }>(
      `SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant,
              nullif(current_setting('app.user_id', true), '') AS "user"`,
    );
    expect(after.rows[0]).toEqual({ tenant: null, user: null });
    const leaked = await t.app.query('SELECT id FROM teams');
    expect(leaked.rows).toHaveLength(0);
  });

  it('also clears the context after a rolled-back transaction', async () => {
    await expect(
      t.tenantDb({ tenantId: tenantA }).transaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const leaked = await t.app.query('SELECT id FROM teams');
    expect(leaked.rows).toHaveLength(0);
  });
});

describe('no tenant set', () => {
  it('returns no rows from any tenant table', async () => {
    for (const table of ['tenants', 'roles', 'memberships', 'teams', 'audit_logs', 'outbox_events']) {
      const r = await t.app.query(`SELECT 1 FROM ${table}`);
      expect(r.rows, table).toHaveLength(0);
    }
  });
});

describe('users policy', () => {
  it('shows only the current tenant’s members, and only self with just a user id', async () => {
    const asTenant = await t
      .tenantDb({ tenantId: tenantA })
      .transaction((tx) => tx.select({ id: schema.users.id }).from(schema.users));
    expect(asTenant.map((u) => u.id)).toEqual([userA]);
  });

  it('with no context shows no users', async () => {
    const r = await t.app.query('SELECT id FROM users');
    expect(r.rows).toHaveLength(0);
  });
});

describe('grants', () => {
  it('app_user cannot read auth.user_credentials', async () => {
    await expect(t.app.query('SELECT * FROM auth.user_credentials')).rejects.toThrow(/permission denied/);
  });

  it('app_user cannot update or delete audit rows, on the parent or a partition', async () => {
    for (const table of ['audit_logs', 'audit_logs_2026_10', 'audit_logs_default']) {
      await expect(t.app.query(`UPDATE ${table} SET action = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(t.app.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
    }
  });

  it('app_user can append audit rows only for its own tenant', async () => {
    await t.tenantDb({ tenantId: tenantA }).transaction((tx) =>
      tx.insert(schema.auditLogs).values({ tenantId: tenantA, actorType: 'user', action: 'a.b', targetType: 'x' }),
    );
    await expect(
      t.tenantDb({ tenantId: tenantA }).transaction((tx) =>
        tx.insert(schema.auditLogs).values({ tenantId: tenantB, actorType: 'user', action: 'a.b', targetType: 'x' }),
      ),
    ).rejects.toThrow();
  });

  it('app_user cannot change the permission catalog, delete users or create tenants', async () => {
    await expect(t.app.query(`INSERT INTO permissions VALUES ('a.b','a','d')`)).rejects.toThrow(/permission denied/);
    await expect(t.app.query('DELETE FROM users')).rejects.toThrow(/permission denied/);
    await expect(
      t.app.query(`INSERT INTO tenants (name, slug) VALUES ('c','c')`),
    ).rejects.toThrow(/permission denied/);
  });

  it('updated_at is maintained by trigger', async () => {
    const before = await t.owner.query<{ updated_at: Date }>('SELECT updated_at FROM teams WHERE tenant_id = $1', [
      tenantA,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    await t.owner.query(`UPDATE teams SET default_capacity = 20 WHERE tenant_id = $1`, [tenantA]);
    const after = await t.owner.query<{ updated_at: Date }>('SELECT updated_at FROM teams WHERE tenant_id = $1', [
      tenantA,
    ]);
    expect(after.rows[0]?.updated_at.getTime()).toBeGreaterThan(before.rows[0]?.updated_at.getTime() ?? 0);
  });
});
