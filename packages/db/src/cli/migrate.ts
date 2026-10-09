import { Pool } from 'pg';
import { ensureLoginRoles } from '../logins';
import { migrate } from '../migrate';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
    const app = process.env.APP_DB_PASSWORD;
    const auth = process.env.AUTH_DB_PASSWORD;
    if (app && auth) {
      const ready = await ensureLoginRoles(pool, {
        app,
        auth,
        outbox: process.env.OUTBOX_DB_PASSWORD,
        audit: process.env.AUDIT_DB_PASSWORD,
      });
      console.log(`Login roles ready: ${ready.join(', ')}`);
    } else {
      console.log('APP_DB_PASSWORD / AUTH_DB_PASSWORD not set: login roles left as they are');
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
