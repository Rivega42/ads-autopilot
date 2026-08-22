import { ClientStatus } from '@prisma/client';
import type { Context } from 'grammy';

import { prisma } from '@/db/prisma.js';

/**
 * Кто пишет в чат.
 *
 * Клиент опознаётся по `Client.tgUserId`, а не по chat_id: карточки апрува уходят
 * в личный чат, и это единственная связь между человеком в Telegram и строками
 * в базе. Клиент на паузе или в архиве не опознаётся вовсе — каждое обращение
 * дальше стоит денег (модель, а в случае запуска и бюджет кабинета).
 */
export async function findActiveClientId(ctx: Context): Promise<string | null> {
  const tgUserId = ctx.from?.id;
  if (tgUserId === undefined) return null;

  const client = await prisma.client.findUnique({
    where: { tgUserId: BigInt(tgUserId) },
    select: { id: true, status: true },
  });
  return client?.status === ClientStatus.ACTIVE ? client.id : null;
}
