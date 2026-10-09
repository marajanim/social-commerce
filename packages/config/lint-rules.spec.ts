import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Lints a snippet as if it lived at `file`, using that package's own ESLint config. */
async function lint(file: string, code: string): Promise<string[]> {
  const abs = path.join(root, file);
  const eslint = new ESLint({ cwd: path.dirname(path.join(root, file.split('/').slice(0, 2).join('/'), 'x')) });
  const [result] = await eslint.lintText(code, { filePath: abs });
  return (result?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`);
}

describe('raw database client ban', () => {
  it.each(['pg', 'drizzle-orm/node-postgres', 'postgres'])('rejects importing %s in apps/api', async (mod) => {
    const msgs = await lint('apps/api/src/x.ts', `import x from '${mod}';\nexport default x;\n`);
    expect(msgs.join('\n')).toMatch(/no-restricted-imports/);
  });

  it('rejects importing pg in the worker and web apps too', async () => {
    for (const file of ['apps/worker/src/x.ts', 'apps/web/app/x.ts']) {
      const msgs = await lint(file, `import { Pool } from 'pg';\nexport const p = Pool;\n`);
      expect(msgs.join('\n'), file).toMatch(/no-restricted-imports/);
    }
  });

  it('allows packages/db to import pg', async () => {
    const msgs = await lint('packages/db/src/x.ts', `import { Pool } from 'pg';\nexport const p = Pool;\n`);
    expect(msgs).toEqual([]);
  });
});

describe('tenant context ban', () => {
  const cases: Record<string, string> = {
    'set_config in a string': `export const q = "SELECT set_config('app.tenant_id', 'x', false)";\n`,
    'set_config in a template': 'export const q = `SELECT set_config(${1})`;\n',
    'session SET app.*': `export const q = "SET app.tenant_id = 'x'";\n`,
    'SET SESSION app.*': `export const q = "SET SESSION app.tenant_id = 'x'";\n`,
    'lowercase set app.*': 'export const q = `set app.user_id = 1`;\n',
  };

  it.each(Object.entries(cases))('rejects %s outside tenantDb', async (_name, code) => {
    const msgs = await lint('apps/api/src/x.ts', code);
    expect(msgs.join('\n')).toMatch(/no-restricted-syntax/);
  });

  it('rejects them elsewhere in packages/db, allows them in tenant-db.ts', async () => {
    const code = `export const q = "SELECT set_config('app.tenant_id', 'x', true)";\n`;
    expect((await lint('packages/db/src/other.ts', code)).join()).toMatch(/no-restricted-syntax/);
    expect(await lint('packages/db/src/tenant-db.ts', code)).toEqual([]);
  });

  it('does not flag ordinary code', async () => {
    const msgs = await lint('apps/api/src/x.ts', `export const q = "SELECT current_setting('app.tenant_id', true)";\n`);
    expect(msgs).toEqual([]);
  });
});
