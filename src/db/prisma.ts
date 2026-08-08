import { PrismaClient } from '@prisma/client';
import { env } from '@/config/index.js';

/**
 * Единственный экземпляр на процесс. В dev tsx-watch перезапускает модуль,
 * поэтому кешируем в globalThis, иначе быстро упираемся в лимит соединений Postgres.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
