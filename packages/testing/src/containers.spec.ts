import { afterAll, beforeAll, expect, it } from 'vitest';
import { startPostgres, type TestPostgres } from './postgres';

let pg: TestPostgres;
beforeAll(async () => {
  pg = await startPostgres();
});
afterAll(() => pg?.stop());

it('boots a real Postgres 16 with pgvector available', async () => {
  const version = await pg.pool.query<{ server_version: string }>('SHOW server_version');
  expect(version.rows[0]?.server_version).toMatch(/^16\./);
  await pg.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  const ext = await pg.pool.query("SELECT 1 AS ok FROM pg_extension WHERE extname = 'vector'");
  expect(ext.rows).toHaveLength(1);
});
