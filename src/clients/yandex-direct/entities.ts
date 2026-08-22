import type { ZodType } from 'zod';

import type { YandexHttpClient } from '@/clients/yandex-direct/http.js';
import {
  adGroupsGetSchema,
  adsGetSchema,
  campaignsGetSchema,
  clientsGetSchema,
  keywordsGetSchema,
  type YandexAd,
  type YandexAdGroup,
  type YandexCampaign,
  type YandexKeyword,
} from '@/clients/yandex-direct/schemas.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'yandex.entities' });

/** Штатный максимум объектов в одном ответе метода get. */
export const MAX_PAGE_LIMIT = 10_000;
/**
 * SelectionCriteria тоже ограничены. Числа из справочника: до 10 кампаний,
 * до 1000 групп и до 10 000 фраз на запрос — по ним и режем входные списки.
 */
export const MAX_CAMPAIGN_IDS = 10;
export const MAX_ADGROUP_IDS = 1_000;
export const MAX_KEYWORD_IDS = 10_000;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface PagedResult<E> {
  result: { LimitedBy?: number } & Record<string, unknown>;
  items?: E[];
}

/**
 * Пагинация по `LimitedBy`.
 *
 * Директ не отдаёт ни общего количества, ни курсора: если выборка обрезана,
 * в ответе приходит `LimitedBy` — порядковый номер последнего отданного объекта,
 * он же `Offset` для следующей страницы. Отсутствие поля означает «это всё».
 */
async function getPaged<E, R extends PagedResult<E>>(
  http: YandexHttpClient,
  service: string,
  params: Record<string, unknown>,
  schema: ZodType<R>,
  pick: (result: R['result']) => E[] | undefined,
  limit: number,
): Promise<E[]> {
  const collected: E[] = [];
  let offset = 0;
  // Страховка от бесконечного цикла, если площадка начнёт возвращать неубывающий LimitedBy.
  let guard = 0;

  for (;;) {
    const page: Record<string, unknown> = { Limit: limit };
    if (offset > 0) page.Offset = offset;

    const res = await http.call(service, 'get', { ...params, Page: page }, schema);
    const items = pick(res.result) ?? [];
    collected.push(...items);

    const limitedBy = res.result.LimitedBy;
    if (typeof limitedBy !== 'number' || limitedBy <= offset || items.length === 0) break;
    offset = limitedBy;

    if (++guard > 100) {
      log.warn({ service, offset }, 'pagination guard tripped, stopping');
      break;
    }
  }

  return collected;
}

// ── Campaigns ────────────────────────────────────────────────────────────────

export interface GetCampaignsParams {
  ids?: number[];
  types?: string[];
  states?: string[];
  statuses?: string[];
  fieldNames?: string[];
  /** Подобъект стратегии зависит от типа кампании; по умолчанию берём стратегию. */
  textCampaignFieldNames?: string[];
  unifiedCampaignFieldNames?: string[];
  limit?: number;
}

export const DEFAULT_CAMPAIGN_FIELDS = [
  'Id',
  'Name',
  'Type',
  'Status',
  'State',
  'StatusClarification',
  'DailyBudget',
];

export async function getCampaigns(
  http: YandexHttpClient,
  params: GetCampaignsParams = {},
): Promise<YandexCampaign[]> {
  const selection: Record<string, unknown> = {};
  if (params.ids?.length) selection.Ids = params.ids;
  if (params.types?.length) selection.Types = params.types;
  if (params.states?.length) selection.States = params.states;
  if (params.statuses?.length) selection.Statuses = params.statuses;

  const body: Record<string, unknown> = {
    SelectionCriteria: selection,
    FieldNames: params.fieldNames ?? DEFAULT_CAMPAIGN_FIELDS,
  };
  const textFields = params.textCampaignFieldNames ?? ['BiddingStrategy'];
  const unifiedFields = params.unifiedCampaignFieldNames ?? ['BiddingStrategy'];
  if (textFields.length) body.TextCampaignFieldNames = textFields;
  if (unifiedFields.length) body.UnifiedCampaignFieldNames = unifiedFields;

  return getPaged(
    http,
    'campaigns',
    body,
    campaignsGetSchema,
    (r) => r.Campaigns,
    params.limit ?? MAX_PAGE_LIMIT,
  );
}

// ── AdGroups ─────────────────────────────────────────────────────────────────

export const DEFAULT_ADGROUP_FIELDS = ['Id', 'CampaignId', 'Name', 'Status', 'Type', 'RegionIds'];

export async function getAdGroups(
  http: YandexHttpClient,
  params: { campaignIds?: number[]; ids?: number[]; fieldNames?: string[]; limit?: number } = {},
): Promise<YandexAdGroup[]> {
  const fieldNames = params.fieldNames ?? DEFAULT_ADGROUP_FIELDS;
  const limit = params.limit ?? MAX_PAGE_LIMIT;

  if (params.ids?.length) {
    const out: YandexAdGroup[] = [];
    for (const ids of chunk(params.ids, MAX_ADGROUP_IDS)) {
      out.push(
        ...(await getPaged(
          http,
          'adgroups',
          { SelectionCriteria: { Ids: ids }, FieldNames: fieldNames },
          adGroupsGetSchema,
          (r) => r.AdGroups,
          limit,
        )),
      );
    }
    return out;
  }

  const campaignIds = params.campaignIds ?? [];
  if (!campaignIds.length) return [];

  const out: YandexAdGroup[] = [];
  for (const ids of chunk(campaignIds, MAX_CAMPAIGN_IDS)) {
    out.push(
      ...(await getPaged(
        http,
        'adgroups',
        { SelectionCriteria: { CampaignIds: ids }, FieldNames: fieldNames },
        adGroupsGetSchema,
        (r) => r.AdGroups,
        limit,
      )),
    );
  }
  return out;
}

// ── Ads ──────────────────────────────────────────────────────────────────────

export const DEFAULT_AD_FIELDS = [
  'Id',
  'CampaignId',
  'AdGroupId',
  'State',
  'Status',
  'StatusClarification',
];
export const DEFAULT_TEXT_AD_FIELDS = ['Title', 'Title2', 'Text', 'Href', 'DisplayDomain'];

export async function getAds(
  http: YandexHttpClient,
  params: {
    adGroupIds?: number[];
    campaignIds?: number[];
    ids?: number[];
    states?: string[];
    statuses?: string[];
    fieldNames?: string[];
    textAdFieldNames?: string[];
    limit?: number;
  } = {},
): Promise<YandexAd[]> {
  const fieldNames = params.fieldNames ?? DEFAULT_AD_FIELDS;
  const textAdFieldNames = params.textAdFieldNames ?? DEFAULT_TEXT_AD_FIELDS;
  const limit = params.limit ?? MAX_PAGE_LIMIT;

  const base: Record<string, unknown> = { FieldNames: fieldNames };
  if (textAdFieldNames.length) base.TextAdFieldNames = textAdFieldNames;

  const run = (selection: Record<string, unknown>): Promise<YandexAd[]> => {
    const criteria = { ...selection };
    if (params.states?.length) criteria.States = params.states;
    if (params.statuses?.length) criteria.Statuses = params.statuses;
    return getPaged(
      http,
      'ads',
      { ...base, SelectionCriteria: criteria },
      adsGetSchema,
      (r) => r.Ads,
      limit,
    );
  };

  if (params.ids?.length) {
    const out: YandexAd[] = [];
    for (const ids of chunk(params.ids, MAX_PAGE_LIMIT)) out.push(...(await run({ Ids: ids })));
    return out;
  }
  if (params.adGroupIds?.length) {
    const out: YandexAd[] = [];
    for (const ids of chunk(params.adGroupIds, MAX_ADGROUP_IDS)) {
      out.push(...(await run({ AdGroupIds: ids })));
    }
    return out;
  }
  if (params.campaignIds?.length) {
    const out: YandexAd[] = [];
    for (const ids of chunk(params.campaignIds, MAX_CAMPAIGN_IDS)) {
      out.push(...(await run({ CampaignIds: ids })));
    }
    return out;
  }
  return [];
}

// ── Keywords ─────────────────────────────────────────────────────────────────

export const DEFAULT_KEYWORD_FIELDS = [
  'Id',
  'CampaignId',
  'AdGroupId',
  'Keyword',
  'State',
  'Status',
  'Bid',
  'ContextBid',
  'StrategyPriority',
];

export async function getKeywords(
  http: YandexHttpClient,
  params: {
    adGroupIds?: number[];
    campaignIds?: number[];
    ids?: number[];
    fieldNames?: string[];
    limit?: number;
  } = {},
): Promise<YandexKeyword[]> {
  const fieldNames = params.fieldNames ?? DEFAULT_KEYWORD_FIELDS;
  const limit = params.limit ?? MAX_PAGE_LIMIT;

  const run = (selection: Record<string, unknown>): Promise<YandexKeyword[]> =>
    getPaged(
      http,
      'keywords',
      { SelectionCriteria: selection, FieldNames: fieldNames },
      keywordsGetSchema,
      (r) => r.Keywords,
      limit,
    );

  if (params.ids?.length) {
    const out: YandexKeyword[] = [];
    for (const ids of chunk(params.ids, MAX_KEYWORD_IDS)) out.push(...(await run({ Ids: ids })));
    return out;
  }
  if (params.adGroupIds?.length) {
    const out: YandexKeyword[] = [];
    for (const ids of chunk(params.adGroupIds, MAX_ADGROUP_IDS)) {
      out.push(...(await run({ AdGroupIds: ids })));
    }
    return out;
  }
  if (params.campaignIds?.length) {
    const out: YandexKeyword[] = [];
    for (const ids of chunk(params.campaignIds, MAX_CAMPAIGN_IDS)) {
      out.push(...(await run({ CampaignIds: ids })));
    }
    return out;
  }
  return [];
}

// ── Clients ──────────────────────────────────────────────────────────────────

/** Самый дешёвый способ проверить токен и права: Clients.get стоит 10 баллов. */
export async function getSelfClient(
  http: YandexHttpClient,
): Promise<{ login?: string; name?: string; currency?: string } | null> {
  const res = await http.call(
    'clients',
    'get',
    { FieldNames: ['ClientId', 'Login', 'ClientInfo', 'Currency'] },
    clientsGetSchema,
  );
  const first = res.result.Clients?.[0];
  if (!first) return null;
  const out: { login?: string; name?: string; currency?: string } = {};
  if (first.Login) out.login = first.Login;
  if (first.ClientInfo) out.name = first.ClientInfo;
  if (first.Currency) out.currency = first.Currency;
  return out;
}
