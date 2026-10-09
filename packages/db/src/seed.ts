import { randomUUID } from 'node:crypto';
import { PERMISSIONS, ROLE_KEYS, ROLE_NAMES, ROLE_PERMISSIONS } from '@sc/shared';
import type { Pool, PoolClient } from 'pg';

/** Upserts the global permission catalog. Safe to run on every deploy. */
export async function seedPermissionCatalog(pool: Pool | PoolClient): Promise<void> {
  for (const [key, meta] of Object.entries(PERMISSIONS)) {
    await pool.query(
      `INSERT INTO permissions (key, module, description) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description`,
      [key, meta.module, meta.description],
    );
  }
}

export interface NewWorkspace {
  name: string;
  slug: string;
  timezone?: string;
  owner: { email: string; name: string; passwordHash: string; locale?: string };
}

/**
 * Creates a workspace, its six built-in roles with their permissions, and the Owner account
 * (verified, with a password) in ONE transaction. Run as the database owner: it is the seed
 * and signup path, never a request handler.
 */
export async function createWorkspaceWithOwner(
  pool: Pool,
  input: NewWorkspace,
): Promise<{ tenantId: string; userId: string; roleIds: Record<string, string> }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedPermissionCatalog(client);
    const tenantId = randomUUID();
    await client.query(`INSERT INTO tenants (id, name, slug, timezone) VALUES ($1,$2::text,$3::text,$4)`, [
      tenantId,
      input.name,
      input.slug,
      input.timezone ?? 'Asia/Dhaka',
    ]);
    const roleIds: Record<string, string> = {};
    for (const key of ROLE_KEYS) {
      const id = randomUUID();
      roleIds[key] = id;
      await client.query(`INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES ($1,$2,$3,$4,true)`, [
        id,
        tenantId,
        key,
        ROLE_NAMES[key],
      ]);
      for (const [perm, scope] of Object.entries(ROLE_PERMISSIONS[key])) {
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_key, scope) VALUES ($1,$2,$3,$4)`,
          [tenantId, id, perm, scope],
        );
      }
    }
    const userId = await upsertUser(client, input.owner);
    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, role_id, joined_at) VALUES ($1,$2,$3, now())`,
      [tenantId, userId, roleIds.owner],
    );
    await client.query('COMMIT');
    return { tenantId, userId, roleIds };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function upsertUser(
  client: PoolClient,
  u: { email: string; name: string; passwordHash: string; locale?: string },
): Promise<string> {
  const found = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1::text', [u.email]);
  let id = found.rows[0]?.id;
  if (!id) {
    id = randomUUID();
    await client.query(
      `INSERT INTO users (id, email, name, locale, email_verified_at) VALUES ($1,$2::text,$3,$4, now())`,
      [id, u.email, u.name, u.locale ?? 'en'],
    );
  }
  await client.query(
    `INSERT INTO auth.user_credentials (user_id, password_hash, password_changed_at) VALUES ($1,$2, now())
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
    [id, u.passwordHash],
  );
  return id;
}

/** Adds (or creates) a user as a member of a workspace with a built-in role. Dev and demo seeding. */
export async function addMember(
  pool: Pool,
  tenantId: string,
  roleKey: string,
  user: { email: string; name: string; passwordHash: string },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await client.query<{ id: string }>('SELECT id FROM roles WHERE tenant_id = $1 AND key = $2', [
      tenantId,
      roleKey,
    ]);
    const roleId = role.rows[0]?.id;
    if (!roleId) throw new Error(`unknown role ${roleKey}`);
    const userId = await upsertUser(client, user);
    await client.query(
      `INSERT INTO memberships (tenant_id, user_id, role_id, joined_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = 'active'`,
      [tenantId, userId, roleId],
    );
    await client.query('COMMIT');
    return userId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
