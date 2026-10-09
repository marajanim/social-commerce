import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

export interface TestPostgres {
  /** Superuser connection string. Tests create their own roles for RLS checks. */
  url: string;
  pool: Pool;
  stop(): Promise<void>;
}

/** Real Postgres 16 with pgvector, the same image as `pnpm infra:up`. Never mock the database. */
export async function startPostgres(): Promise<TestPostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'pgvector/pgvector:pg16',
  ).start();
  const url = container.getConnectionUri();
  const pool = new Pool({ connectionString: url });
  return {
    url,
    pool,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
