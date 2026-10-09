import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@sc/db/test-support';

export interface TenantFixture {
  tenantId: string;
  userId: string;
  roleId: string;
  teamId: string;
}

export interface TenancyFixture {
  /** Two fully seeded workspaces. Every table that gets a tenant_id adds its rows here. */
  a: TenantFixture;
  b: TenantFixture;
  db: TestDatabase;
  stop(): Promise<void>;
}

async function seedTenant(db: TestDatabase, slug: string): Promise<TenantFixture> {
  const f: TenantFixture = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    roleId: randomUUID(),
    teamId: randomUUID(),
  };
  const q = db.owner.query.bind(db.owner);
  await q(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2::text, $2::text)`, [f.tenantId, slug]);
  await q(`INSERT INTO users (id, email, name) VALUES ($1, $2::text, $3::text)`, [f.userId, `${slug}@example.test`, slug]);
  await q(`INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES ($1, $2, 'owner', 'Owner', true)`, [
    f.roleId,
    f.tenantId,
  ]);
  await q(`INSERT INTO memberships (tenant_id, user_id, role_id, joined_at) VALUES ($1, $2, $3, now())`, [
    f.tenantId,
    f.userId,
    f.roleId,
  ]);
  await q(`INSERT INTO teams (id, tenant_id, name) VALUES ($1, $2, 'support')`, [f.teamId, f.tenantId]);
  return f;
}

/** Fresh migrated database with workspaces A and B, each with an owner, a role and a team. */
export async function createTenancyFixture(): Promise<TenancyFixture> {
  const db = await createTestDatabase();
  const a = await seedTenant(db, 'tenant-a');
  const b = await seedTenant(db, 'tenant-b');
  return { a, b, db, stop: () => db.stop() };
}

/** The slice of a Fastify/Nest app the harness needs. */
export interface Injectable {
  inject(opts: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<{ statusCode: number }>;
}

export interface CrossTenantProbe {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Builds the URL for the given tenant's own IDs, e.g. (t) => `/teams/${t.teamId}`. */
  url: (target: TenantFixture) => string;
  payload?: unknown;
  /** Headers that authenticate as the given tenant's owner. Swapped for real sessions in M0-6. */
  authAs: (caller: TenantFixture) => Record<string, string>;
}

/**
 * Cross-tenant check in one line: B's owner can reach B's resource (so the route really exists
 * and works), while A's owner gets 404 (not 403, which would reveal the ID exists) in both directions.
 */
export async function expectCrossTenantNotFound(
  app: Injectable,
  fx: Pick<TenancyFixture, 'a' | 'b'>,
  probe: CrossTenantProbe,
): Promise<void> {
  const call = async (caller: TenantFixture, target: TenantFixture) =>
    (
      await app.inject({
        method: probe.method,
        url: probe.url(target),
        headers: probe.authAs(caller),
        payload: probe.payload,
      })
    ).statusCode;

  const own = await call(fx.b, fx.b);
  if (own === 404 || own >= 500) throw new Error(`Probe is vacuous: the owner got ${own} on their own resource`);
  const aToB = await call(fx.a, fx.b);
  const bToA = await call(fx.b, fx.a);
  if (aToB !== 404) throw new Error(`Tenant A reached tenant B's resource: expected 404, got ${aToB}`);
  if (bToA !== 404) throw new Error(`Tenant B reached tenant A's resource: expected 404, got ${bToA}`);
}
