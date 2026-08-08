import { ceilMoney, floorMoney, formatMoney, formatPercent } from './money.js';
import type { Decision } from './types.js';

export type GuardrailRail =
  | 'MAX_BID_CHANGE'
  | 'BUDGET_CEILING'
  | 'MIN_OBSERVATIONS'
  | 'MAX_CHANGED_ENTITY_SHARE'
  | 'UNUSABLE_PREVIOUS_VALUE';

export interface GuardrailConfig {
  /** TZ §13.5: изменение ставки за сутки ≤ 30%. */
  maxBidChangePct: number;
  /** TZ §13.5: дневной бюджет hard limit = целевой + 20% → ratio 1.2 of `Campaign.dailyBudget`. */
  budgetCeilingRatio: number;
  minImpressions: number;
  minObservationDays: number;
  /** E11 T11.14: не более 30% сущностей за один прогон. */
  maxChangedEntityShare: number;
  /** Global kill switch: when true nothing may reach a platform or the ChangeLog. */
  dryRun: boolean;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxBidChangePct: 0.3,
  budgetCeilingRatio: 1.2,
  minImpressions: 100,
  minObservationDays: 3,
  maxChangedEntityShare: 0.3,
  dryRun: false,
};

export interface ObservationCounts {
  impressions: number;
  days: number;
}

export interface GuardrailContext {
  dailyBudget: number;
  observations: Map<string, ObservationCounts>;
  /**
   * Population the batch is measured against for the share rail. Omit to disable that rail — the
   * caller may legitimately not know the denominator (e.g. a single-entity re-run).
   */
  eligibleEntityCount?: number;
}

export interface ClampedDecision {
  decision: Decision;
  original: Decision;
  rail: GuardrailRail;
  note: string;
}

export interface RejectedDecision {
  decision: Decision;
  rail: GuardrailRail;
  note: string;
}

export interface GuardrailOutcome {
  /** Decisions that survived, already carrying any clamped values. */
  allowed: Decision[];
  clamped: ClampedDecision[];
  rejected: RejectedDecision[];
  dryRun: boolean;
}

/**
 * Stable identity of the evidence behind a decision. Negative keywords are judged on the query's
 * own statistics, not on the ad group's, so they get their own key.
 */
export function observationKey(decision: Decision): string {
  if (decision.nextValue.kind === 'negativeKeyword') {
    return `${decision.entityType}:${decision.entityId}:${decision.nextValue.phrase}`;
  }
  return `${decision.entityType}:${decision.entityId}`;
}

/**
 * Hard limits applied to every decision regardless of which layer produced it. A rule bug, an ML
 * outlier or a hallucinated LLM number all pass through here before anything is written.
 */
export function applyGuardrails(
  decisions: readonly Decision[],
  context: GuardrailContext,
  config: GuardrailConfig = DEFAULT_GUARDRAILS,
): GuardrailOutcome {
  const allowed: Decision[] = [];
  const clamped: ClampedDecision[] = [];
  const rejected: RejectedDecision[] = [];

  const entityCap = entityCapFor(context, config);
  const touchedEntities = new Set<string>();

  for (const decision of decisions) {
    const observation = context.observations.get(observationKey(decision));

    // Reject, never clamp: too little evidence does not make the change smaller, it makes the
    // whole conclusion unsound. There is no safe fraction of a decision taken on noise.
    if (observation === undefined) {
      rejected.push({
        decision,
        rail: 'MIN_OBSERVATIONS',
        note: 'нет статистики по сущности за окно наблюдения',
      });
      continue;
    }
    if (
      observation.impressions < config.minImpressions ||
      observation.days < config.minObservationDays
    ) {
      rejected.push({
        decision,
        rail: 'MIN_OBSERVATIONS',
        note:
          `недостаточно данных: ${observation.impressions} показов за ${observation.days} дн. ` +
          `(минимум ${config.minImpressions} показов и ${config.minObservationDays} дн.)`,
      });
      continue;
    }

    if (entityCap !== null && !touchedEntities.has(decision.entityId)) {
      // Overflow is dropped rather than clamped: the limit is on how much of the account may move
      // in one run, and the decisions arrive worst-first, so the tail is the least valuable.
      if (touchedEntities.size >= entityCap) {
        rejected.push({
          decision,
          rail: 'MAX_CHANGED_ENTITY_SHARE',
          note:
            `за один прогон разрешено менять не более ${formatPercent(config.maxChangedEntityShare)}% ` +
            `сущностей (${entityCap})`,
        });
        continue;
      }
    }

    const limited = limitValue(decision, context, config);
    if (limited.outcome === 'rejected') {
      rejected.push({ decision, rail: limited.rail, note: limited.note });
      continue;
    }

    touchedEntities.add(decision.entityId);

    if (limited.outcome === 'clamped') {
      clamped.push({
        decision: limited.decision,
        original: decision,
        rail: limited.rail,
        note: limited.note,
      });
      allowed.push(limited.decision);
      continue;
    }

    allowed.push(decision);
  }

  return { allowed, clamped, rejected, dryRun: config.dryRun };
}

type LimitResult =
  | { outcome: 'allowed' }
  | { outcome: 'clamped'; decision: Decision; rail: GuardrailRail; note: string }
  | { outcome: 'rejected'; rail: GuardrailRail; note: string };

function limitValue(
  decision: Decision,
  context: GuardrailContext,
  config: GuardrailConfig,
): LimitResult {
  if (decision.nextValue.kind === 'bid') {
    if (decision.prevValue.kind !== 'bid' || decision.prevValue.amount <= 0) {
      // Without a positive previous bid the relative limit is undefined (division by zero), and an
      // unbounded absolute bid is exactly what this rail exists to prevent.
      return {
        outcome: 'rejected',
        rail: 'UNUSABLE_PREVIOUS_VALUE',
        note: 'неизвестна текущая ставка — относительный лимит неприменим',
      };
    }
    return clampAroundPrevious(
      decision,
      decision.prevValue.amount,
      decision.nextValue.amount,
      config.maxBidChangePct,
      'MAX_BID_CHANGE',
      (amount) => ({ kind: 'bid', amount }),
    );
  }

  if (decision.nextValue.kind === 'budget') {
    const ceiling = floorMoney(context.dailyBudget * config.budgetCeilingRatio);
    if (decision.nextValue.amount > ceiling) {
      // Clamp, not reject: the direction is still the right call, only the size is unsafe, and a
      // budget pinned to the ceiling is the largest spend we ever agreed to risk.
      const next = withNextValue(decision, { kind: 'budget', amount: ceiling });
      return {
        outcome: 'clamped',
        decision: annotate(
          next,
          `ограничено guardrail: дневной бюджет ≤ ${formatMoney(ceiling)}`,
        ),
        rail: 'BUDGET_CEILING',
        note:
          `бюджет ${formatMoney(decision.nextValue.amount)} превышает потолок ` +
          `${formatMoney(ceiling)} (${config.budgetCeilingRatio}× от ${formatMoney(context.dailyBudget)})`,
      };
    }
    return { outcome: 'allowed' };
  }

  return { outcome: 'allowed' };
}

function clampAroundPrevious(
  decision: Decision,
  previous: number,
  next: number,
  maxChangePct: number,
  rail: GuardrailRail,
  build: (amount: number) => Decision['nextValue'],
): LimitResult {
  const upper = floorMoney(previous * (1 + maxChangePct));
  const lower = ceilMoney(previous * (1 - maxChangePct));
  if (next <= upper && next >= lower) return { outcome: 'allowed' };

  // Clamp, not reject: the layer above is right about the direction (CPA really is off target),
  // it is only asking for a bigger step than one day is allowed to take. The remainder can be
  // taken tomorrow, which is precisely the intent of a per-day limit.
  const amount = next > upper ? upper : lower;
  const clampedDecision = annotate(
    withNextValue(decision, build(amount)),
    `ограничено guardrail: изменение ставки ≤ ${formatPercent(maxChangePct)}%/сут ` +
      `(${formatMoney(next)} → ${formatMoney(amount)})`,
  );
  return {
    outcome: 'clamped',
    decision: clampedDecision,
    rail,
    note:
      `запрошено ${formatMoney(next)} от ${formatMoney(previous)}, ` +
      `допустимый коридор ${formatMoney(lower)}…${formatMoney(upper)}`,
  };
}

function withNextValue(decision: Decision, nextValue: Decision['nextValue']): Decision {
  return { ...decision, nextValue };
}

function annotate(decision: Decision, note: string): Decision {
  return { ...decision, reason: `${decision.reason} [${note}]` };
}

function entityCapFor(context: GuardrailContext, config: GuardrailConfig): number | null {
  const population = context.eligibleEntityCount;
  if (population === undefined || population <= 0) return null;
  if (config.maxChangedEntityShare <= 0) return 0;
  // Floor would freeze small accounts entirely (3 keywords × 0.3 → 0), so one entity is always
  // allowed to move; the rail is about mass movement, not about blocking any action at all.
  return Math.max(1, Math.floor(population * config.maxChangedEntityShare));
}
