import { ConversionSource, StatEntityType, type PrismaClient } from '@prisma/client';

import type { DateRange } from '@/channels/types.js';
import { ymdToDateColumn } from '@/ingestion/window.js';

/**
 * Кто посчитал конверсии в строке `CampaignStat`.
 *
 * Колонка `conversions` одна, а моделей атрибуции две: своя у рекламной площадки
 * и своя у Метрики. Раньше это различие держалось на порядке шагов загрузки
 * (сначала статистика, потом Метрика поверх) — то есть ни на чём: стоило шагу
 * Метрики упасть или счётчику отключиться, и в одной колонке оказывались обе
 * модели, а CPA соседних кампаний становился несопоставимым молча.
 *
 * Здесь этот признак становится проверяемым: каждая запись объявляет источник, а
 * `summarizeConversionSources` показывает, что у клиента реально лежит в базе.
 */

/**
 * Модели, которые что-то утверждают о конверсиях. `NONE` в список не входит:
 * «цифры нет» — это не третья модель атрибуции, и смешением не считается.
 */
const ATTRIBUTION_MODELS: readonly ConversionSource[] = [
  ConversionSource.PLATFORM,
  ConversionSource.METRIKA,
];

/**
 * Источник для строки, записанной по отчёту самой площадки.
 *
 * `PLATFORM` здесь — «атрибуция рекламного кабинета» (у Директа своя, у VK своя),
 * а не только Яндекс Директ: в схеме под все площадки один литерал.
 *
 * `NONE` достаётся строке, в которой цифры конверсий нет вовсе. Отсутствие
 * значения и измеренный ноль — разные вещи: записав первое как ноль, мы бы
 * сообщили оптимизатору, что кампания не приносит заявок, хотя её просто не
 * измеряли.
 */
export function platformConversionSource(conversions: number | null | undefined): ConversionSource {
  return typeof conversions === 'number' && Number.isFinite(conversions)
    ? ConversionSource.PLATFORM
    : ConversionSource.NONE;
}

export interface AttributionSummary {
  /** Сколько строк за каждым источником. */
  counts: Record<ConversionSource, number>;
  /** Присутствующие модели атрибуции, без `NONE`. */
  models: ConversionSource[];
  /** true — в выборке больше одной модели: CPA этих строк между собой несопоставим. */
  mixed: boolean;
  /** Единственная модель выборки; `null`, если моделей ноль или больше одной. */
  primary: ConversionSource | null;
}

export function emptyAttribution(): AttributionSummary {
  return {
    counts: {
      [ConversionSource.PLATFORM]: 0,
      [ConversionSource.METRIKA]: 0,
      [ConversionSource.NONE]: 0,
    },
    models: [],
    mixed: false,
    primary: null,
  };
}

export function summarizeConversionSources(
  rows: Iterable<{ conversionSource: ConversionSource }>,
): AttributionSummary {
  const summary = emptyAttribution();
  for (const row of rows) summary.counts[row.conversionSource] += 1;

  summary.models = ATTRIBUTION_MODELS.filter((model) => summary.counts[model] > 0);
  summary.mixed = summary.models.length > 1;
  summary.primary = summary.models.length === 1 ? (summary.models[0] ?? null) : null;
  return summary;
}

export type AttributionStore = Pick<PrismaClient, 'campaignStat'>;

/**
 * Что лежит в базе у конкретного клиента за период.
 *
 * Только строки уровня кампании: Метрика перезаписывает конверсии именно на нём,
 * а у групп, объявлений и фраз конверсии остаются площадочными всегда. Считать
 * это смешением значило бы кричать на каждом клиенте с настроенной Метрикой.
 */
export async function auditConversionSources(
  db: AttributionStore,
  campaignIds: readonly string[],
  range: DateRange,
): Promise<AttributionSummary> {
  if (campaignIds.length === 0) return emptyAttribution();

  const rows = await db.campaignStat.findMany({
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: { in: [...campaignIds] },
      date: { gte: ymdToDateColumn(range.from), lte: ymdToDateColumn(range.to) },
    },
    select: { conversionSource: true },
  });

  return summarizeConversionSources(rows);
}
