import type { Pool } from 'pg';

export interface LoginPasswords {
  app: string;
  auth: string;
  outbox?: string;
  audit?: string;
  worker?: string;
}

/**
 * Creates (or re-keys) one login per process role and grants it the NOLOGIN role it acts as.
 * Passwords come from the environment, never from a migration. Run by `pnpm db:migrate`
 * after the migrations, as the owner. Roles whose password is not given are skipped.
 */
export async function ensureLoginRoles(pool: Pool, passwords: LoginPasswords): Promise<string[]> {
  const logins: [login: string, role: string, password: string | undefined][] = [
    ['app_login', 'app_user', passwords.app],
    ['auth_login', 'auth_user', passwords.auth],
    ['outbox_login', 'outbox_publisher', passwords.outbox],
    ['audit_login', 'audit_chainer', passwords.audit],
    ['worker_login', 'worker_user', passwords.worker],
  ];
  const ready: string[] = [];
  for (const [login, role, password] of logins) {
    if (!password) continue;
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [login]);
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    // login and role are constants above; format() quotes the identifier and the password literal.
    const built = await pool.query<{ q: string }>(
      `SELECT format('${verb} ROLE %I LOGIN PASSWORD %L NOBYPASSRLS', $1::text, $2::text) AS q`,
      [login, password],
    );
    const statement = built.rows[0]?.q;
    if (!statement) throw new Error('could not build the role statement');
    await pool.query(statement);
    if (!exists.rowCount) await pool.query(`GRANT ${role} TO ${login}`);
    ready.push(login);
  }
  return ready;
}
