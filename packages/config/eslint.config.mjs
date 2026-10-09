import config from './eslint.mjs';

// This package defines the SQL-string rule and tests it with offending snippets.
export default [...config, { rules: { 'no-restricted-syntax': 'off' } }];
