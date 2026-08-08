import type { DateRange, StatLevel, StatRow } from '@/channels/types.js';
import { chunk, VK_BATCH_LIMIT, VK_PATHS, type VkEntityPath } from '@/clients/vk/entities.js';
import type { VkHttpClient } from '@/clients/vk/http.js';
import { toNumber, vkStatsResponseSchema } from '@/clients/vk/schemas.js';
import { ymdMsk } from '@/lib/dates.js';
import { scoped } from '@/logger.js';

const log = scoped('vk:stats');

export type VkGranularity = 'day' | 'summary';

/** Дневная детализация доступна только за последние 365 дней — глубже VK отдаёт пусто. */
export const VK_STATS_MAX_DAYS = 365;

/** У VK нет уровня ключевых слов: ставка живёт на группе, семантики нет вовсе. */
export function statLevelToPath(level: StatLevel): VkEntityPath | null {
  switch (level) {
    case 'campaign':
      return VK_PATHS.adPlans;
    case 'adgroup':
      return VK_PATHS.adGroups;
    case 'ad':
      return VK_PATHS.banners;
    case 'keyword':
      return null;
  }
}

/**
 * Поджимает начало периода к границе 365 дней.
 * Молча отдать пустоту за более ранние даты — худший вариант: отчёт получится
 * «нулевым», а не «частичным», и это никто не заметит.
 */
export function clampStatsRange(range: DateRange, now: Date = new Date()): DateRange {
  const earliestMs = now.getTime() - VK_STATS_MAX_DAYS * 24 * 60 * 60 * 1000;
  const earliest = ymdMsk(new Date(earliestMs));
  if (range.from >= earliest) return range;
  log.warn({ requested: range.from, clampedTo: earliest }, 'vk stats range clamped to 365 days');
  return { from: earliest, to: range.to };
}

/**
 * Строка статистики «как пришла»: схема пропускает лишние ключи, поэтому
 * маппер работает с расширяемой формой, а не только с результатом zod.
 */
export interface VkStatRowLike {
  date?: string | undefined;
  base?: Record<string, unknown> | undefined;
  [key: string]: unknown;
}

/**
 * Метрики приходят либо в `row.base`, либо плоско в самой строке (так бывает
 * у `summary` и в части ответов `day`). Читаем оба варианта.
 */
function metric(row: VkStatRowLike, name: 'shows' | 'clicks' | 'spent' | 'goals'): number {
  const base = row.base;
  if (base && base[name] !== undefined) return toNumber(base[name]);
  return toNumber(row[name]);
}

/** Ответ VK → общий StatRow. Строки без даты (summary) получают `fallbackDate`. */
export function mapStatsResponse(
  response: { items: Array<{ id: string; rows: VkStatRowLike[] }> },
  fallbackDate: string,
): StatRow[] {
  const out: StatRow[] = [];
  for (const item of response.items) {
    for (const row of item.rows) {
      out.push({
        date: row.date ?? fallbackDate,
        entityExternalId: item.id,
        impressions: metric(row, 'shows'),
        clicks: metric(row, 'clicks'),
        cost: metric(row, 'spent'),
        conversions: metric(row, 'goals'),
      });
    }
  }
  return out;
}

export interface VkStatsQuery {
  objectType: VkEntityPath;
  ids: readonly string[];
  range: DateRange;
  granularity?: VkGranularity;
  now?: Date;
}

/**
 * Статистика по списку объектов.
 * Батчи по 200: столько же, сколько на чтении сущностей, лимит общий.
 */
export async function fetchVkStats(http: VkHttpClient, query: VkStatsQuery): Promise<StatRow[]> {
  const granularity = query.granularity ?? 'day';
  const range = granularity === 'day' ? clampStatsRange(query.range, query.now) : query.range;
  const unique = [...new Set(query.ids)];
  if (unique.length === 0) return [];

  const out: StatRow[] = [];
  for (const batch of chunk(unique, VK_BATCH_LIMIT)) {
    const res = await http.request({
      method: 'GET',
      /**
       * @needs-live-token: батчевая форма `statistics/{object_type}/{granularity}.json?id=1,2,3`.
       * ТЗ §2.2 документирует поштучную `/statistics/{object_type}/{id}/{granularity}.json`;
       * батч выбран потому, что поштучный путь означал бы 200 запросов на одну
       * выгрузку и мгновенный расход дневного лимита. Если ads.vk.ru ответит
       * 404/400 — вернуться к поштучной форме, сохранив нарезку по 200.
       */
      url: `statistics/${query.objectType}/${granularity}.json`,
      schema: vkStatsResponseSchema,
      params: {
        id: batch.join(','),
        date_from: range.from,
        date_to: range.to,
        metrics: 'base',
      },
      label: `stats ${query.objectType}/${granularity}`,
    });
    out.push(...mapStatsResponse(res, range.to));
  }
  return out;
}
