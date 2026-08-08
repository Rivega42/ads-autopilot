export interface MetricTotals {
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: number;
  readonly conversions: number;
}

export const EMPTY_TOTALS: MetricTotals = {
  impressions: 0,
  clicks: 0,
  spend: 0,
  conversions: 0,
};

export function addTotals(left: MetricTotals, right: MetricTotals): MetricTotals {
  return {
    impressions: left.impressions + right.impressions,
    clicks: left.clicks + right.clicks,
    spend: left.spend + right.spend,
    conversions: left.conversions + right.conversions,
  };
}

/**
 * Стоимость конверсии.
 *
 * Ноль конверсий — это «неизвестно», а не «ноль рублей» и не бесконечность:
 * деление вернуло бы `Infinity`, а подстановка нуля соврала бы, что кампания
 * приводит лиды даром. Наверх уходит `null`, интерфейс рисует прочерк.
 */
export function cpa(spend: number, conversions: number): number | null {
  if (conversions <= 0 || !Number.isFinite(spend) || !Number.isFinite(conversions)) return null;
  return spend / conversions;
}

/** Доля кликов к показам, 0..1. Без показов — `null`, а не ноль. */
export function ctr(clicks: number, impressions: number): number | null {
  if (impressions <= 0) return null;
  return clicks / impressions;
}

/** Цена клика. Без кликов — `null`. */
export function cpc(spend: number, clicks: number): number | null {
  if (clicks <= 0) return null;
  return spend / clicks;
}

/** Насколько CPA отклонился от целевого: > 0 — дороже цели. */
export function cpaDeviation(actual: number | null, target: number | null): number | null {
  if (actual === null || target === null || target <= 0) return null;
  return actual / target - 1;
}
