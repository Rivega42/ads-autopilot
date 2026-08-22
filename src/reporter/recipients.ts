import { ClientStatus } from '@prisma/client';

import type { ReporterDb } from '@/reporter/deps.js';

/** Кому уходит отчёт: активный клиент и его личный чат с ботом. */
export interface ReportRecipient {
  clientId: string;
  name: string;
  chatId: string;
}

/**
 * `Client.tgUserId` — `BigInt`, а Telegram API ждёт строку или число. Через
 * строку: идентификаторы каналов не влезают в `number` без потери точности.
 */
export async function listReportRecipients(
  db: ReporterDb,
  clientId?: string,
): Promise<ReportRecipient[]> {
  const rows = await db.client.findMany({
    where: { status: ClientStatus.ACTIVE, ...(clientId ? { id: clientId } : {}) },
    select: { id: true, name: true, tgUserId: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => ({
    clientId: row.id,
    name: row.name,
    chatId: row.tgUserId.toString(),
  }));
}
