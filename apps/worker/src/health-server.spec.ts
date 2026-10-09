import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHealthServer } from './health-server';

const server = createHealthServer();
let port = 0;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise((r) => server.close(r)));

it('GET /health returns ok', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', service: 'worker' });
});
