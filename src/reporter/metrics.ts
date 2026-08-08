import { StatEntityType, type Provider } from '@prisma/client';

import type { ReporterDb } from '@/reporter/deps.js';
import { divideOrNull, pctChangeOrNull, toNumber } from '@/reporter/math.js';
import { eachDay, periodFilter, type ReportPeriod } from '@/reporter/period.js';

/**
 * Агрегация `CampaignStat` за период.
 *
 * Считаем в приложении, а не в `groupBy`: те же строки нужны сразу в трёх видах
 * — итог по клиенту, разрез по кампаниям и ряд по дням для графика и поиска
 * аномалий. Три запроса с агрегацией на стороне Postgres дали бы три прохода по
 * одному и тому же диапазону.
 *
 * `CampaignStat` полиморфна: строки уровня кампании отбираются по
 * `entityType = CAMPAIGN`, а `entityId` — это внутренний `Campaign.id`, не
 * идентификатор площадки.
 */

export interface MetricTotals {
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
  /** Все производные — `null`, если знаменатель нулевой. */
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
}

export interface CampaignMetrics extends MetricTotals {
  campaignId: string;
  name: string;
  provider: Provider;
  /** Целевой CPA из карточки кампании, ₽. */
  targetCpa: number | null;
}

export interface DailyPoint {
  date: string;
  spend: number;
  conversions: number;
  clicks: number;
  impressions: number;
}

export interface PeriodMetrics {
  clientId: string;
  period: ReportPeriod;
  totals: MetricTotals;
  campaigns: CampaignMetrics[];
  /** По одной точке на каждый день периода, включая дни без открутки. */
  byDate: DailyPoint[];
}

export function emptyTotals(): MetricTotals {
  return { impressions: 0, clicks: 0, conversions: 0, spend: 0, ctr: null, cpc: null, cpa: null };
}

interface Accumulator {
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

function emptyAccumulator(): Accumulator {
  return { impressions: 0, clicks: 0, conversions: 0, spend: 0 };
}

function derive(acc: Accumulator): MetricTotals {
  return {
    ...acc,
    ctr: divideOrNull(acc.clicks, acc.impressions),
    cpc: divideOrNull(acc.spend, acc.clicks),
    cpa: divideOrNull(acc.spend, acc.conversions),
  };
}

export async function collectPeriodMetrics(
  db: ReporterDb,
  clientId: string,
  period: ReportPeriod,
): Promise<PeriodMetrics> {
  const campaigns = await db.campaign.findMany({
    where: { clientId },
    select: { id: true, name: true, provider: true, targetCpa: true },
    orderBy: { name: 'asc' },
  });

  const byCampaign = new Map<string, Accumulator>();
  const byDate = new Map<string, Accumulator>();
  const total = emptyAccumulator();

  if (campaigns.length > 0) {
    const stats = await db.campaignStat.findMany({
      where: {
        entityType: StatEntityType.CAMPAIGN,
        entityId: { in: campaigns.map((c) => c.id) },
        date: periodFilter(period),
      },
      select: {
        entityId: true,
        date: true,
        impressions: true,
        clicks: true,
        conversions: true,
        spend: true,
      },
    });

    for (const row of stats) {
      const spend = toNumber(row.spend);
      const day = row.date.toISOString().slice(0, 10);
      for (const acc of [
        byCampaign.get(row.entityId) ?? setAndGet(byCampaign, row.entityId),
        byDate.get(day) ?? setAndGet(byDate, day),
        total,
      ]) {
        acc.impressions += row.impressions;
        acc.clicks += row.clicks;
        acc.conversions += row.conversions;
        acc.spend += spend;
      }
    }
  }

  return {
    clientId,
    period,
    totals: derive(total),
    campaigns: campaigns.map((campaign) => ({
      campaignId: campaign.id,
      name: campaign.name,
      provider: campaign.provider,
      targetCpa: campaign.targetCpa === null ? null : toNumber(campaign.targetCpa),
      ...derive(byCampaign.get(campaign.id) ?? emptyAccumulator()),
    })),
    byDate: eachDay(period).map((date) => ({
      date,
      ...(byDate.get(date) ?? emptyAccumulator()),
    })),
  };
}

function setAndGet(store: Map<string, Accumulator>, key: string): Accumulator {
  const acc = emptyAccumulator();
  store.set(key, acc);
  return acc;
}

/** Кампании, которые вообще откручивались. Остальные в отчёте — шум. */
export function activeCampaigns(metrics: PeriodMetrics): CampaignMetrics[] {
  return metrics.campaigns.filter((c) => c.spend > 0 || c.impressions > 0 || c.conversions > 0);
}

export function bySpendDesc(campaigns: readonly CampaignMetrics[]): CampaignMetrics[] {
  return [...campaigns].sort((a, b) => b.spend - a.spend);
}

export interface MetricDelta {
  current: number;
  previous: number;
  /** `null`, если базы не было: рост с нуля процентом не выражается. */
  changePct: number | null;
}

export function delta(current: number, previous: number): MetricDelta {
  return { current, previous, changePct: pctChangeOrNull(current, previous) };
}

export interface TotalsComparison {
  spend: MetricDelta;
  conversions: MetricDelta;
  clicks: MetricDelta;
  impressions: MetricDelta;
  /** CPA сравниваем только когда он посчитан с обеих сторон. */
  cpa: { current: number | null; previous: number | null; changePct: number | null };
}

export function compareTotals(current: MetricTotals, previous: MetricTotals): TotalsComparison {
  return {
    spend: delta(current.spend, previous.spend),
    conversions: delta(current.conversions, previous.conversions),
    clicks: delta(current.clicks, previous.clicks),
    impressions: delta(current.impressions, previous.impressions),
    cpa: {
      current: current.cpa,
      previous: previous.cpa,
      changePct:
        current.cpa === null || previous.cpa === null
          ? null
          : pctChangeOrNull(current.cpa, previous.cpa),
    },
  };
}

/** Индекс «кампания → метрики» для сопоставления двух периодов. */
export function indexByCampaign(metrics: PeriodMetrics): Map<string, CampaignMetrics> {
  return new Map(metrics.campaigns.map((c) => [c.campaignId, c]));
}
