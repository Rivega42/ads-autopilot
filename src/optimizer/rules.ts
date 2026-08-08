import { formatMoney, formatPercent, formatRatio, roundMoney } from './money.js';
import type {
  Decision,
  DerivedMetrics,
  EntityMetrics,
  OptimizationTargets,
  RuleInput,
} from './types.js';

export const RULE_IDS = {
  pauseHighCpa: 'pause-high-cpa',
  decreaseBidHighCpa: 'decrease-bid-high-cpa',
  increaseBidLowCpa: 'increase-bid-low-cpa',
  addNegativeKeyword: 'add-negative-keyword',
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

/** Thresholds are exactly the MVP list from TZ §3.5 «Автоматически (без апрува)». */
export const RULE_THRESHOLDS = {
  pauseHighCpa: { minImpressions: 500, cpaRatio: 3 },
  decreaseBidHighCpa: { minImpressions: 200, cpaRatio: 1.5, step: 0.15 },
  increaseBidLowCpa: { cpaRatio: 0.7, budgetUtilization: 0.5, step: 0.1 },
  addNegativeKeyword: { maxCtr: 0.005, minClicks: 5 },
} as const;

const PAUSABLE_ENTITY_TYPES = new Set(['KEYWORD', 'AD']);

export function deriveMetrics(source: {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}): DerivedMetrics {
  const { impressions, clicks, spend, conversions } = source;
  return {
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    // Spend without a single conversion is the exact situation the pause rule exists for, so it
    // must compare as "worse than any target" rather than as missing data. Zero spend and zero
    // conversions is genuinely unknown and stays null, which no rule ever acts on.
    cpa:
      conversions > 0 ? spend / conversions : spend > 0 ? Number.POSITIVE_INFINITY : null,
  };
}

function cpaText(cpa: number, spend: number): string {
  return Number.isFinite(cpa)
    ? `CPA ${formatMoney(cpa)}`
    : `0 конверсий при расходе ${formatMoney(spend)}`;
}

function targetText(cpa: number, targetCpa: number): string {
  return Number.isFinite(cpa)
    ? ` (${formatRatio(cpa / targetCpa)}× цели ${formatMoney(targetCpa)})`
    : ` (цель ${formatMoney(targetCpa)})`;
}

function ruleDecision(partial: Omit<Decision, 'requiresApproval' | 'layer' | 'approvalKind'>): Decision {
  // Rules never decide approval — policy.ts owns that and overwrites these two fields.
  return { ...partial, requiresApproval: false, layer: 'rule', approvalKind: null };
}

/** TZ §3.5: пауза ключа/объявления, если impressions > 500 И CPA > 3 × target за 7 дней. */
export function pauseHighCpaEntities(
  input: RuleInput,
  targets: OptimizationTargets,
): Decision[] {
  const { targetCpa } = targets;
  if (targetCpa === null || targetCpa <= 0) return [];

  const { minImpressions, cpaRatio } = RULE_THRESHOLDS.pauseHighCpa;
  const decisions: Decision[] = [];

  for (const entity of input.entities) {
    if (!PAUSABLE_ENTITY_TYPES.has(entity.entityType)) continue;
    if (entity.impressions <= minImpressions) continue;

    const { cpa } = deriveMetrics(entity);
    if (cpa === null || cpa <= cpaRatio * targetCpa) continue;

    decisions.push(
      ruleDecision({
        action: 'PAUSE',
        entityType: entity.entityType,
        entityId: entity.entityId,
        prevValue: { kind: 'status', status: 'ACTIVE' },
        nextValue: { kind: 'status', status: 'PAUSED' },
        reason:
          `Пауза: ${cpaText(cpa, entity.spend)}${targetText(cpa, targetCpa)}, ` +
          `показов ${entity.impressions} за ${entity.days} дн.`,
        ruleId: RULE_IDS.pauseHighCpa,
      }),
    );
  }

  return decisions;
}

/** TZ §3.5: снижение ставки на 15%, если CPA > 1.5 × target И impressions > 200. */
export function decreaseBidOnHighCpa(
  input: RuleInput,
  targets: OptimizationTargets,
): Decision[] {
  const { targetCpa } = targets;
  if (targetCpa === null || targetCpa <= 0) return [];

  const { minImpressions, cpaRatio, step } = RULE_THRESHOLDS.decreaseBidHighCpa;
  const decisions: Decision[] = [];

  for (const entity of input.entities) {
    const bid = biddableBid(entity);
    if (bid === null) continue;
    if (entity.impressions <= minImpressions) continue;

    const { cpa } = deriveMetrics(entity);
    if (cpa === null || cpa <= cpaRatio * targetCpa) continue;

    const nextBid = roundMoney(bid * (1 - step));
    if (nextBid >= bid || nextBid <= 0) continue;

    decisions.push(
      ruleDecision({
        action: 'BID_DECREASE',
        entityType: entity.entityType,
        entityId: entity.entityId,
        prevValue: { kind: 'bid', amount: bid },
        nextValue: { kind: 'bid', amount: nextBid },
        reason:
          `Снижение ставки на ${formatPercent(step)}%: ${formatMoney(bid)} → ${formatMoney(nextBid)}. ` +
          `${cpaText(cpa, entity.spend)}${targetText(cpa, targetCpa)}, ` +
          `показов ${entity.impressions} за ${entity.days} дн.`,
        ruleId: RULE_IDS.decreaseBidHighCpa,
      }),
    );
  }

  return decisions;
}

/**
 * TZ §3.5: повышение ставки на 10%, если CPA < 0.7 × target И daily_cost < daily_budget × 0.5.
 * The underspend condition is campaign-wide, so either every biddable entity qualifies or none —
 * spending headroom is a property of the budget, not of the keyword.
 */
export function increaseBidOnLowCpa(
  input: RuleInput,
  targets: OptimizationTargets,
): Decision[] {
  const { targetCpa, dailyBudget, dailySpend } = targets;
  if (targetCpa === null || targetCpa <= 0) return [];
  if (dailyBudget <= 0) return [];

  const { cpaRatio, budgetUtilization, step } = RULE_THRESHOLDS.increaseBidLowCpa;
  if (dailySpend >= dailyBudget * budgetUtilization) return [];

  const decisions: Decision[] = [];

  for (const entity of input.entities) {
    const bid = biddableBid(entity);
    if (bid === null) continue;

    const { cpa } = deriveMetrics(entity);
    if (cpa === null || cpa >= cpaRatio * targetCpa) continue;

    const nextBid = roundMoney(bid * (1 + step));
    if (nextBid <= bid) continue;

    decisions.push(
      ruleDecision({
        action: 'BID_INCREASE',
        entityType: entity.entityType,
        entityId: entity.entityId,
        prevValue: { kind: 'bid', amount: bid },
        nextValue: { kind: 'bid', amount: nextBid },
        reason:
          `Повышение ставки на ${formatPercent(step)}%: ${formatMoney(bid)} → ${formatMoney(nextBid)}. ` +
          `${cpaText(cpa, entity.spend)}${targetText(cpa, targetCpa)}, ` +
          `расход ${formatMoney(dailySpend)} из ${formatMoney(dailyBudget)}/сут.`,
        ruleId: RULE_IDS.increaseBidLowCpa,
      }),
    );
  }

  return decisions;
}

/** TZ §3.5: добавление минус-слов из search queries, где CTR < 0.5% И clicks > 5. */
export function addNegativeKeywords(
  input: RuleInput,
  _targets: OptimizationTargets,
): Decision[] {
  const { maxCtr, minClicks } = RULE_THRESHOLDS.addNegativeKeyword;
  const decisions: Decision[] = [];

  for (const query of input.searchQueries) {
    if (query.clicks <= minClicks) continue;

    const { ctr } = deriveMetrics(query);
    if (ctr === null || ctr >= maxCtr) continue;

    decisions.push(
      ruleDecision({
        action: 'ADD_NEGATIVE_KEYWORD',
        entityType: 'ADGROUP',
        entityId: query.adGroupId,
        prevValue: { kind: 'absent' },
        nextValue: { kind: 'negativeKeyword', phrase: query.query },
        reason:
          `Минус-слово «${query.query}»: CTR ${formatPercent(ctr)}% ` +
          `при ${query.clicks} кликах и ${query.impressions} показах за ${query.days} дн.`,
        ruleId: RULE_IDS.addNegativeKeyword,
      }),
    );
  }

  return decisions;
}

export type OptimizationRule = (input: RuleInput, targets: OptimizationTargets) => Decision[];

/**
 * Order matters downstream: the engine resolves entity conflicts and the guardrails drop batch
 * overflow by keeping the earliest decisions, so the most protective rule comes first.
 */
export const MVP_RULES: readonly OptimizationRule[] = [
  pauseHighCpaEntities,
  decreaseBidOnHighCpa,
  increaseBidOnLowCpa,
  addNegativeKeywords,
];

export function runMvpRules(input: RuleInput, targets: OptimizationTargets): Decision[] {
  return MVP_RULES.flatMap((rule) => rule(input, targets));
}

function biddableBid(entity: EntityMetrics): number | null {
  if (entity.entityType !== 'KEYWORD') return null;
  if (entity.currentBid === null || entity.currentBid <= 0) return null;
  return entity.currentBid;
}
