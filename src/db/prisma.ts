import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { env } from '../env.js';
import { logger } from '../logger.js';

const log = logger.child({ scope: 'db' });

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Клиент с логом, который идёт через Pino, а не мимо него.
 *
 * `log: ['error']` — это `emit: 'stdout'`: Prisma печатает многострочный дамп
 * через `console.error` сама, в обход `LOG_LEVEL` и настроек редактирования
 * (CLAUDE.md §9). Человек, запустивший команду руками, получал этот дамп поверх
 * сводки, а крон и воркер — в своих логах, и отличить его от нашей ошибки было
 * нечем: ни scope, ни структуры.
 *
 * `emit: 'event'` не гасит ничего: каждое сообщение доезжает до Pino тем же
 * уровнем. Меняется только то, что теперь им распоряжается `LOG_LEVEL`.
 * Ожидаемые отказы гасятся не здесь, а в месте, где они ожидаются: см.
 * `createPrismaIdempotencyStore` в `src/optimizer/runtime.ts` — там дубль ключа
 * перестал быть ошибкой вовсе.
 */
function createPrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  const client = new PrismaClient({
    adapter,
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  client.$on('warn', (event) => log.warn({ target: event.target }, event.message));
  client.$on('error', (event) => log.error({ target: event.target }, event.message));

  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
