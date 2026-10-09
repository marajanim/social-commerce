import config from '@sc/config/eslint';

// packages/db is the one place allowed to import a raw client, and tenant-db.ts the one file
// allowed to call set_config.
export default [
  ...config,
  { rules: { 'no-restricted-imports': 'off' } },
  { files: ['src/tenant-db.ts'], rules: { 'no-restricted-syntax': 'off' } },
];
