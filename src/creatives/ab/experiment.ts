import { AdStatus, StatEntityType, type PrismaClient } from '@prisma/client';

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

export type ExperimentStore = Pick<PrismaClient, 'ad' | 'campaignStat' | 'changeLog'>;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Действия `ChangeLog`, после которых у строки Ad стал другой текст.
 *
 * Строка повторяет `REWRITE_ACTION` из `moderation/repair.ts` намеренно: тянуть в
 * модуль креативов весь граф модерации ради одной константы дороже, чем повторить её.
 * От расхождения страхует тест `experiment.test.ts`, он сверяет списки напрямую.
 */
export const TEXT_REWRITE_ACTIONS: readonly string[] = ['moderation_rewrite'];

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
  /**
   * Объявления без статистики за окно. На решение не влияют (без показов вариант не
   * добирает минимума и в сравнение не идёт), но по ним видно поломку сбора статистики:
   * объявление крутится в кабинете, а строк `CampaignStat` у него нет.
   */
  adsWithoutStats: string[];
  /** Исключённые из теста: текст переписан внутри окна, статистика смешана. */
  rewrittenAds: string[];
  /** Сколько дней идёт сравнение. null — ни один участник ещё не открутился. */
  experimentAgeDays: number | null;
}

/**
 * Собирает счётчики по вариантам одной группы и выносит решение.
 *
 * В эксперимент идут только объявления с `llmVariant` — то есть тексты, написанные нами.
 * Рукописное объявление клиента (и всё, что приехало через ingestion, TZ §15) вариантом
 * не считается: предлагать человеку выключить объявление, которого мы не писали и о
 * котором ничего не знаем, система права не имеет.
 *
 * И только работающие: выключенное в кабинете объявление больше никого не обслуживает,
 * но его показы остаются в 30-дневном окне ещё месяц. Считая их, тест сравнивал бы
 * победителя с вариантом, которого в эфире уже нет, — и заодно каждую ночь предлагал бы
 * выключить то, что выключено.
 */
export async function evaluateAdExperiment(
  adGroupId: string,
  opts: AdExperimentOptions,
): Promise<AdExperiment> {
  const ads = await opts.db.ad.findMany({
    where: { adGroupId, llmVariant: { not: null }, status: AdStatus.ACTIVE },
    select: { id: true, llmVariant: true, title: true },
  });

  if (ads.length === 0) {
    return {
      adGroupId,
      decision: selectWinner([], opts.config),
      adsByVariant: new Map(),
      adsWithoutStats: [],
      rewrittenAds: [],
      experimentAgeDays: null,
    };
  }

  const adIds = ads.map((ad) => ad.id);
  const [rewrites, stats] = await Promise.all([
    opts.db.changeLog.findMany({
      where: {
        entityType: 'AD',
        entityId: { in: adIds },
        action: { in: [...TEXT_REWRITE_ACTIONS] },
        appliedAt: { gte: opts.from },
      },
      select: { entityId: true },
    }),
    opts.db.campaignStat.findMany({
      where: {
        entityType: StatEntityType.AD,
        entityId: { in: adIds },
        date: { gte: opts.from, lte: opts.to },
      },
      select: { entityId: true, impressions: true, clicks: true, date: true },
    }),
  ]);

  // Статистика привязана к `Ad.id`, а не к тексту: у переписанного объявления в одном
  // ряду лежат показы двух разных текстов, и новый вариант получил бы в наследство
  // поведение старого. Разделить их нечем — значит такое объявление в тест не идёт.
  const rewritten = new Set(rewrites.map((row) => row.entityId));

  const adsByVariant = new Map<string, string[]>();
  const variantByAd = new Map<string, string>();
  const labelByVariant = new Map<string, string>();
  for (const ad of ads) {
    if (ad.llmVariant === null || rewritten.has(ad.id)) continue;
    const variantId = ad.llmVariant;
    variantByAd.set(ad.id, variantId);
    if (!labelByVariant.has(variantId)) labelByVariant.set(variantId, ad.title);
    const bucket = adsByVariant.get(variantId);
    if (bucket) bucket.push(ad.id);
    else adsByVariant.set(variantId, [ad.id]);
  }

  const totals = new Map<string, VariantCounts>();
  const startedAt = new Map<string, number>();
  const seenAds = new Set<string>();
  for (const [variantId, label] of labelByVariant) {
    totals.set(variantId, { variantId, label, impressions: 0, clicks: 0 });
  }

  for (const row of stats) {
    const variantId = variantByAd.get(row.entityId);
    if (variantId === undefined) continue;
    seenAds.add(row.entityId);
    const bucket = totals.get(variantId);
    if (bucket === undefined) continue;
    bucket.impressions += row.impressions;
    bucket.clicks += row.clicks;

    const day = row.date?.getTime();
    if (day === undefined || Number.isNaN(day)) continue;
    const first = startedAt.get(variantId);
    if (first === undefined || day < first) startedAt.set(variantId, day);
  }

  const elapsedDays = experimentAgeDays(startedAt, opts.to);

  const decision = selectWinner(
    [...totals.values()],
    opts.config,
    elapsedDays === null ? {} : { elapsedDays },
  );

  log.debug(
    {
      adGroupId,
      variants: totals.size,
      status: decision.status,
      winner: decision.winner,
      reasonCode: decision.reasonCode,
      elapsedDays,
      rewritten: rewritten.size,
    },
    'creative A/B evaluated',
  );

  return {
    adGroupId,
    decision,
    adsByVariant,
    adsWithoutStats: [...variantByAd.keys()].filter((id) => !seenAds.has(id)),
    rewrittenAds: ads.map((ad) => ad.id).filter((id) => rewritten.has(id)),
    experimentAgeDays: elapsedDays,
  };
}

/**
 * Возраст эксперимента — от первого показа самого молодого участника.
 *
 * Не от `Ad.createdAt`: добавили два варианта в группу годовой давности — и по возрасту
 * строки тест «просрочен» с рождения, а после ingestion там вообще дата импорта. Тест
 * начинается тогда, когда сравнение стало возможным, то есть когда открутился
 * последний из участников; до этого сравнивать было не с чем.
 *
 * Варианты, не открутившиеся ни разу, в расчёт не идут: иначе один так и не
 * запустившийся вариант держал бы срок на нуле вечно.
 */
function experimentAgeDays(startedAt: ReadonlyMap<string, number>, to: Date): number | null {
  let youngest: number | null = null;
  for (const started of startedAt.values()) {
    if (youngest === null || started > youngest) youngest = started;
  }
  return youngest === null ? null : Math.max(0, (to.getTime() - youngest) / DAY_MS);
}
