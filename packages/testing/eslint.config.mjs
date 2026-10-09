import config from '@sc/config/eslint';

// Test helpers start throwaway Postgres containers, so they may import pg.
export default [...config, { rules: { 'no-restricted-imports': 'off' } }];
