import { prisma } from '@/db/prisma.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'scheduler.purge' });

/**
 * Чистка просроченных ключей идемпотентности.
 *
 * `IdempotencyKey.expiresAt` до этого крона был украшением: Postgres на колонку не
 * смотрит, чистки не было нигде, и «TTL 30 дней» на деле означало «навсегда» — вместе
 * с неограниченным ростом таблицы. Из двух способов сделать срок настоящим — удалять
 * просроченное или пропускать резервирование поверх просроченной строки — выбрано
 * удаление: оно чинит обе беды сразу, а второй способ оставляет таблицу расти вечно.
 *
 * Живёт на кроне экспирации заявок: он ходит каждые пять минут и уже занимается тем же
 * самым — доводит до конца то, у чего вышел срок. Отдельная очередь ради одного
 * `DELETE` не нужна.
 */
export async function purgeExpiredIdempotencyKeys(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } });
  if (count > 0) log.info({ purged: count }, 'expired idempotency keys purged');
  return count;
}
