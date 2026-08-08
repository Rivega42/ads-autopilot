import type { Provider } from '@prisma/client';

import type {
  BidChange,
  BudgetChange,
  ChannelAdapter,
  ChannelContext,
  DateRange,
  RemoteAd,
  RemoteAdGroup,
  RemoteCampaign,
  RemoteKeyword,
  SearchQueryRow,
  StatLevel,
  StatRow,
  WriteResult,
} from '@/channels/types.js';
import { parseCredentials, type YandexCredentials } from '@/clients/yandex-direct/auth.js';
import {
  getAdGroups,
  getAds,
  getCampaigns,
  getKeywords,
  getSelfClient,
} from '@/clients/yandex-direct/entities.js';
import { YANDEX_CHANNEL } from '@/clients/yandex-direct/errors.js';
import {
  YandexHttpClient,
  type HttpTransport,
  type UnitsLedgerWriter,
} from '@/clients/yandex-direct/http.js';
import {
  fetchReport,
  reportNumber,
  type FetchReportOptions,
  type ReportSpec,
  type YandexReportType,
} from '@/clients/yandex-direct/reports.js';
import { fromMicros, type YandexAd, type YandexCampaign } from '@/clients/yandex-direct/schemas.js';
import {
  addCampaignNegativeKeywords,
  resume,
  setKeywordBids,
  suspend,
  updateAds,
  updateCampaigns,
  type ActionSummary,
} from '@/clients/yandex-direct/writes.js';
import { ChannelError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'yandex.adapter' });

export interface YandexAdapterOptions {
  /** Подменяемый транспорт — тесты и sandbox-прогоны. */
  transport?: HttpTransport;
  ledger?: UnitsLedgerWriter;
  baseUrl?: string;
  unitsReserve?: number;
  reportOptions?: FetchReportOptions;
}

/** Ставки/бюджеты в контракте — в валюте кабинета; в API — в микроединицах. */
function bidFromMicros(value: number | null | undefined): number | null {
  return typeof value === 'number' ? fromMicros(value) : null;
}

/** Стратегия лежит в подобъекте, имя которого зависит от типа кампании. */
function pickStrategy(campaign: YandexCampaign): Record<string, unknown> {
  const container =
    campaign.TextCampaign ??
    campaign.UnifiedCampaign ??
    campaign.DynamicTextCampaign ??
    campaign.SmartCampaign ??
    campaign.MobileAppCampaign;
  if (!container || typeof container !== 'object') return {};
  const strategy = (container as { BiddingStrategy?: unknown }).BiddingStrategy;
  return typeof strategy === 'object' && strategy !== null
    ? (strategy as Record<string, unknown>)
    : {};
}

/** У каждого формата объявления свой подобъект с текстами. */
function pickAdText(ad: YandexAd): {
  Title?: string;
  Title2?: string;
  Text?: string;
  Href?: string | null;
} {
  return ad.TextAd ?? ad.DynamicTextAd ?? ad.MobileAppAd ?? {};
}

const REPORT_FOR_LEVEL: Record<StatLevel, { type: YandexReportType; dimension: string }> = {
  campaign: { type: 'CAMPAIGN_PERFORMANCE_REPORT', dimension: 'CampaignId' },
  adgroup: { type: 'AD_PERFORMANCE_REPORT', dimension: 'AdGroupId' },
  ad: { type: 'AD_PERFORMANCE_REPORT', dimension: 'AdId' },
  keyword: { type: 'AD_PERFORMANCE_REPORT', dimension: 'CriterionId' },
};

/** suspend/resume существуют у кампаний, объявлений и фраз. Групп в этом списке нет. */
const SUSPENDABLE: Partial<Record<StatLevel, 'campaigns' | 'ads' | 'keywords'>> = {
  campaign: 'campaigns',
  ad: 'ads',
  keyword: 'keywords',
};

function toIds(externalIds: readonly string[]): number[] {
  return externalIds.map((id) => {
    const n = Number(id);
    if (!Number.isInteger(n)) {
      throw new ChannelError(YANDEX_CHANNEL, `Not a numeric Yandex id: ${id}`, {
        code: 'YANDEX_BAD_ID',
      });
    }
    return n;
  });
}

/** Единая форма ответа write-метода: применено или только спланировано. */
function applied(
  plan: Record<string, unknown>,
  summary: ActionSummary,
): WriteResult<ActionSummary> {
  return { applied: true, plan, result: summary };
}

function planned(plan: Record<string, unknown>): WriteResult<never> {
  log.info({ plan }, 'dry run: write suppressed');
  return { applied: false, plan };
}

export class YandexDirectAdapter implements ChannelAdapter {
  readonly channel: Provider = YANDEX_CHANNEL;

  constructor(private readonly opts: YandexAdapterOptions = {}) {}

  /** Собирает HTTP-клиент под конкретный кабинет. Состояние баллов и очередь — общие. */
  private client(ctx: ChannelContext): YandexHttpClient {
    const credentials: YandexCredentials = parseCredentials(ctx.credentials);
    const options: ConstructorParameters<typeof YandexHttpClient>[0] = {
      clientId: ctx.clientId,
      credentials,
    };
    if (this.opts.transport) options.transport = this.opts.transport;
    if (this.opts.ledger) options.ledger = this.opts.ledger;
    if (this.opts.baseUrl) options.baseUrl = this.opts.baseUrl;
    if (this.opts.unitsReserve !== undefined) options.unitsReserve = this.opts.unitsReserve;
    return new YandexHttpClient(options);
  }

  async verifyAccess(ctx: ChannelContext): Promise<{ ok: true; accountName?: string }> {
    const info = await getSelfClient(this.client(ctx));
    const out: { ok: true; accountName?: string } = { ok: true };
    const name = info?.name ?? info?.login;
    if (name) out.accountName = name;
    return out;
  }

  // ── чтение ─────────────────────────────────────────────────────────────────

  async listCampaigns(ctx: ChannelContext): Promise<RemoteCampaign[]> {
    const campaigns = await getCampaigns(this.client(ctx));
    return campaigns.map((c) => ({
      externalId: String(c.Id),
      name: c.Name,
      type: c.Type ?? 'UNKNOWN',
      status: c.State ?? c.Status ?? 'UNKNOWN',
      dailyBudget: bidFromMicros(c.DailyBudget?.Amount),
      strategy: pickStrategy(c),
      raw: c,
    }));
  }

  async listAdGroups(ctx: ChannelContext, campaignExternalIds: string[]): Promise<RemoteAdGroup[]> {
    const groups = await getAdGroups(this.client(ctx), { campaignIds: toIds(campaignExternalIds) });
    return groups.map((g) => ({
      externalId: String(g.Id),
      campaignExternalId: String(g.CampaignId),
      name: g.Name,
      status: g.Status ?? 'UNKNOWN',
      targeting: { regionIds: g.RegionIds ?? [], type: g.Type ?? null },
      raw: g,
    }));
  }

  async listAds(ctx: ChannelContext, adGroupExternalIds: string[]): Promise<RemoteAd[]> {
    const ads = await getAds(this.client(ctx), { adGroupIds: toIds(adGroupExternalIds) });
    return ads.map((a) => {
      const body = pickAdText(a);
      const ad: RemoteAd = {
        externalId: String(a.Id),
        adGroupExternalId: String(a.AdGroupId),
        title: body.Title ?? '',
        text: body.Text ?? '',
        status: a.State ?? 'UNKNOWN',
        // Именно Status несёт модерацию: DRAFT/MODERATION/PREACCEPTED/ACCEPTED/REJECTED.
        moderationStatus: a.Status ?? 'UNKNOWN',
        raw: a,
      };
      if (body.Title2) ad.title2 = body.Title2;
      if (body.Href) ad.href = body.Href;
      if (a.StatusClarification) ad.moderationReason = a.StatusClarification;
      return ad;
    });
  }

  async listKeywords(ctx: ChannelContext, adGroupExternalIds: string[]): Promise<RemoteKeyword[]> {
    const keywords = await getKeywords(this.client(ctx), {
      adGroupIds: toIds(adGroupExternalIds),
    });
    return keywords.map((k) => ({
      externalId: String(k.Id),
      adGroupExternalId: String(k.AdGroupId),
      phrase: k.Keyword,
      bid: bidFromMicros(k.Bid),
      status: k.State ?? k.Status ?? 'UNKNOWN',
      raw: k,
    }));
  }

  async getStats(ctx: ChannelContext, level: StatLevel, range: DateRange): Promise<StatRow[]> {
    const mapping = REPORT_FOR_LEVEL[level];
    const spec: ReportSpec = {
      reportType: mapping.type,
      fieldNames: [
        'Date',
        mapping.dimension,
        'Impressions',
        'Clicks',
        'Cost',
        'Conversions',
        'Revenue',
      ],
      dateFrom: range.from,
      dateTo: range.to,
    };

    const report = await fetchReport(this.client(ctx), spec, this.opts.reportOptions ?? {});
    return report.rows.map((row) => ({
      date: row['Date'] ?? range.from,
      entityExternalId: row[mapping.dimension] ?? '',
      impressions: reportNumber(row['Impressions']),
      clicks: reportNumber(row['Clicks']),
      cost: reportNumber(row['Cost']),
      conversions: reportNumber(row['Conversions']),
      revenue: reportNumber(row['Revenue']),
    }));
  }

  async getSearchQueries(ctx: ChannelContext, range: DateRange): Promise<SearchQueryRow[]> {
    const spec: ReportSpec = {
      reportType: 'SEARCH_QUERY_PERFORMANCE_REPORT',
      fieldNames: ['Date', 'CampaignId', 'Query', 'Impressions', 'Clicks', 'Cost', 'Conversions'],
      dateFrom: range.from,
      dateTo: range.to,
    };

    const report = await fetchReport(this.client(ctx), spec, this.opts.reportOptions ?? {});
    return report.rows.map((row) => ({
      date: row['Date'] ?? range.from,
      campaignExternalId: row['CampaignId'] ?? '',
      query: row['Query'] ?? '',
      impressions: reportNumber(row['Impressions']),
      clicks: reportNumber(row['Clicks']),
      cost: reportNumber(row['Cost']),
      conversions: reportNumber(row['Conversions']),
    }));
  }

  // ── запись ─────────────────────────────────────────────────────────────────
  //
  // Инвариант: при ctx.dryRun ни один метод ниже не создаёт HTTP-клиент и не
  // делает ни одного запроса — план собирается из аргументов и возвращается.

  async setBids(ctx: ChannelContext, changes: BidChange[]): Promise<WriteResult> {
    const bids = changes.map((c) => ({
      keywordId: Number(c.keywordExternalId),
      searchBid: c.bid,
    }));
    const plan = { action: 'KeywordBids.set', count: bids.length, bids };
    if (ctx.dryRun) return planned(plan);
    return applied(plan, await setKeywordBids(this.client(ctx), bids));
  }

  async setBudgets(ctx: ChannelContext, changes: BudgetChange[]): Promise<WriteResult> {
    const updates = changes.map((c) => ({
      campaignId: Number(c.campaignExternalId),
      dailyBudget: c.dailyBudget,
    }));
    const plan = {
      action: 'Campaigns.update',
      field: 'DailyBudget',
      count: updates.length,
      updates,
    };
    if (ctx.dryRun) return planned(plan);
    return applied(plan, await updateCampaigns(this.client(ctx), updates));
  }

  async pauseEntities(
    ctx: ChannelContext,
    level: StatLevel,
    externalIds: string[],
  ): Promise<WriteResult> {
    const service = this.requireSuspendable(level);
    const plan = { action: `${service}.suspend`, level, ids: externalIds };
    if (ctx.dryRun) return planned(plan);
    return applied(plan, await suspend(this.client(ctx), service, toIds(externalIds)));
  }

  async resumeEntities(
    ctx: ChannelContext,
    level: StatLevel,
    externalIds: string[],
  ): Promise<WriteResult> {
    const service = this.requireSuspendable(level);
    const plan = { action: `${service}.resume`, level, ids: externalIds };
    if (ctx.dryRun) return planned(plan);
    return applied(plan, await resume(this.client(ctx), service, toIds(externalIds)));
  }

  async addNegativeKeywords(
    ctx: ChannelContext,
    campaignExternalId: string,
    phrases: string[],
  ): Promise<WriteResult> {
    const plan = {
      action: 'Campaigns.update',
      field: 'NegativeKeywords',
      campaignExternalId,
      phrases,
    };
    if (ctx.dryRun) return planned(plan);

    const http = this.client(ctx);
    const campaignId = Number(campaignExternalId);
    // Полная замена — единственная операция в API, поэтому читаем текущий список.
    const [campaign] = await getCampaigns(http, {
      ids: [campaignId],
      fieldNames: ['Id', 'NegativeKeywords'],
      textCampaignFieldNames: [],
      unifiedCampaignFieldNames: [],
    });
    const current = campaign?.NegativeKeywords?.Items ?? [];
    const { summary, added, total } = await addCampaignNegativeKeywords(
      http,
      campaignId,
      phrases,
      current,
    );
    return { applied: true, plan: { ...plan, added, total: total.length }, result: summary };
  }

  async updateAdText(
    ctx: ChannelContext,
    adExternalId: string,
    text: { title: string; title2?: string; text: string },
  ): Promise<WriteResult> {
    const update = {
      adId: Number(adExternalId),
      title: text.title,
      ...(text.title2 !== undefined ? { title2: text.title2 } : {}),
      text: text.text,
    };
    const plan = { action: 'Ads.update', adExternalId, text };
    if (ctx.dryRun) return planned(plan);
    return applied(plan, await updateAds(this.client(ctx), [update]));
  }

  private requireSuspendable(level: StatLevel): 'campaigns' | 'ads' | 'keywords' {
    const service = SUSPENDABLE[level];
    if (!service) {
      // AdGroups в API v5 не имеют suspend/resume: останавливают объявления или фразы.
      throw new ChannelError(
        YANDEX_CHANNEL,
        `Yandex Direct cannot suspend/resume level "${level}"`,
        {
          code: 'YANDEX_UNSUPPORTED_LEVEL',
          context: { level },
        },
      );
    }
    return service;
  }
}

export const yandexDirectAdapter = new YandexDirectAdapter();
