import { Pool } from 'pg';
import { ROLE_KEYS } from '@sc/shared';
import { hashPassword } from '@sc/shared/password';
import { addMember, createWorkspaceWithOwner } from '../seed';

// Creates your workspace and Owner account (idempotent per slug). With SEED_DEMO=true it also adds
// one user per built-in role and a second workspace, for manual cross-tenant testing.
// Credentials come from the environment (see .env.example); nothing is printed except emails.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  const ownerEmail = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_PASSWORD;
  if (!url || !ownerEmail || !password) {
    throw new Error('DATABASE_URL, SEED_OWNER_EMAIL and SEED_PASSWORD must be set');
  }
  const slug = process.env.SEED_WORKSPACE_SLUG ?? 'my-shop';
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const exists = await pool.query<{ id: string }>('SELECT id FROM tenants WHERE slug = $1::text', [slug]);
    const passwordHash = await hashPassword(password);
    let tenantId = exists.rows[0]?.id;
    if (tenantId) {
      console.log(`Workspace "${slug}" already exists`);
    } else {
      const created = await createWorkspaceWithOwner(pool, {
        name: process.env.SEED_WORKSPACE_NAME ?? 'My Shop',
        slug,
        owner: { email: ownerEmail, name: process.env.SEED_OWNER_NAME ?? 'Shop Owner', passwordHash },
      });
      tenantId = created.tenantId;
      console.log(`Created workspace "${slug}" with owner ${ownerEmail}`);
    }

    if (process.env.SEED_DEMO === 'true') {
      for (const role of ROLE_KEYS.filter((r) => r !== 'owner')) {
        await addMember(pool, tenantId, role, {
          email: `${role.replace('_', '-')}@example.test`,
          name: `Demo ${role.replace('_', ' ')}`,
          passwordHash,
        });
      }
      const other = await pool.query('SELECT 1 FROM tenants WHERE slug = $1::text', ['demo-rival']);
      if (!other.rowCount) {
        await createWorkspaceWithOwner(pool, {
          name: 'Demo Rival Shop',
          slug: 'demo-rival',
          owner: { email: 'rival@example.test', name: 'Rival Owner', passwordHash },
        });
      }
      console.log('Demo users: admin@, supervisor@, agent@, order-manager@, analyst@, rival@example.test');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
