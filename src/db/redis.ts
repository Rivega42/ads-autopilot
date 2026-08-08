import { Redis } from 'ioredis';
import { env } from '@/config/index.js';

/**
 * BullMQ требует maxRetriesPerRequest: null — иначе блокирующие команды
 * (BRPOPLPUSH в воркерах) падают по таймауту.
 */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis = globalForRedis.redis ?? createRedis();

if (env.NODE_ENV !== 'production') globalForRedis.redis = redis;

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}
