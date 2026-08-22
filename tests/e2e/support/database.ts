import { prisma } from '@/db/prisma.js';

/**
 * Полная очистка схемы перед прогоном.
 *
 * Не `deleteMany` по списку моделей: список пришлось бы дописывать при каждой новой
 * таблице, и первый же забытый `IdempotencyKey` сделал бы сценарий зелёным по
 * ошибке — ключи прошлого прогона схлопнули бы решения этого.
 *
 * `_prisma_migrations` не трогаем: без неё `migrate deploy` накатит миграции второй раз.
 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
