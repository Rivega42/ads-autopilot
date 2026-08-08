import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Дашборд читает ту же БД тем же клиентом Prisma, что и бэкенд: своей схемы у
 * него нет. `@prisma/client`, `@prisma/adapter-pg` и `pg` намеренно не
 * объявлены в `web/package.json` — сгенерированный клиент лежит в экземпляре
 * пакета, который резолвится от корня воркспейса, и отдельная копия в
 * `web/node_modules` оказалась бы пустой (см. `web/prisma.config.ts`).
 *
 * Клиент создаётся лениво: `next build` импортирует модули страниц, и жадное
 * подключение потребовало бы живой БД на сборке.
 */
const globalForPrisma = globalThis as unknown as { dashboardPrisma?: PrismaClient };

export function getPrisma(): PrismaClient {
  const cached = globalForPrisma.dashboardPrisma;
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL не задан — дашборду нечего читать. См. .env.example.');
  }

  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: ['error'],
  });
  globalForPrisma.dashboardPrisma = client;
  return client;
}
