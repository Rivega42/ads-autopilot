import { AdGroupStatus, type PrismaClient, type Provider } from '@prisma/client';

import type { DateRange, SearchQueryRow } from '@/channels/types.js';
import type { IngestionDeps } from '@/ingestion/deps.js';

import { resolveDeps } from '@/ingestion/deps.js';
import { SPEND_SCALE, toDecimal } from '@/ingestion/mapping.js';
import { STATS_WINDOW_DAYS, trailingWindowMsk, ymdToDateColumn } from '@/ingestion/window.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:search-queries' });

/**
 * Отчёт по поисковым запросам приходит с привязкой к кампании, а
 * `SearchQueryStat` ключуется группой: минус-слово вешается именно на группу.
 *
 * Пока контракт канала не отдаёт `adGroupExternalId` (см. `SearchQueryRow`),
 * читаем поле опционально: адаптер, который начнёт его присылать, заработает
 * без правок здесь. Для остальных работает разбор по единственной группе.
 */
type SearchQueryRowMaybeGrouped = SearchQueryRow & { adGroupExternalId?: string };

export interface SearchQuerySyncResult {
  clientId: string;
  provider: Provider;
  from: string;
  to: string;
  fetched: number;
  written: number;
  /** Строк без адреса: кампания не найдена либо групп в ней больше одной. */
  unattributed: number;
  /** Канал не умеет отчёт по поисковым запросам. */
  supported: boolean;
}

export interface SyncSearchQueriesOptions extends Partial<IngestionDeps> {
  range?: DateRange;
}

/**
 * Загружает поисковые запросы в `SearchQueryStat` — сырьё для минус-слов (ТЗ §3.5).
 *
 * Как и статистика, перезаливается скользящим окном: строки обновляются по
 * ключу `(adGroupId, date, query)`, дублей повторный прогон не создаёт.
 */
export async function syncSearchQueries(
  clientId: string,
  provider: Provider,
  options: SyncSearchQueriesOptions = {},
): Promise<SearchQuerySyncResult> {
  const { range: explicitRange, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const adapter = deps.adapterFor(provider);
  const range = explicitRange ?? trailingWindowMsk(STATS_WINDOW_DAYS, deps.now());

  const base = {
    clientId,
    provider,
    from: range.from,
    to: range.to,
    fetched: 0,
    written: 0,
    unattributed: 0,
  };

  if (!adapter.getSearchQueries) {
    log.debug({ provider }, 'channel has no search query report');
    return { ...base, supported: false };
  }

  const ctx = await deps.contextFor(clientId, provider);
  const rows: SearchQueryRowMaybeGrouped[] = await adapter.getSearchQueries(ctx, range);
  const resolver = await buildResolver(deps.db, clientId, provider);

  let written = 0;
  let unattributed = 0;

  for (const row of rows) {
    const adGroupId = resolver(row);
    if (!adGroupId || row.query === '') {
      unattributed += 1;
      continue;
    }
    const data = {
      impressions: row.impressions,
      clicks: row.clicks,
      spend: toDecimal(row.spend, SPEND_SCALE),
      conversions: row.conversions,
    };
    await deps.db.searchQueryStat.upsert({
      where: {
        adGroupId_date_query: {
          adGroupId,
          date: ymdToDateColumn(row.date),
          query: row.query,
        },
      },
      create: { adGroupId, date: ymdToDateColumn(row.date), query: row.query, ...data },
      // `negated` не трогаем: это наша пометка о том, что минус-слово уже добавлено,
      // и повторная загрузка не должна возвращать запрос в работу.
      update: data,
      select: { adGroupId: true },
    });
    written += 1;
  }

  if (unattributed > 0) {
    log.warn({ clientId, provider, unattributed }, 'search query rows without an ad group');
  }
  return { ...base, fetched: rows.length, written, unattributed, supported: true };
}

/**
 * Строит функцию «строка отчёта → внутренний id группы».
 *
 * Прямой адрес берём из строки, если адаптер его прислал. Иначе — из кампании,
 * но только когда в ней ровно одна живая группа: разложить один запрос по
 * нескольким группам нельзя, а приписать его произвольной — значит наврать
 * оптимизатору, куда вешать минус-слово.
 */
async function buildResolver(
  db: PrismaClient,
  clientId: string,
  provider: Provider,
): Promise<(row: SearchQueryRowMaybeGrouped) => string | undefined> {
  const groups = await db.adGroup.findMany({
    where: {
      campaign: { clientId, provider },
      status: { not: AdGroupStatus.ARCHIVED },
    },
    select: { id: true, externalId: true, campaign: { select: { externalId: true } } },
  });

  const byExternalId = new Map<string, string>();
  const perCampaign = new Map<string, string[]>();
  for (const group of groups) {
    byExternalId.set(group.externalId, group.id);
    const list = perCampaign.get(group.campaign.externalId) ?? [];
    list.push(group.id);
    perCampaign.set(group.campaign.externalId, list);
  }

  return (row) => {
    if (row.adGroupExternalId) return byExternalId.get(row.adGroupExternalId);
    const inCampaign = perCampaign.get(row.campaignExternalId);
    return inCampaign?.length === 1 ? inCampaign[0] : undefined;
  };
}
