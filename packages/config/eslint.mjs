import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Raw database clients. Only packages/db (and packages/testing, which starts throwaway
// containers) may import them; everyone else goes through tenantDb().
export const RAW_DB_CLIENTS = ['pg', 'pg/*', 'postgres', 'drizzle-orm/node-postgres', 'drizzle-orm/postgres-js'];

const noRawDbClient = {
  'no-restricted-imports': [
    'error',
    {
      paths: RAW_DB_CLIENTS.filter((p) => !p.includes('*')).map((name) => ({
        name,
        message: 'Use tenantDb() from @sc/db. Only packages/db may import a raw database client.',
      })),
      patterns: [{ group: ['pg/*'], message: 'Use tenantDb() from @sc/db.' }],
    },
  ],
};

// Tenant context is set only inside tenantDb(), with a transaction-local set_config.
// A session-level SET survives the transaction and leaks tenant context across pooled requests.
const TENANT_CONTEXT_MESSAGE =
  'set_config and SET app.* are allowed only in packages/db/src/tenant-db.ts (transaction-local).';
const noTenantContextSql = {
  'no-restricted-syntax': [
    'error',
    { selector: 'Literal[value=/set_config/i]', message: TENANT_CONTEXT_MESSAGE },
    { selector: 'TemplateElement[value.raw=/set_config/i]', message: TENANT_CONTEXT_MESSAGE },
    { selector: 'Literal[value=/\\bset\\s+(session\\s+|local\\s+)?app\\./i]', message: TENANT_CONTEXT_MESSAGE },
    {
      selector: 'TemplateElement[value.raw=/\\bset\\s+(session\\s+|local\\s+)?app\\./i]',
      message: TENANT_CONTEXT_MESSAGE,
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/**', 'dist-test/**', '.next/**', 'node_modules/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      ...noRawDbClient,
      ...noTenantContextSql,
    },
  },
  // Plain JS config files (next.config.mjs and friends) run in Node.
  { files: ['**/*.mjs', '**/*.cjs'], languageOptions: { globals: { process: 'readonly' } } },
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
