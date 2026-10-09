import { createHealthServer } from './health-server';

// Queue processors (inbound, outbound, ai, ...) are registered here in later tasks.
createHealthServer().listen(Number(process.env.WORKER_PORT ?? 4001), '0.0.0.0');
