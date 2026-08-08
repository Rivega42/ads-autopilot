import { Redis } from 'ioredis';

import { env } from '../env.js';

/**
 * BullMQ требует maxRetriesPerRequest: null — иначе блокирующие команды
 * (BRPOPLPUSH в воркерах) падают по таймауту.
 *
 * Соединение не создаётся на импорте модуля: очереди инстанцируются лениво,
 * и процессу без очередей (боту, HTTP-серверу) незачем держать сокет к Redis.
 */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}
