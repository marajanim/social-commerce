import { createServer, type Server } from 'node:http';
import { healthResponse } from '@sc/shared';

export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthResponse('worker')));
      return;
    }
    res.writeHead(404).end();
  });
}
