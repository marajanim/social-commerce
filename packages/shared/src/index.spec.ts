import { describe, expect, it } from 'vitest';
import { healthResponse } from './index';

describe('healthResponse', () => {
  it('reports ok for the named service', () => {
    expect(healthResponse('api')).toEqual({ status: 'ok', service: 'api' });
  });
});
