import {
  applyGuardrails,
  DEFAULT_GUARDRAILS,
  type ClampedDecision,
  type GuardrailConfig,
  type GuardrailContext,
  type ObservationCounts,
  type RejectedDecision,
} from './guardrails.js';
import { classifyDecisions, type ApprovalRequest, type PolicyContext } from './policy.js';
import { runMvpRules } from './rules.js';
import type {
  Decision,
  DecisionLayer,
  EntityMetrics,
  HandoverModeName,
  Numeric,
  OptimizationTargets,
  OptimizerEntityType,
  RuleInput,
  SearchQueryMetrics,
} from './types.js';

export interface CampaignRecord {
  id: string;
  clientId: string;
  name: string;
  status: string;
  dailyBudget: Numeric;
  targetCpa: Numeric | null;
  handoverMode: HandoverModeName;
}

export interface AdGroupRecord {
  id: string;
}

export interface KeywordRecord {
  id: string;
  phrase: string;
  bid: Numeric | null;
  status: string;
}

export interface AdRecord {
  id: string;
  /** Заголовок объявления — подпись для карточки апрува. Необязателен: фикстуры его не несут. */
  title?: string | null;
}

export interface CampaignStatRecord {
  entityType: OptimizerEntityType;
  entityId: string;
  date: Date;
  impressions: number;
  clicks: number;
  spend: Numeric;
  conversions: number;
  /** Модель атрибуции строки. Необязательно: старые записи и тесты её не несут. */
  conversionSource?: string | null;
}

/**
 * The slice of Prisma the optimizer touches. Declared structurally so `PrismaClient` satisfies it
 * without the optimizer depending on a generated client, and so tests can pass a plain object.
 */
export interface OptimizerDb {
  campaign: {
    findUnique(args: { where: { id: string } }): Promise<CampaignRecord | null>;
  };
  adGroup: {
    findMany(args: { where: { campaignId: string } }): Promise<AdGroupRecord[]>;
  };
  keyword: {
    findMany(args: { where: { adGroupId: { in: string[] } } }): Promise<KeywordRecord[]>;
  };
  ad: {
    findMany(args: { where: { adGroupId: { in: string[] } } }): Promise<AdRecord[]>;
  };
  campaignStat: {
    findMany(args: {
      where: { entityId: { in: string[] }; date: { gte: Date; lte: Date } };
    }): Promise<CampaignStatRecord[]>;
  };
}

/**
 * Extension point for the ML (E11 T11.03) and LLM (TZ §13.5) layers. Neither is implemented; the
 * engine runs with the rule source alone until a real source is registered here.
 */
export interface DecisionSource {
  readonly id: string;
  readonly layer: DecisionLayer;
  propose(input: RuleInput, targets: OptimizationTargets): Decision[] | Promise<Decision[]>;
}

export const ruleDecisionSource: DecisionSource = {
  id: 'mvp-rules',
  layer: 'rule',
  propose: runMvpRules,
};

export interface OptimizerRunOptions {
  campaignId: string;
  now?: Date;
  windowDays?: number;
  dryRun?: boolean;
  guardrails?: Partial<GuardrailConfig>;
  /**
   * Search-query statistics for the negative-keyword rule. Injected because main's schema has no
   * search-query table yet — the report comes from the platform adapter.
   */
  searchQueries?: SearchQueryMetrics[];
  sources?: readonly DecisionSource[];
  /**
   * Целевой CPA клиента из брифа. Импортированным кампаниям (TZ §15) его никто не
   * проставляет: `Campaign.targetCpa` пишет только планировщик собственных кампаний.
   * Без этого числа три правила из четырёх молча ничего не возвращают.
   */
  fallbackTargetCpa?: number | null;
}

export type OptimizerSkipReason =
  'CAMPAIGN_NOT_FOUND' | 'CAMPAIGN_NOT_ACTIVE' | 'NO_STATISTICS' | 'MIXED_ATTRIBUTION';

/** Откуда взялась цель по CPA. `null` — цели нет, и правила по CPA работать не будут. */
export type TargetCpaSource = 'campaign' | 'brief' | null;

export interface OptimizerRun {
  campaignId: string;
  runId: string;
  windowStart: Date;
  windowEnd: Date;
  dryRun: boolean;
  targets: OptimizationTargets | null;
  targetCpaSource: TargetCpaSource;
  proposed: Decision[];
  allowed: Decision[];
  clamped: ClampedDecision[];
  rejected: RejectedDecision[];
  autoApply: Decision[];
  approvals: ApprovalRequest[];
  skipped: OptimizerSkipReason | null;
}

export const DEFAULT_WINDOW_DAYS = 7;

export function toNumber(value: Numeric | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(typeof value === 'string' ? value : value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Смесь моделей атрибуции в окне — только по строкам уровня кампании.
 *
 * Метрика перезаписывает конверсии именно на этом уровне; у групп, объявлений
 * и фраз они остаются площадочными всегда. Проверка по всем уровням давала бы
 * смесь у каждого клиента с настроенной Метрикой и навсегда выключала бы ему
 * оптимизацию. В ingestion/attribution.ts ограничение по уровню есть — сюда
 * проверку скопировали без него.
 *
 * Строки без признака (старые записи, фикстуры) отдельной моделью не считаются:
 * иначе прогон вставал бы на любой не до конца перезалитой истории.
 */
export function hasMixedAttribution(stats: readonly CampaignStatRecord[]): boolean {
  const sources = new Set<string>();
  for (const row of stats) {
    if (row.entityType !== 'CAMPAIGN') continue;
    if (row.conversionSource) sources.add(row.conversionSource);
    if (sources.size > 1) return true;
  }
  return false;
}

/**
 * Deterministic per-campaign-per-day identity. Re-running the same day produces the same runId, so
 * idempotency keys derived from it collapse duplicate applications.
 */
export function buildRunId(campaignId: string, windowEnd: Date): string {
  return `opt:${campaignId}:${windowEnd.toISOString().slice(0, 10)}`;
}

/** Reads statistics and produces decisions. Never writes — see apply.ts. */
export async function runOptimizer(
  db: OptimizerDb,
  options: OptimizerRunOptions,
): Promise<OptimizerRun> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const dryRun = options.dryRun ?? DEFAULT_GUARDRAILS.dryRun;
  const config: GuardrailConfig = { ...DEFAULT_GUARDRAILS, ...options.guardrails, dryRun };

  const empty = (skipped: OptimizerSkipReason): OptimizerRun => ({
    campaignId: options.campaignId,
    runId: buildRunId(options.campaignId, windowEnd),
    windowStart,
    windowEnd,
    dryRun,
    targets: null,
    targetCpaSource: null,
    proposed: [],
    allowed: [],
    clamped: [],
    rejected: [],
    autoApply: [],
    approvals: [],
    skipped,
  });

  const campaign = await db.campaign.findUnique({ where: { id: options.campaignId } });
  if (campaign === null) return empty('CAMPAIGN_NOT_FOUND');
  // TZ §15.8: кампании на паузе импортируем, но управление не берём.
  if (campaign.status !== 'ACTIVE') return empty('CAMPAIGN_NOT_ACTIVE');

  const adGroups = await db.adGroup.findMany({ where: { campaignId: campaign.id } });
  const adGroupIds = adGroups.map((group) => group.id);
  const [keywords, ads] = await Promise.all([
    adGroupIds.length > 0
      ? db.keyword.findMany({ where: { adGroupId: { in: adGroupIds } } })
      : Promise.resolve([]),
    adGroupIds.length > 0
      ? db.ad.findMany({ where: { adGroupId: { in: adGroupIds } } })
      : Promise.resolve([]),
  ]);

  const entityIds = [
    campaign.id,
    ...adGroupIds,
    ...keywords.map((k) => k.id),
    ...ads.map((a) => a.id),
  ];
  const stats = await db.campaignStat.findMany({
    where: { entityId: { in: entityIds }, date: { gte: windowStart, lte: windowEnd } },
  });
  if (stats.length === 0) return empty('NO_STATISTICS');

  // Смешанная атрибуция в одном окне означает, что CPA строк несопоставимы:
  // часть посчитана по конверсиям площадки, часть — по Метрике. Двигать бюджет
  // между ними — переливать деньги в кампанию, которой просто не досталось
  // строки от Метрики. Пропускаем прогон: пусть загрузка сначала выровняет
  // окно, это заметно в ErrorLog и в аудите атрибуции.
  if (hasMixedAttribution(stats)) return empty('MIXED_ATTRIBUTION');

  const bidByKeywordId = new Map<string, number | null>(
    keywords.map((keyword) => [keyword.id, toNumber(keyword.bid)]),
  );
  const labelByEntityId = new Map<string, string>([[campaign.id, campaign.name]]);
  for (const keyword of keywords) labelByEntityId.set(keyword.id, keyword.phrase);
  for (const ad of ads) if (ad.title) labelByEntityId.set(ad.id, ad.title);

  const aggregates = aggregateStats(stats, bidByKeywordId, labelByEntityId);
  const entities = aggregates.filter((entity) => entity.entityId !== campaign.id);

  const targetCpaSource = resolveTargetCpaSource(campaign, options.fallbackTargetCpa ?? null);
  const targets = buildTargets(
    campaign,
    aggregates.find((e) => e.entityId === campaign.id) ?? null,
    options.fallbackTargetCpa ?? null,
  );
  const searchQueries = options.searchQueries ?? [];
  const input: RuleInput = { entities, searchQueries };

  const sources = options.sources ?? [ruleDecisionSource];
  const proposed: Decision[] = [];
  for (const source of sources) {
    const produced = await source.propose(input, targets);
    for (const decision of produced) proposed.push({ ...decision, layer: source.layer });
  }

  const deduped = resolveConflicts(proposed);
  const context = buildGuardrailContext(campaign, entities, searchQueries);
  const guarded = applyGuardrails(deduped, context, config);
  const policyContext: PolicyContext = { handoverMode: campaign.handoverMode };
  const { autoApply, approvals } = classifyDecisions(guarded.allowed, policyContext);

  return {
    campaignId: campaign.id,
    runId: buildRunId(campaign.id, windowEnd),
    windowStart,
    windowEnd,
    dryRun,
    targets,
    targetCpaSource,
    proposed: deduped,
    allowed: guarded.allowed,
    clamped: guarded.clamped,
    rejected: guarded.rejected,
    autoApply,
    approvals,
    skipped: null,
  };
}

/**
 * An entity that is being paused must not also receive a bid change, and one entity may not get
 * two changes of the same kind in one run.
 */
export function resolveConflicts(decisions: readonly Decision[]): Decision[] {
  const paused = new Set(decisions.filter((d) => d.action === 'PAUSE').map((d) => d.entityId));
  const seen = new Set<string>();
  const result: Decision[] = [];

  for (const decision of decisions) {
    const isBidChange = decision.action === 'BID_DECREASE' || decision.action === 'BID_INCREASE';
    if (isBidChange && paused.has(decision.entityId)) continue;

    const key =
      decision.nextValue.kind === 'negativeKeyword'
        ? `${decision.entityId}:${decision.action}:${decision.nextValue.phrase}`
        : `${decision.entityId}:${isBidChange ? 'BID' : decision.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(decision);
  }

  return result;
}

/**
 * Цель по CPA: своя у кампании, иначе — из брифа клиента.
 *
 * Ноль и отрицательное значение целью не считаются: правила делят на цель, а
 * «цель 0» означала бы «любой расход хуже цели» и выключила бы всю кампанию.
 */
export function resolveTargetCpa(
  campaignTargetCpa: Numeric | null,
  fallback: number | null,
): { value: number | null; source: TargetCpaSource } {
  const own = toNumber(campaignTargetCpa);
  if (own !== null && own > 0) return { value: own, source: 'campaign' };
  if (fallback !== null && fallback > 0) return { value: fallback, source: 'brief' };
  return { value: null, source: null };
}

function resolveTargetCpaSource(campaign: CampaignRecord, fallback: number | null): TargetCpaSource {
  return resolveTargetCpa(campaign.targetCpa, fallback).source;
}

function buildTargets(
  campaign: CampaignRecord,
  campaignMetrics: EntityMetrics | null,
  fallbackTargetCpa: number | null,
): OptimizationTargets {
  const dailyBudget = toNumber(campaign.dailyBudget) ?? 0;
  const days = campaignMetrics !== null && campaignMetrics.days > 0 ? campaignMetrics.days : 0;
  // Average over days with data rather than the last day: a single slow day would otherwise read
  // as permanent underspend and push bids up.
  const dailySpend = days > 0 && campaignMetrics !== null ? campaignMetrics.spend / days : 0;

  return {
    campaignId: campaign.id,
    targetCpa: resolveTargetCpa(campaign.targetCpa, fallbackTargetCpa).value,
    dailyBudget,
    dailySpend,
    handoverMode: campaign.handoverMode,
  };
}

function buildGuardrailContext(
  campaign: CampaignRecord,
  entities: readonly EntityMetrics[],
  searchQueries: readonly SearchQueryMetrics[],
): GuardrailContext {
  const observations = new Map<string, ObservationCounts>();
  for (const entity of entities) {
    observations.set(`${entity.entityType}:${entity.entityId}`, {
      impressions: entity.impressions,
      days: entity.days,
    });
  }
  for (const query of searchQueries) {
    observations.set(`ADGROUP:${query.adGroupId}:${query.query}`, {
      impressions: query.impressions,
      days: query.days,
    });
  }

  return {
    dailyBudget: toNumber(campaign.dailyBudget) ?? 0,
    observations,
    eligibleEntityCount: entities.length,
  };
}

function aggregateStats(
  stats: readonly CampaignStatRecord[],
  bidByKeywordId: ReadonlyMap<string, number | null>,
  labelByEntityId: ReadonlyMap<string, string>,
): EntityMetrics[] {
  const byEntity = new Map<string, EntityMetrics & { dates: Set<string> }>();

  for (const row of stats) {
    const key = `${row.entityType}:${row.entityId}`;
    const existing = byEntity.get(key) ?? {
      entityType: row.entityType,
      entityId: row.entityId,
      label: labelByEntityId.get(row.entityId) ?? null,
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      days: 0,
      currentBid: bidByKeywordId.get(row.entityId) ?? null,
      dates: new Set<string>(),
    };

    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.spend += toNumber(row.spend) ?? 0;
    existing.conversions += row.conversions;
    existing.dates.add(row.date.toISOString().slice(0, 10));
    existing.days = existing.dates.size;
    byEntity.set(key, existing);
  }

  return [...byEntity.values()].map(({ dates: _dates, ...metrics }) => metrics);
}
