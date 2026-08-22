import {
  StatEntityType,
  type ConversionSource,
  type PrismaClient,
  type Provider,
} from '@prisma/client';

import type { DateRange, StatLevel, StatRow } from '@/channels/types.js';
import { platformConversionSource } from '@/ingestion/attribution.js';
import type { IngestionDeps } from '@/ingestion/deps.js';
import { resolveDeps } from '@/ingestion/deps.js';
import { ratioOrNull, SPEND_SCALE, toDecimal } from '@/ingestion/mapping.js';
import { STATS_WINDOW_DAYS, trailingWindowMsk, ymdToDateColumn } from '@/ingestion/window.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:stats' });

export const STAT_LEVELS: readonly StatLevel[] = ['campaign', 'adgroup', 'ad', 'keyword'];

const ENTITY_TYPE: Record<StatLevel, StatEntityType> = {
  campaign: StatEntityType.CAMPAIGN,
  adgroup: StatEntityType.ADGROUP,
  ad: StatEntityType.AD,
  keyword: StatEntityType.KEYWORD,
};

export interface LevelStatsResult {
  /** Строк пришло от площадки. */
  fetched: number;
  /** Строк записано после схлопывания дублей по (сущность, дата). */
  written: number;
  /** Строк отброшено: внешний идентификатор не нашёлся в БД. */
  unresolved: number;
}

export interface StatsSyncResult {
  clientId: string;
  provider: Provider;
  from: string;
  to: string;
  levels: Record<StatLevel, LevelStatsResult>;
}

export interface SyncStatsOptions extends Partial<IngestionDeps> {
  /** По умолчанию — скользящее окно в 21 день (ТЗ §2.1). */
  range?: DateRange;
  levels?: readonly StatLevel[];
}

/**
 * Загружает статистику кабинета в `CampaignStat`.
 *
 * Окно перезаливается целиком на каждом прогоне: конверсии из Метрики доезжают
 * до 21 дня, поэтому строка, записанная вчера, ещё три недели остаётся неверной.
 * Записи идут upsert'ом по `(entityType, entityId, date)` — повторный прогон
 * обновляет ту же строку, а не добавляет новую.
 */
export async function syncStats(
  clientId: string,
  provider: Provider,
  options: SyncStatsOptions = {},
): Promise<StatsSyncResult> {
  const { range: explicitRange, levels: explicitLevels, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const adapter = deps.adapterFor(provider);
  const ctx = await deps.contextFor(clientId, provider);
  const range = explicitRange ?? trailingWindowMsk(STATS_WINDOW_DAYS, deps.now());
  const levels = explicitLevels ?? STAT_LEVELS;

  const result: StatsSyncResult = {
    clientId,
    provider,
    from: range.from,
    to: range.to,
    levels: {
      campaign: emptyLevel(),
      adgroup: emptyLevel(),
      ad: emptyLevel(),
      keyword: emptyLevel(),
    },
  };

  for (const level of levels) {
    const index = await entityIndex(deps.db, clientId, provider, level);
    // Кабинет без сущностей этого уровня: отчёт всё равно вернул бы строки,
    // которые некуда привязать — экономим вызов и баллы API.
    if (index.size === 0) continue;

    const rows = await adapter.getStats(ctx, level, range);
    result.levels[level] = await writeLevel(deps.db, level, rows, index);
  }

  log.info({ clientId, provider, ...range, levels: result.levels }, 'stats synced');
  return result;
}

function emptyLevel(): LevelStatsResult {
  return { fetched: 0, written: 0, unresolved: 0 };
}

interface Accumulator {
  entityId: string;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  /** `null` — площадка не дала ни одного пригодного числа по этой паре. */
  conversions: number | null;
}

/**
 * `externalId` площадки → `id` строки в нашей БД.
 *
 * `CampaignStat.entityId` полиморфен и хранит именно внутренний идентификатор:
 * внешний не уникален между площадками, а джойн от статистики к сущности должен
 * работать без знания провайдера.
 */
async function entityIndex(
  db: PrismaClient,
  clientId: string,
  provider: Provider,
  level: StatLevel,
): Promise<Map<string, string>> {
  const ofClient = { campaign: { clientId, provider } };
  const select = { id: true, externalId: true };

  const rows: Array<{ id: string; externalId: string | null }> = await (level === 'campaign'
    ? db.campaign.findMany({ where: { clientId, provider }, select })
    : level === 'adgroup'
      ? db.adGroup.findMany({ where: ofClient, select })
      : level === 'ad'
        ? db.ad.findMany({ where: { adGroup: ofClient }, select })
        : db.keyword.findMany({ where: { adGroup: ofClient, externalId: { not: null } }, select }));

  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.externalId) index.set(row.externalId, row.id);
  }
  return index;
}

/**
 * Схлопывает строки отчёта по `(внутренний id, дата)`.
 *
 * Площадка может отдать один и тот же срез несколькими строками (разные
 * устройства, регионы — если срез вдруг оказался шире запрошенного). Записывать
 * их по очереди значило бы, что в БД останется последняя, а не сумма.
 */
function aggregate(
  rows: readonly StatRow[],
  index: Map<string, string>,
): { accumulators: Accumulator[]; unresolved: number } {
  const byKey = new Map<string, Accumulator>();
  let unresolved = 0;

  for (const row of rows) {
    const entityId = index.get(row.entityExternalId);
    if (!entityId) {
      unresolved += 1;
      continue;
    }
    const key = `${entityId} ${row.date}`;
    const acc = byKey.get(key) ?? {
      entityId,
      date: row.date,
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: null,
    };
    acc.impressions += row.impressions;
    acc.clicks += row.clicks;
    acc.spend += row.spend;
    // Тип обещает число, но приходит оно из разбора нетипизированного ответа
    // площадки. NaN, записанный как конверсия, — это ноль, которого никто не
    // измерял; такую строку честнее пометить «источника нет».
    if (Number.isFinite(row.conversions)) {
      acc.conversions = (acc.conversions ?? 0) + row.conversions;
    }
    byKey.set(key, acc);
  }

  return { accumulators: [...byKey.values()], unresolved };
}

async function writeLevel(
  db: PrismaClient,
  level: StatLevel,
  rows: readonly StatRow[],
  index: Map<string, string>,
): Promise<LevelStatsResult> {
  const { accumulators, unresolved } = aggregate(rows, index);
  const entityType = ENTITY_TYPE[level];

  for (const acc of accumulators) {
    const data = statFields(acc);
    await db.campaignStat.upsert({
      where: {
        entityType_entityId_date: {
          entityType,
          entityId: acc.entityId,
          date: ymdToDateColumn(acc.date),
        },
      },
      create: { entityType, entityId: acc.entityId, date: ymdToDateColumn(acc.date), ...data },
      update: data,
      select: { entityId: true },
    });
  }

  if (unresolved > 0) {
    log.warn({ level, unresolved }, 'stat rows dropped: external id is unknown to the database');
  }
  return { fetched: rows.length, written: accumulators.length, unresolved };
}

/**
 * `conversionSource` пишется в каждой записи, а не оставляется на умолчание
 * колонки: следом по тем же строкам проходит Метрика со своей моделью, и
 * перезалив окна обязан возвращать источник в «площадочный», иначе в базе
 * останется вчерашняя пометка при сегодняшних цифрах.
 */
function statFields(acc: Accumulator): {
  impressions: number;
  clicks: number;
  spend: ReturnType<typeof toDecimal>;
  conversions: number;
  conversionSource: ConversionSource;
  ctr: ReturnType<typeof ratioOrNull>;
  cpc: ReturnType<typeof ratioOrNull>;
  cpa: ReturnType<typeof ratioOrNull>;
} {
  const conversions = acc.conversions ?? 0;
  return {
    impressions: acc.impressions,
    clicks: acc.clicks,
    spend: toDecimal(acc.spend, SPEND_SCALE),
    conversions,
    conversionSource: platformConversionSource(acc.conversions),
    // CTR — доля, а не проценты: колонка Decimal(6,4), в процентах 100% не влезло бы.
    ctr: ratioOrNull(acc.clicks, acc.impressions, 4),
    cpc: ratioOrNull(acc.spend, acc.clicks, SPEND_SCALE),
    cpa: ratioOrNull(acc.spend, conversions, SPEND_SCALE),
  };
}
