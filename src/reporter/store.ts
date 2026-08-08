import type { Prisma, ReportKind } from '@prisma/client';

import { ymdToDateColumn } from '@/ingestion/window.js';
import type { ReporterDb } from '@/reporter/deps.js';
import type { Markdown } from '@/reporter/markdown.js';
import { mdRaw } from '@/reporter/markdown.js';
import type { ReportPeriod } from '@/reporter/period.js';

/**
 * Хранение отчётов.
 *
 * Порядок «сначала записать, потом отправить» — не стилистика: недельный разбор
 * стоит денег в LLM, и падение Telegram не должно его сжигать. У `Report` есть
 * `@@unique([clientId, kind, periodFrom, periodTo])`, поэтому повторный прогон
 * за тот же период обновляет строку, а не добавляет вторую.
 *
 * `sentAt` в `update` не трогаем: отправленный отчёт остаётся отправленным,
 * даже если тело пересчитали.
 */

export interface StoredReport {
  id: string;
  body: Markdown;
  sentAt: Date | null;
  /** true — строка уже была в БД до этого вызова. */
  reused: boolean;
}

export type ReportMetrics = Prisma.InputJsonObject;

/**
 * Прогон значения через JSON: в метриках попадаются `undefined` и `Decimal`,
 * на которых Prisma падает уже в рантайме.
 */
export function toJsonObject(value: Record<string, unknown>): ReportMetrics {
  return JSON.parse(JSON.stringify(value)) as ReportMetrics;
}

function periodKey(
  clientId: string,
  kind: ReportKind,
  period: ReportPeriod,
): Prisma.ReportClientIdKindPeriodFromPeriodToCompoundUniqueInput {
  return {
    clientId,
    kind,
    periodFrom: ymdToDateColumn(period.from),
    periodTo: ymdToDateColumn(period.to),
  };
}

export async function findReport(
  db: ReporterDb,
  clientId: string,
  kind: ReportKind,
  period: ReportPeriod,
): Promise<StoredReport | null> {
  const row = await db.report.findUnique({
    where: { clientId_kind_periodFrom_periodTo: periodKey(clientId, kind, period) },
    select: { id: true, body: true, sentAt: true },
  });
  return row ? { id: row.id, body: mdRaw(row.body), sentAt: row.sentAt, reused: true } : null;
}

export async function saveReport(
  db: ReporterDb,
  input: {
    clientId: string;
    kind: ReportKind;
    period: ReportPeriod;
    body: Markdown;
    metrics: ReportMetrics;
  },
): Promise<StoredReport> {
  const key = periodKey(input.clientId, input.kind, input.period);
  const row = await db.report.upsert({
    where: { clientId_kind_periodFrom_periodTo: key },
    create: { ...key, body: input.body, metrics: input.metrics },
    update: { body: input.body, metrics: input.metrics },
    select: { id: true, body: true, sentAt: true },
  });
  return { id: row.id, body: mdRaw(row.body), sentAt: row.sentAt, reused: false };
}

export async function markReportSent(db: ReporterDb, id: string, at: Date): Promise<void> {
  await db.report.update({ where: { id }, data: { sentAt: at }, select: { id: true } });
}
