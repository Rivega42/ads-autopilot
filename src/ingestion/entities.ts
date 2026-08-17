import {
  AdGroupStatus,
  AdStatus,
  CampaignStatus,
  KeywordStatus,
  MatchType,
  type Prisma,
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
  toAdStatus,
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

export interface AdSyncCount extends LevelSyncCount {
  /** Баннеры, оставшиеся в кабинете после нашей же замены текста. */
  superseded: number;
}

export interface EntitySyncResult {
  clientId: string;
  provider: Provider;
  campaigns: LevelSyncCount;
  adGroups: LevelSyncCount;
  ads: AdSyncCount;
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
 * Действие журнала, которым модерация фиксирует переписывание объявления.
 *
 * Строка продублирована из `moderation/repair.ts` намеренно — тем же приёмом, что
 * `TEXT_REWRITE_ACTIONS` в `creatives/ab/experiment.ts`: тянуть в загрузку весь
 * модуль модерации (модель, Telegram, база правил) ради одной константы дороже,
 * чем совпадение, закреплённое тестом.
 */
export const MODERATION_REWRITE_ACTION = 'moderation_rewrite';

/** `ChangeLog.entityType` для объявления — тот же литерал, что пишет модерация. */
const AD_ENTITY_TYPE = 'AD';

/** Ключ объявления: `externalId` уникален только внутри своей группы. */
function adKey(adGroupId: string, externalId: string): string {
  // Разделитель — NUL: он не может встретиться ни в cuid, ни во внешнем id площадки.
  return `${adGroupId}\u0000${externalId}`;
}

/** `newValue` записи `moderation_rewrite` → внешний id, который был заменён. */
function replacedExternalId(value: Prisma.JsonValue | null): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const before = (value as Record<string, unknown>)['externalIdBefore'];
  const after = (value as Record<string, unknown>)['externalIdAfter'];
  if (typeof before !== 'string' || before === '' || before === after) return null;
  return before;
}

/**
 * Баннеры, которые мы сами заменили, правя текст объявления.
 *
 * У VK правка текста — это создание нового баннера и удаление старого. Когда удаление
 * не проходит, адаптер гасит старый баннер, а модерация переводит строку на новый id.
 * Но погашенный баннер из листинга не исчезает (`VK_DEFAULT_STATUSES` включает
 * `blocked`), и его id больше не принадлежит ни одной строке — значит очередной синк
 * завёл бы под него отдельное объявление со своим счётчиком попыток. Единственный
 * сохранившийся след этой пары — `moderation_rewrite` в журнале, поэтому смотрим туда.
 */
async function supersededAdKeys(
  db: PrismaClient,
  locals: readonly { id: string; adGroupId: string }[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (locals.length === 0) return keys;

  const groupByAdId = new Map(locals.map((row) => [row.id, row.adGroupId]));
  const rewrites = await db.changeLog.findMany({
    where: {
      entityType: AD_ENTITY_TYPE,
      entityId: { in: [...groupByAdId.keys()] },
      action: MODERATION_REWRITE_ACTION,
    },
    select: { entityId: true, newValue: true },
  });

  for (const row of rewrites) {
    const replaced = replacedExternalId(row.newValue);
    const adGroupId = groupByAdId.get(row.entityId);
    // Ключ обязательно с группой: тот же внешний id в соседней группе — чужое
    // работающее объявление, и выключить его мы права не имеем.
    if (replaced !== null && adGroupId !== undefined) keys.add(adKey(adGroupId, replaced));
  }
  return keys;
}

/**
 * Объявления: только upsert.
 *
 * Пропавшее из листинга объявление, в отличие от кампании и группы, в архив не
 * уезжает: у объявлений нет постраничного разреза, по которому предохранители
 * `archiveMissing` отличают чистку кабинета от оборванной пагинации. `Ad.status`
 * при этом обновляется на каждом прогоне — но только по тому, что кабинет прислал.
 *
 * Исключение — баннер, который мы сами заменили: его строка заводится (иначе расход
 * живого объекта кабинета уехал бы в никуда — `ingestion/stats.ts` сопоставляет
 * статистику по `externalId`), но сразу в `ARCHIVED`. Статус кабинета здесь не годится:
 * попытка погасить старый баннер могла и не пройти, и тогда «работает» вернуло бы
 * объявление-двойник и в выборки оптимизатора, и в модерацию — то есть оплатило бы ему
 * ещё одно переписывание. Пометка идемпотентна: она выводится из журнала заново на
 * каждом прогоне, а не запоминается в строке.
 */
async function syncAds(
  db: PrismaClient,
  adapter: ChannelAdapter,
  ctx: ChannelContext,
  adGroupsByExternalId: Map<string, string>,
): Promise<AdSyncCount> {
  const count: AdSyncCount = { ...emptyCount(), superseded: 0 };
  const adGroupExternalIds = [...adGroupsByExternalId.keys()];
  if (adGroupExternalIds.length === 0) return count;

  const locals = await db.ad.findMany({
    where: { adGroupId: { in: [...adGroupsByExternalId.values()] } },
    select: { id: true, adGroupId: true },
  });
  const superseded = await supersededAdKeys(db, locals);

  const remote = await adapter.listAds(ctx, adGroupExternalIds);
  for (const ad of remote) {
    const adGroupId = adGroupsByExternalId.get(ad.adGroupExternalId);
    if (!adGroupId) {
      count.orphaned += 1;
      continue;
    }
    const replaced = superseded.has(adKey(adGroupId, ad.externalId));
    if (replaced) count.superseded += 1;
    const data = replaced ? { ...adFields(ad), status: AdStatus.ARCHIVED } : adFields(ad);
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
