import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  const container: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();
  return { url: container.getConnectionUrl(), stop: async () => void (await container.stop()) };
}
