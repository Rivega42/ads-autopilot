import {
  AdGroupStatus,
  AdStatus,
  CampaignStatus,
  KeywordStatus,
  MatchType,
  type PrismaClient,
  type Provider,
} from '@prisma/client';

import type { ChannelAdapter, ChannelContext, RemoteAd, RemoteKeyword } from '@/channels/types.js';
import type { IngestionDeps } from '@/ingestion/deps.js';
import { resolveDeps } from '@/ingestion/deps.js';
import {
  MONEY_SCALE,
  strategyName,
  toAdFormat,
  toAdGroupStatus,
  toCampaignStatus,
  toDecimal,
  toJsonObject,
  toKeywordStatus,
  toModerationStatus,
} from '@/ingestion/mapping.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:entities' });

export interface LevelSyncCount {
  upserted: number;
  archived: number;
  /** Сущности, чей родитель не нашёлся в БД: их некуда положить. */
  orphaned: number;
}

export interface EntitySyncResult {
  clientId: string;
  provider: Provider;
  campaigns: LevelSyncCount;
  adGroups: LevelSyncCount;
  ads: LevelSyncCount;
  keywords: LevelSyncCount;
}

function emptyCount(): LevelSyncCount {
  return { upserted: 0, archived: 0, orphaned: 0 };
}

/**
 * Синхронизирует дерево сущностей кабинета в БД.
 *
 * Ничего не удаляет: пропавшая из кабинета сущность переводится в ARCHIVED,
 * потому что вместе со строкой ушла бы вся её история в `CampaignStat`, а
 * `ChangeLog` остался бы ссылаться в пустоту.
 *
 * Повторный прогон идемпотентен: все записи — upsert по естественным ключам схемы.
 */
export async function syncEntities(
  clientId: string,
  provider: Provider,
  partialDeps: Partial<IngestionDeps> = {},
): Promise<EntitySyncResult> {
  const deps = resolveDeps(partialDeps);
  const adapter = deps.adapterFor(provider);
  const ctx = await deps.contextFor(clientId, provider);

  const campaigns = await syncCampaigns(deps.db, clientId, provider, adapter, ctx);
  const adGroups = await syncAdGroups(deps.db, adapter, ctx, campaigns.byExternalId);
  const ads = await syncAds(deps.db, adapter, ctx, adGroups.byExternalId);
  const keywords = await syncKeywords(deps.db, adapter, ctx, adGroups.byExternalId);

  const result: EntitySyncResult = {
    clientId,
    provider,
    campaigns: campaigns.count,
    adGroups: adGroups.count,
    ads,
    keywords,
  };
  log.info({ ...result }, 'entities synced');
  return result;
}

interface LevelIndex {
  count: LevelSyncCount;
  /** externalId площадки → внутренний cuid строки. */
  byExternalId: Map<string, string>;
}

async function syncCampaigns(
  db: PrismaClient,
  clientId: string,
  provider: Provider,
  adapter: ChannelAdapter,
  ctx: ChannelContext,
): Promise<LevelIndex> {
  const remote = await adapter.listCampaigns(ctx);
  const count = emptyCount();
  const byExternalId = new Map<string, string>();

  for (const campaign of remote) {
    const status = toCampaignStatus(campaign.status);
    const strategy = strategyName(campaign.strategy);
    const budget =
      campaign.dailyBudget === null ? undefined : toDecimal(campaign.dailyBudget, MONEY_SCALE);

    const row = await db.campaign.upsert({
      where: { provider_externalId: { provider, externalId: campaign.externalId } },
      create: {
        clientId,
        provider,
        externalId: campaign.externalId,
        name: campaign.name,
        status,
        // Площадка может не отдавать дневной бюджет (недельный пакет, авто-стратегия);
        // колонка NOT NULL, поэтому явный ноль — «лимита нет», а не «нет данных».
        dailyBudget: budget ?? toDecimal(0, MONEY_SCALE),
        strategy,
      },
      update: {
        name: campaign.name,
        status,
        strategy,
        // Не затираем известный бюджет нулём, если кабинет промолчал.
        ...(budget === undefined ? {} : { dailyBudget: budget }),
      },
      select: { id: true },
    });
    byExternalId.set(campaign.externalId, row.id);
    count.upserted += 1;
  }

  const missingCampaigns = {
    clientId,
    provider,
    externalId: { notIn: [...byExternalId.keys()] },
    status: { not: CampaignStatus.ARCHIVED },
  };
  count.archived = await archiveMissing(
    {
      count: () => db.campaign.count({ where: missingCampaigns }),
      archive: () =>
        db.campaign.updateMany({
          where: missingCampaigns,
          data: { status: CampaignStatus.ARCHIVED },
        }),
    },
    byExternalId.size,
    { clientId, provider, level: 'campaign' },
  );

  return { count, byExternalId };
}

async function syncAdGroups(
  db: PrismaClient,
  adapter: ChannelAdapter,
  ctx: ChannelContext,
  campaignsByExternalId: Map<string, string>,
): Promise<LevelIndex> {
  const count = emptyCount();
  const byExternalId = new Map<string, string>();
  const campaignExternalIds = [...campaignsByExternalId.keys()];
  if (campaignExternalIds.length === 0) return { count, byExternalId };

  const remote = await adapter.listAdGroups(ctx, campaignExternalIds);
  const seenPerCampaign = new Map<string, string[]>();

  for (const group of remote) {
    const campaignId = campaignsByExternalId.get(group.campaignExternalId);
    if (!campaignId) {
      count.orphaned += 1;
      continue;
    }
    const row = await db.adGroup.upsert({
      where: { campaignId_externalId: { campaignId, externalId: group.externalId } },
      create: {
        campaignId,
        externalId: group.externalId,
        name: group.name,
        status: toAdGroupStatus(group.status),
        targetings: toJsonObject(group.targeting),
      },
      update: {
        name: group.name,
        status: toAdGroupStatus(group.status),
        targetings: toJsonObject(group.targeting),
      },
      select: { id: true },
    });
    byExternalId.set(group.externalId, row.id);
    const seen = seenPerCampaign.get(campaignId) ?? [];
    seen.push(group.externalId);
    seenPerCampaign.set(campaignId, seen);
  }
  count.upserted = byExternalId.size;

  // Архивируем в разрезе кампании: externalId группы уникален только внутри неё,
  // общий `notIn` защитил бы чужую группу с тем же идентификатором.
  for (const [campaignId, seen] of seenPerCampaign) {
    const missing = {
      campaignId,
      externalId: { notIn: seen },
      status: { not: AdGroupStatus.ARCHIVED },
    };
    count.archived += await archiveMissing(
      {
        count: () => db.adGroup.count({ where: missing }),
        archive: () =>
          db.adGroup.updateMany({ where: missing, data: { status: AdGroupStatus.ARCHIVED } }),
      },
      seen.length,
      { campaignId, level: 'adgroup' },
    );
  }

  return { count, byExternalId };
}

/**
 * Объявления: только upsert.
 *
 * Пропавшее из листинга объявление, в отличие от кампании и группы, в архив не
 * уезжает: у объявлений нет постраничного разреза, по которому предохранители
 * `archiveMissing` отличают чистку кабинета от оборванной пагинации. `Ad.status`
 * при этом обновляется на каждом прогоне — но только по тому, что кабинет прислал.
 */
async function syncAds(
  db: PrismaClient,
  adapter: ChannelAdapter,
  ctx: ChannelContext,
  adGroupsByExternalId: Map<string, string>,
): Promise<LevelSyncCount> {
  const count = emptyCount();
  const adGroupExternalIds = [...adGroupsByExternalId.keys()];
  if (adGroupExternalIds.length === 0) return count;

  const remote = await adapter.listAds(ctx, adGroupExternalIds);
  for (const ad of remote) {
    const adGroupId = adGroupsByExternalId.get(ad.adGroupExternalId);
    if (!adGroupId) {
      count.orphaned += 1;
      continue;
    }
    const data = adFields(ad);
    await db.ad.upsert({
      where: { adGroupId_externalId: { adGroupId, externalId: ad.externalId } },
      create: { adGroupId, externalId: ad.externalId, ...data },
      update: data,
      select: { id: true },
    });
    count.upserted += 1;
  }
  return count;
}

function adFields(ad: RemoteAd): {
  format: ReturnType<typeof toAdFormat>;
  title: string;
  body: string;
  imageUrl: string | null;
  status: AdStatus;
  moderationStatus: ReturnType<typeof toModerationStatus>;
  moderationReason: string | null;
} {
  return {
    format: toAdFormat(ad),
    title: ad.title,
    body: ad.text,
    imageUrl: ad.imageUrl ?? null,
    status: toAdStatus(ad.status),
    moderationStatus: toModerationStatus(ad.moderationStatus),
    moderationReason: ad.moderationReason ?? null,
  };
}

const AD_STATUS_BY_ADGROUP_STATUS: Record<AdGroupStatus, AdStatus> = {
  [AdGroupStatus.ACTIVE]: AdStatus.ACTIVE,
  [AdGroupStatus.PAUSED]: AdStatus.PAUSED,
  [AdGroupStatus.ARCHIVED]: AdStatus.ARCHIVED,
};

/**
 * Статус объявления из кабинета.
 *
 * Разбор переиспользован у группы: и Директ (`Ad.State`), и VK (`banner.status`)
 * присылают на всех уровнях одни и те же слова (ON/OFF/SUSPENDED/ARCHIVED), а вторая
 * копия таблицы соответствий разъезжалась бы с первой молча. Перевод в свой enum —
 * плата за то, что уровни могут разойтись значениями, не ломая друг друга.
 */
function toAdStatus(raw: string): AdStatus {
  return AD_STATUS_BY_ADGROUP_STATUS[toAdGroupStatus(raw)];
}

/**
 * Ключевые фразы.
 *
 * У `Keyword` нет уникального индекса на `(adGroupId, externalId)`, поэтому
 * upsert собирается вручную: читаем то, что уже есть, и сопоставляем сначала по
 * внешнему идентификатору, потом по самой фразе — так подхватывается ключ,
 * который мы создали локально и только что залили в кабинет.
 */
async function syncKeywords(
  db: PrismaClient,
  adapter: ChannelAdapter,
  ctx: ChannelContext,
  adGroupsByExternalId: Map<string, string>,
): Promise<LevelSyncCount> {
  const count = emptyCount();
  const adGroupExternalIds = [...adGroupsByExternalId.keys()];
  if (adGroupExternalIds.length === 0) return count;

  const adGroupIds = [...adGroupsByExternalId.values()];
  const existing = await db.keyword.findMany({
    where: { adGroupId: { in: adGroupIds } },
    select: { id: true, adGroupId: true, externalId: true, phrase: true, status: true },
  });

  const byExternal = new Map<string, string>();
  const byPhrase = new Map<string, string>();
  for (const row of existing) {
    if (row.externalId) byExternal.set(`${row.adGroupId}\u0000${row.externalId}`, row.id);
    byPhrase.set(`${row.adGroupId}\u0000${row.phrase}`, row.id);
  }

  const remote = await adapter.listKeywords(ctx, adGroupExternalIds);
  const matched = new Set<string>();
  const seenPerGroup = new Map<string, number>();

  for (const keyword of remote) {
    const adGroupId = adGroupsByExternalId.get(keyword.adGroupExternalId);
    if (!adGroupId) {
      count.orphaned += 1;
      continue;
    }
    seenPerGroup.set(adGroupId, (seenPerGroup.get(adGroupId) ?? 0) + 1);
    const id =
      byExternal.get(`${adGroupId}\u0000${keyword.externalId}`) ??
      byPhrase.get(`${adGroupId}\u0000${keyword.phrase}`);

    if (id) {
      await db.keyword.update({ where: { id }, data: keywordFields(keyword) });
      matched.add(id);
    } else {
      const created = await db.keyword.create({
        data: {
          adGroupId,
          phrase: keyword.phrase,
          matchType: MatchType.PHRASE,
          ...keywordFields(keyword),
        },
        select: { id: true },
      });
      matched.add(created.id);
    }
    count.upserted += 1;
  }

  // Архивируем в разрезе группы, как и сами группы в разрезе кампании: листинг
  // возвращает фразы по каждой группе отдельно, и группа, по которой не пришло
  // ничего, — это не «фразы удалили», а «до этой группы ответ не доехал».
  const vanishedPerGroup = new Map<string, string[]>();
  for (const row of existing) {
    if (matched.has(row.id)) continue;
    if (row.status === KeywordStatus.ARCHIVED) continue;
    // Минус-слова живут только у нас: кабинет отдаёт их не листингом фраз, а
    // полем кампании, поэтому «не пришёл» для них не значит «удалён».
    // Фраза без externalId — созданная нами и ещё не залитая; тоже не трогаем.
    if (row.externalId === null) continue;
    const list = vanishedPerGroup.get(row.adGroupId) ?? [];
    list.push(row.id);
    vanishedPerGroup.set(row.adGroupId, list);
  }

  for (const [adGroupId, ids] of vanishedPerGroup) {
    const missing = { id: { in: ids }, matchType: { not: MatchType.NEGATIVE } };
    count.archived += await archiveMissing(
      {
        count: () => db.keyword.count({ where: missing }),
        archive: () =>
          db.keyword.updateMany({ where: missing, data: { status: KeywordStatus.ARCHIVED } }),
      },
      seenPerGroup.get(adGroupId) ?? 0,
      { adGroupId, level: 'keyword' },
    );
  }

  return count;
}

function keywordFields(keyword: RemoteKeyword): {
  externalId: string;
  bid: ReturnType<typeof toDecimal> | null;
  status: ReturnType<typeof toKeywordStatus>;
} {
  return {
    externalId: keyword.externalId,
    bid: keyword.bid === null ? null : toDecimal(keyword.bid, MONEY_SCALE),
    status: toKeywordStatus(keyword.status),
  };
}

/**
 * Какую долю живых сущностей один прогон вправе заархивировать.
 *
 * Полностью пустой ответ — не единственная форма сбоя: листинг, оборвавшийся
 * на первой странице из трёх, приходит как обычный успешный ответ, и всё, чего
 * на этой странице не было, уезжало в архив. Половина — это заведомо больше
 * любой нормальной чистки кабинета и заведомо меньше обрыва пагинации.
 */
export const MAX_ARCHIVE_SHARE = 0.5;

interface ArchivePlan {
  /** Сколько строк попадёт под архивацию, если её выполнить. */
  count: () => Promise<number>;
  archive: () => Promise<{ count: number }>;
}

/**
 * Архивация пропавших сущностей с двумя предохранителями.
 *
 * Пустой ответ площадки — почти всегда сбой, а не «клиент всё удалил»: сетевая
 * ошибка внутри адаптера, протухший фильтр, пустая страница пагинации. Массовая
 * архивация по такому ответу выключила бы клиенту всю рекламу.
 */
async function archiveMissing(
  plan: ArchivePlan,
  seenCount: number,
  context: Record<string, unknown>,
): Promise<number> {
  if (seenCount === 0) {
    log.warn(context, 'cabinet returned no entities, skipping archival');
    return 0;
  }

  const candidates = await plan.count();
  if (candidates === 0) return 0;

  const live = seenCount + candidates;
  if (candidates > live * MAX_ARCHIVE_SHARE) {
    log.warn(
      { ...context, seen: seenCount, candidates },
      'listing looks truncated, skipping archival',
    );
    return 0;
  }

  const res = await plan.archive();
  if (res.count > 0) log.info({ ...context, archived: res.count }, 'entities archived');
  return res.count;
}
