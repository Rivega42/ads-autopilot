import { StatEntityType } from '@prisma/client';
import type {
  ApprovalDecision,
  ApprovalKind,
  CampaignStatus,
  ChangeActor,
  ClientStatus,
  ConversionSource,
  HandoverMode,
  Provider,
} from '@prisma/client';

import type { AttributionSummary, ConversionSourceCounts } from './attribution';
import { addCounts, emptyCounts, summarizeAttribution } from './attribution';
import { dateColumnToYmd, eachDay, mskDateToUtc, shiftYmd, ymdToDateColumn } from './dates';
import type { DashboardFilters } from './filters';
import { cpa, ctr } from './metrics';
import { getPrisma } from './prisma';
import { bigIntToString, decimalToNumber, decimalToNumberOr, toJsonSafe } from './serialize';
import type { JsonSafe } from './serialize';

/** Потолок выборки: дашборд — витрина, а не выгрузка. */
const ROW_LIMIT = 200;

export interface PeriodTotals {
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: number;
  readonly conversions: number;
  readonly cpa: number | null;
  readonly ctr: number | null;
  /** Чьи конверсии сложены в `conversions`. При `mixed` `cpa` несопоставим. */
  readonly attribution: AttributionSummary;
}

export interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly status: ClientStatus;
  readonly tgUsername: string | null;
  readonly channels: readonly Provider[];
  readonly campaignCount: number;
  readonly activeCampaignCount: number;
  readonly totals: PeriodTotals;
}

export interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly provider: Provider;
  readonly status: CampaignStatus;
  readonly dailyBudget: number;
  readonly targetCpa: number | null;
  readonly totals: PeriodTotals;
}

export interface CampaignDetail {
  readonly id: string;
  readonly name: string;
  readonly externalId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly provider: Provider;
  readonly status: CampaignStatus;
  readonly dailyBudget: number;
  readonly targetCpa: number | null;
  readonly strategy: string | null;
  readonly handoverMode: HandoverMode;
  readonly importedAt: string | null;
  readonly adGroupCount: number;
}

export interface DailyMetrics {
  readonly date: string;
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: number;
  readonly conversions: number;
  readonly cpa: number | null;
  /** `null` — за этот день строки статистики нет, а не «источник неизвестен». */
  readonly conversionSource: ConversionSource | null;
}

export interface ChangeRow {
  readonly id: string;
  readonly appliedAt: string;
  readonly campaignId: string | null;
  readonly campaignName: string | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly prevValue: JsonSafe;
  readonly newValue: JsonSafe;
  readonly reason: string | null;
  readonly actor: ChangeActor;
  readonly approvedBy: string | null;
  readonly provider: Provider | null;
  readonly rolledBackAt: string | null;
}

export interface ApprovalRow {
  readonly id: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly kind: ApprovalKind;
  readonly summary: string | null;
  readonly payload: JsonSafe;
  readonly decision: ApprovalDecision;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly respondedBy: string | null;
  readonly error: string | null;
  /** BigInt — строкой: в number он потерял бы точность. */
  readonly tgMessageId: string | null;
}

interface RawTotals {
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: number;
  readonly conversions: number;
}

function totalsOf(raw: RawTotals, counts: ConversionSourceCounts = emptyCounts()): PeriodTotals {
  return {
    ...raw,
    cpa: cpa(raw.spend, raw.conversions),
    ctr: ctr(raw.clicks, raw.impressions),
    attribution: summarizeAttribution(counts),
  };
}

function addRaw(left: RawTotals, right: RawTotals): RawTotals {
  return {
    impressions: left.impressions + right.impressions,
    clicks: left.clicks + right.clicks,
    spend: left.spend + right.spend,
    conversions: left.conversions + right.conversions,
  };
}

const ZERO: RawTotals = { impressions: 0, clicks: 0, spend: 0, conversions: 0 };

/**
 * Суммы `CampaignStat` по кампаниям за период.
 *
 * `CampaignStat` полиморфна: без `entityType` в выборку попали бы строки групп
 * и объявлений, у которых `entityId` из другой таблицы, но формально сравним.
 *
 * Группировка идёт ещё и по `conversionSource`: одна строка на кампанию скрыла
 * бы, что часть дней окна посчитала Метрика, а часть — площадка, и суммарный
 * CPA молча получился бы из двух несовместимых моделей атрибуции.
 */
async function campaignTotals(
  campaignIds: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, PeriodTotals>> {
  const result = new Map<string, PeriodTotals>();
  if (campaignIds.length === 0) return result;

  const grouped = await getPrisma().campaignStat.groupBy({
    by: ['entityId', 'conversionSource'],
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: { in: [...campaignIds] },
      date: { gte: ymdToDateColumn(from), lte: ymdToDateColumn(to) },
    },
    _sum: { impressions: true, clicks: true, spend: true, conversions: true },
    _count: { _all: true },
  });

  const accumulated = new Map<string, { totals: RawTotals; counts: ConversionSourceCounts }>();
  for (const row of grouped) {
    const previous = accumulated.get(row.entityId) ?? { totals: ZERO, counts: emptyCounts() };
    const counts = emptyCounts();
    counts[row.conversionSource] = row._count._all;

    accumulated.set(row.entityId, {
      totals: addRaw(previous.totals, {
        impressions: row._sum.impressions ?? 0,
        clicks: row._sum.clicks ?? 0,
        // spend — Decimal: без явного преобразования сюда приехал бы объект.
        spend: decimalToNumberOr(row._sum.spend, 0),
        conversions: row._sum.conversions ?? 0,
      }),
      counts: addCounts(previous.counts, counts),
    });
  }

  for (const [entityId, entry] of accumulated) {
    result.set(entityId, totalsOf(entry.totals, entry.counts));
  }
  return result;
}

export async function listClients(filters: DashboardFilters): Promise<ClientRow[]> {
  const clients = await getPrisma().client.findMany({
    where: {
      status: filters.clientStatus ?? undefined,
      ...(filters.provider ? { campaigns: { some: { provider: filters.provider } } } : {}),
    },
    select: {
      id: true,
      name: true,
      status: true,
      tgUsername: true,
      // Из Credential берётся только провайдер: шифротекст и IV браузеру не нужны.
      credentials: { select: { provider: true } },
      campaigns: { select: { id: true, provider: true, status: true } },
    },
    orderBy: { name: 'asc' },
    take: ROW_LIMIT,
  });

  const visible = clients.map((client) => ({
    client,
    campaigns: client.campaigns.filter(
      (campaign) => filters.provider === null || campaign.provider === filters.provider,
    ),
  }));

  const totals = await campaignTotals(
    visible.flatMap((entry) => entry.campaigns.map((campaign) => campaign.id)),
    filters.from,
    filters.to,
  );

  return visible.map(({ client, campaigns }) => {
    const channels = new Set<Provider>();
    for (const credential of client.credentials) channels.add(credential.provider);
    for (const campaign of client.campaigns) channels.add(campaign.provider);

    // Смешение вылезает чаще всего именно здесь: у одной кампании клиента
    // Метрика настроена, у соседней — нет, а в строке клиента они складываются.
    const summed = campaigns.reduce<{ totals: RawTotals; counts: ConversionSourceCounts }>(
      (accumulator, campaign) => {
        const stat = totals.get(campaign.id);
        if (!stat) return accumulator;
        return {
          totals: addRaw(accumulator.totals, stat),
          counts: addCounts(accumulator.counts, stat.attribution.counts),
        };
      },
      { totals: ZERO, counts: emptyCounts() },
    );

    return {
      id: client.id,
      name: client.name,
      status: client.status,
      tgUsername: client.tgUsername,
      channels: [...channels].filter(
        (provider) => filters.provider === null || provider === filters.provider,
      ),
      campaignCount: campaigns.length,
      activeCampaignCount: campaigns.filter((campaign) => campaign.status === 'ACTIVE').length,
      totals: totalsOf(summed.totals, summed.counts),
    };
  });
}

export async function listCampaigns(filters: DashboardFilters): Promise<CampaignRow[]> {
  const campaigns = await getPrisma().campaign.findMany({
    where: {
      provider: filters.provider ?? undefined,
      status: filters.status ?? undefined,
      clientId: filters.clientId ?? undefined,
      ...(filters.clientStatus ? { client: { status: filters.clientStatus } } : {}),
    },
    select: {
      id: true,
      name: true,
      clientId: true,
      provider: true,
      status: true,
      dailyBudget: true,
      targetCpa: true,
      client: { select: { name: true } },
    },
    orderBy: [{ client: { name: 'asc' } }, { name: 'asc' }],
    take: ROW_LIMIT,
  });

  const totals = await campaignTotals(
    campaigns.map((campaign) => campaign.id),
    filters.from,
    filters.to,
  );

  return campaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    clientId: campaign.clientId,
    clientName: campaign.client.name,
    provider: campaign.provider,
    status: campaign.status,
    dailyBudget: decimalToNumberOr(campaign.dailyBudget, 0),
    targetCpa: decimalToNumber(campaign.targetCpa),
    totals: totals.get(campaign.id) ?? totalsOf(ZERO),
  }));
}

export async function getCampaign(id: string): Promise<CampaignDetail | null> {
  const campaign = await getPrisma().campaign.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      externalId: true,
      clientId: true,
      provider: true,
      status: true,
      dailyBudget: true,
      targetCpa: true,
      strategy: true,
      handoverMode: true,
      importedAt: true,
      client: { select: { name: true } },
      _count: { select: { adGroups: true } },
    },
  });
  if (!campaign) return null;

  return {
    id: campaign.id,
    name: campaign.name,
    externalId: campaign.externalId,
    clientId: campaign.clientId,
    clientName: campaign.client.name,
    provider: campaign.provider,
    status: campaign.status,
    dailyBudget: decimalToNumberOr(campaign.dailyBudget, 0),
    targetCpa: decimalToNumber(campaign.targetCpa),
    strategy: campaign.strategy,
    handoverMode: campaign.handoverMode,
    importedAt: campaign.importedAt?.toISOString() ?? null,
    adGroupCount: campaign._count.adGroups,
  };
}

/**
 * Дневной ряд по кампании, без дыр в оси.
 *
 * Дни, которых нет в `CampaignStat`, добиваются нулями: площадка не присылает
 * строку за день без показов, и разрыв в графике читался бы как «данные не
 * загрузились». А вот CPA за такой день остаётся `null` — конверсий не было,
 * и ноль рублей за конверсию был бы выдумкой.
 */
export async function getCampaignDaily(
  campaignId: string,
  from: string,
  to: string,
): Promise<DailyMetrics[]> {
  const rows = await getPrisma().campaignStat.findMany({
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: campaignId,
      date: { gte: ymdToDateColumn(from), lte: ymdToDateColumn(to) },
    },
    select: {
      date: true,
      impressions: true,
      clicks: true,
      spend: true,
      conversions: true,
      conversionSource: true,
    },
    orderBy: { date: 'asc' },
  });

  const byDate = new Map(rows.map((row) => [dateColumnToYmd(row.date), row]));

  return eachDay(from, to).map((date) => {
    const row = byDate.get(date);
    const spend = decimalToNumberOr(row?.spend, 0);
    const conversions = row?.conversions ?? 0;
    return {
      date,
      impressions: row?.impressions ?? 0,
      clicks: row?.clicks ?? 0,
      spend,
      conversions,
      cpa: cpa(spend, conversions),
      conversionSource: row?.conversionSource ?? null,
    };
  });
}

export async function listChanges(
  filters: DashboardFilters,
  options: { readonly campaignId?: string; readonly limit?: number } = {},
): Promise<ChangeRow[]> {
  const changes = await getPrisma().changeLog.findMany({
    where: {
      campaignId: options.campaignId ?? undefined,
      provider: filters.provider ?? undefined,
      // appliedAt — timestamp, поэтому границы московские, а не UTC-полночь.
      appliedAt: { gte: mskDateToUtc(filters.from), lt: mskDateToUtc(shiftYmd(filters.to, 1)) },
      ...(filters.clientId ? { campaign: { clientId: filters.clientId } } : {}),
    },
    select: {
      id: true,
      appliedAt: true,
      campaignId: true,
      entityType: true,
      entityId: true,
      action: true,
      prevValue: true,
      newValue: true,
      reason: true,
      actor: true,
      approvedBy: true,
      provider: true,
      rolledBackAt: true,
      campaign: { select: { name: true } },
    },
    orderBy: { appliedAt: 'desc' },
    take: options.limit ?? ROW_LIMIT,
  });

  return changes.map((change) => ({
    id: change.id,
    appliedAt: change.appliedAt.toISOString(),
    campaignId: change.campaignId,
    campaignName: change.campaign?.name ?? null,
    entityType: change.entityType,
    entityId: change.entityId,
    action: change.action,
    prevValue: toJsonSafe(change.prevValue),
    newValue: toJsonSafe(change.newValue),
    reason: change.reason,
    actor: change.actor,
    approvedBy: change.approvedBy,
    provider: change.provider,
    rolledBackAt: change.rolledBackAt?.toISOString() ?? null,
  }));
}

export async function listApprovals(filters: DashboardFilters): Promise<ApprovalRow[]> {
  const approvals = await getPrisma().pendingApproval.findMany({
    where: {
      // Очередь — это то, что ждёт человека; остальное показывается по фильтру.
      decision: filters.decision ?? 'PENDING',
      clientId: filters.clientId ?? undefined,
      createdAt: { gte: mskDateToUtc(filters.from), lt: mskDateToUtc(shiftYmd(filters.to, 1)) },
      ...(filters.clientStatus ? { client: { status: filters.clientStatus } } : {}),
    },
    select: {
      id: true,
      clientId: true,
      kind: true,
      summary: true,
      payload: true,
      decision: true,
      createdAt: true,
      expiresAt: true,
      decidedAt: true,
      respondedBy: true,
      error: true,
      tgMessageId: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: ROW_LIMIT,
  });

  return approvals.map((approval) => ({
    id: approval.id,
    clientId: approval.clientId,
    clientName: approval.client.name,
    kind: approval.kind,
    summary: approval.summary,
    payload: toJsonSafe(approval.payload),
    decision: approval.decision,
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    respondedBy: approval.respondedBy,
    error: approval.error,
    tgMessageId: bigIntToString(approval.tgMessageId),
  }));
}

export async function countPendingApprovals(): Promise<number> {
  return getPrisma().pendingApproval.count({ where: { decision: 'PENDING' } });
}
