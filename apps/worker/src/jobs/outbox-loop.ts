import type { OutboxPublisher } from '@sc/db';

export interface Redisish {
  publish(channel: string, message: string): Promise<unknown>;
}

/**
 * Polls the outbox and publishes committed events to Redis pub/sub (`t:{tenantId}:events`).
 * Polling every 250 ms keeps events well inside the 1 s budget; it drains in a tight loop when behind.
 */
export function startOutboxLoop(options: {
  publisher: OutboxPublisher;
  redis: Redisish;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 250;
  let running = true;
  const publish = async (channel: string, message: string) => void (await options.redis.publish(channel, message));

  const loop = (async () => {
    while (running) {
      let more = false;
      try {
        more = (await options.publisher.publishOnce(publish, 100)) >= 100;
      } catch (err) {
        options.onError?.(err);
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (!more) await new Promise((r) => setTimeout(r, interval));
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
