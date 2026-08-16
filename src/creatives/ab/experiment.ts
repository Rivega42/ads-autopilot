import { StatEntityType, type PrismaClient } from '@prisma/client';

import { selectWinner, type AbDecision, type AbTestConfig, type VariantCounts } from './select.js';

import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:ab' });

/**
 * A/B-тест поверх реальной статистики.
 *
 * Показы и клики лежат в полиморфной `CampaignStat` (`entityType = AD`), а принадлежность
 * объявления к варианту — в `Ad.llmVariant`. Один вариант обычно живёт в нескольких
 * объявлениях (три группы — три копии текста), поэтому счётчики сначала складываются
 * по варианту и только потом идут в статистику: сравнивать надо тексты, а не строки Ad.
 */

export type ExperimentStore = Pick<PrismaClient, 'ad' | 'campaignStat'>;

const DAY_MS = 24 * 60 * 60 * 1_000;

function experimentAgeDays(
  ads: ReadonlyArray<{ createdAt?: Date | null }>,
  to: Date,
): number | null {
  let oldest: number | null = null;
  for (const ad of ads) {
    const created = ad.createdAt?.getTime();
    if (created === undefined || Number.isNaN(created)) continue;
    if (oldest === null || created < oldest) oldest = created;
  }
  return oldest === null ? null : Math.max(0, (to.getTime() - oldest) / DAY_MS);
}

export interface AdExperimentOptions {
  /** Окно наблюдения включительно. */
  from: Date;
  to: Date;
  db: ExperimentStore;
  config?: AbTestConfig;
}

export interface AdExperiment {
  adGroupId: string;
  decision: AbDecision;
  /** Объявления, стоящие за каждым вариантом: победителя оставляем, остальные — на паузу. */
  adsByVariant: Map<string, string[]>;
  /** Объявления без статистики за окно. Не ошибка: могли быть созданы вчера. */
  adsWithoutStats: string[];
}

/**
 * Собирает счётчики по вариантам одной группы и выносит решение.
 *
 * Объявление без `llmVariant` (создано вручную или загружено из кабинета) участвует
 * как отдельный вариант со своим id: выкинуть его нельзя — оно тоже забирает показы,
 * и сравнение без него было бы сравнением не с тем, что реально крутится.
 */
export async function evaluateAdExperiment(
  adGroupId: string,
  opts: AdExperimentOptions,
): Promise<AdExperiment> {
  const ads = await opts.db.ad.findMany({
    where: { adGroupId },
    select: { id: true, llmVariant: true, createdAt: true },
  });

  const adsByVariant = new Map<string, string[]>();
  const variantByAd = new Map<string, string>();
  for (const ad of ads) {
    const variantId = ad.llmVariant ?? `ad:${ad.id}`;
    variantByAd.set(ad.id, variantId);
    const bucket = adsByVariant.get(variantId);
    if (bucket) bucket.push(ad.id);
    else adsByVariant.set(variantId, [ad.id]);
  }

  const stats =
    ads.length === 0
      ? []
      : await opts.db.campaignStat.findMany({
          where: {
            entityType: StatEntityType.AD,
            entityId: { in: ads.map((ad) => ad.id) },
            date: { gte: opts.from, lte: opts.to },
          },
          select: { entityId: true, impressions: true, clicks: true },
        });

  const totals = new Map<string, VariantCounts>();
  const seenAds = new Set<string>();
  for (const variantId of adsByVariant.keys()) {
    totals.set(variantId, { variantId, impressions: 0, clicks: 0 });
  }

  for (const row of stats) {
    const variantId = variantByAd.get(row.entityId);
    if (variantId === undefined) continue;
    seenAds.add(row.entityId);
    const bucket = totals.get(variantId);
    if (bucket === undefined) continue;
    bucket.impressions += row.impressions;
    bucket.clicks += row.clicks;
  }

  // Возраст эксперимента — от самого старого объявления группы: тест начался тогда,
  // когда появился первый вариант. Окно наблюдения для этого не годится: его выбирает
  // вызывающий, и «последние 7 дней» ничего не говорят о том, сколько тест уже идёт.
  const elapsedDays = experimentAgeDays(ads, opts.to);

  const decision = selectWinner(
    [...totals.values()],
    opts.config,
    elapsedDays === null ? {} : { elapsedDays },
  );

  log.info(
    {
      adGroupId,
      variants: totals.size,
      status: decision.status,
      winner: decision.winner,
      reasonCode: decision.reasonCode,
    },
    'creative A/B evaluated',
  );

  return {
    adGroupId,
    decision,
    adsByVariant,
    adsWithoutStats: ads.map((ad) => ad.id).filter((id) => !seenAds.has(id)),
  };
}
