import { bidHistoryKey, type BidHistory } from './bid-history.js';
import { ceilMoney, floorMoney, formatMoney, formatPercent } from './money.js';
import type { Decision } from './types.js';

import { env } from '@/env.js';

export type GuardrailRail =
  | 'MAX_BID_CHANGE'
  | 'MAX_BID_CHANGE_WINDOW'
  | 'BUDGET_CEILING'
  | 'MIN_OBSERVATIONS'
  | 'MAX_CHANGED_ENTITY_SHARE'
  | 'UNUSABLE_PREVIOUS_VALUE'
  | 'BID_HISTORY_UNAVAILABLE';

export interface GuardrailConfig {
  /**
   * TZ §13.5: изменение ставки ≤ 30%.
   *
   * Ограничивает и один шаг, и сумму шагов за окно наблюдения — отдельного порога на
   * период нет намеренно. Две константы разъехались бы при первой правке одной из них,
   * а инвариант «одно окно данных даёт право на одно движение» не разъезжается: прогоны
   * внутри одного окна решают по почти одним и тем же цифрам, и семь решений на одних
   * данных не должны стоить семи шагов.
   */
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

/**
 * Настройки по умолчанию — из окружения, а не рядом с ним.
 *
 * `MAX_BID_CHANGE_PCT` и `DAILY_BUDGET_HARD_LIMIT_MULT` объявлены в `src/env.ts` и
 * в `.env.example` с теми же цифрами, что раньше стояли здесь литералами, и не
 * читались ниоткуда. Человек, выставивший переменную в проде, считал предохранитель
 * настроенным; на деле решения считались по константе, и разъезд был молчаливым —
 * ни лога, ни ошибки старта. Одно значение обязано жить в одном месте.
 *
 * Порогов наблюдений и доли изменённых сущностей это не касается: своих переменных
 * у них нет, и выдумывать их здесь — значит заводить ещё одну пару, которой предстоит
 * разъехаться.
 */
export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxBidChangePct: env.MAX_BID_CHANGE_PCT,
  budgetCeilingRatio: env.DAILY_BUDGET_HARD_LIMIT_MULT,
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
  /** Ставка на начало окна по каждой сущности — точка отсчёта суммарного лимита. */
  bidHistory: BidHistory;
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
 * Тратит ли решение квоту «не более N% сущностей за прогон».
 *
 * Минус-слова — нет: они добавляются к кампании, обратимы и являются самым безопасным
 * действием из наших (TZ §15.7, первая неделя), и занимать квоту, существующую
 * против массового движения ставок и статусов, они не должны.
 *
 * Решение уровня кампании — тоже нет: население, которым меряется доля, состоит из её
 * же сущностей, а сама кампания в него не входит. За прогон кампания одна, то есть доля
 * от неё не считается ни при каком пороге; занимая слот, она лишь отнимала его у фраз, а
 * на кабинете из трёх фраз (квота — одна сущность) навсегда проигрывала первой из них.
 */
function spendsEntityQuota(decision: Decision): boolean {
  return decision.nextValue.kind !== 'negativeKeyword' && decision.entityType !== 'CAMPAIGN';
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

    const countsTowardShare = spendsEntityQuota(decision);
    if (entityCap !== null && countsTowardShare && !touchedEntities.has(decision.entityId)) {
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

    if (countsTowardShare) touchedEntities.add(decision.entityId);

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

    const key = bidHistoryKey(decision.entityType, decision.entityId);
    if (context.bidHistory.unavailable.has(key)) {
      // Reject, never clamp: без точки отсчёта суммарный лимит неизвестен, а шаговый
      // разрешил бы очередные 30% — то есть ровно то, ради чего эта ветка существует.
      return {
        outcome: 'rejected',
        rail: 'BID_HISTORY_UNAVAILABLE',
        note: 'история изменений ставки за окно недостоверна — суммарный лимит неприменим',
      };
    }

    return clampBid(
      decision,
      decision.prevValue.amount,
      // Ставку в окне не меняли — значит начало окна и есть текущее значение.
      context.bidHistory.anchors.get(key) ?? decision.prevValue.amount,
      decision.nextValue.amount,
      config.maxBidChangePct,
      context.bidHistory.windowDays,
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
        decision: annotate(next, `ограничено guardrail: дневной бюджет ≤ ${formatMoney(ceiling)}`),
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

/**
 * Ставка внутри двух коридоров сразу: шага и окна.
 *
 * Шаговый коридор строится вокруг текущей ставки, оконный — вокруг ставки на начало окна.
 * Без второго предохранитель ловит только опечатку: −15% в сутки ни разу не нарушают
 * лимит в 30%, а за неделю уводят ставку почти на −70%, и кампания уходит с показов не
 * хуже, чем от паузы.
 *
 * Оконная граница никогда не запрещает остаться на текущей ставке: если её уже вынесло за
 * коридор (ставку поправил человек, якорь сместился при сдвиге окна), обратный ход обязан
 * остаться возможным, иначе предохранитель запирает сущность вместо того, чтобы её беречь.
 * Отсюда `max(windowUpper, previous)` и `min(windowLower, previous)` — оконный коридор
 * умеет только сузить шаговый, но не расширить.
 */
function clampBid(
  decision: Decision,
  previous: number,
  anchor: number,
  next: number,
  maxChangePct: number,
  windowDays: number,
): LimitResult {
  const stepUpper = floorMoney(previous * (1 + maxChangePct));
  const stepLower = ceilMoney(previous * (1 - maxChangePct));
  const windowUpper = floorMoney(anchor * (1 + maxChangePct));
  const windowLower = ceilMoney(anchor * (1 - maxChangePct));

  const upper = Math.min(stepUpper, Math.max(windowUpper, previous));
  const lower = Math.max(stepLower, Math.min(windowLower, previous));
  if (next <= upper && next >= lower) return { outcome: 'allowed' };

  const goingUp = next > upper;
  const amount = goingUp ? upper : lower;
  const { rail, limit, cap } = describeBound({
    goingUp,
    bound: amount,
    stepBound: goingUp ? stepUpper : stepLower,
    windowBound: goingUp ? windowUpper : windowLower,
    previous,
    anchor,
    maxChangePct,
    windowDays,
  });

  if (amount === previous) {
    // Урезать до нуля нельзя: решение «поменять на ничего» доехало бы до площадки за
    // баллы и легло бы в ChangeLog записью об изменении, которого не было.
    return {
      outcome: 'rejected',
      rail,
      note:
        `лимит изменения ставки исчерпан (${limit}): запрошено ${formatMoney(next)} ` +
        `от ${formatMoney(previous)}, коридор ${formatMoney(lower)}…${formatMoney(upper)}`,
    };
  }

  // Clamp, not reject: the layer above is right about the direction (CPA really is off target),
  // it is only asking for a bigger step than the limit allows. The remainder can be taken later,
  // which is precisely the intent of a rate limit.
  const clampedDecision = annotate(
    withNextValue(decision, { kind: 'bid', amount }),
    `ограничено guardrail: ${cap} (${formatMoney(next)} → ${formatMoney(amount)})`,
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

interface BoundInput {
  goingUp: boolean;
  /** Граница коридора в эту сторону — та, до которой урезают. */
  bound: number;
  stepBound: number;
  windowBound: number;
  previous: number;
  anchor: number;
  maxChangePct: number;
  windowDays: number;
}

interface BoundDescription {
  rail: GuardrailRail;
  /** Что держит границу — фраза для ноты в скобках. */
  limit: string;
  /** Та же граница в форме, пригодной после «ограничено guardrail:». */
  cap: string;
}

/**
 * Кто именно держит границу коридора — шаг, окно или сама текущая ставка.
 *
 * Третий случай появляется, когда ставку вынесло за коридор окна (её поправил человек
 * или сместился якорь): оконная граница тогда расширяется до текущей ставки, чтобы
 * обратный ход оставался возможным. Нота при этом называла оконный лимит — «30% за 7
 * сут. от 100» при коридоре 140…200, то есть два несовместимых числа в одной строке:
 * человек, разбирающий аудит, видел лимит 130 и коридор до 200 и не мог понять, что
 * сработало. Границу обязана называть та величина, которая её и держит.
 */
function describeBound(input: BoundInput): BoundDescription {
  const { goingUp, bound, stepBound, windowBound, previous, anchor } = input;
  const step = `${formatPercent(input.maxChangePct)}%/сут`;
  const window =
    `${formatPercent(input.maxChangePct)}% за ${input.windowDays} сут. ` +
    `от ${formatMoney(anchor)}`;

  if (bound === stepBound) {
    return { rail: 'MAX_BID_CHANGE', limit: step, cap: `изменение ставки ≤ ${step}` };
  }
  if (bound === previous && windowBound !== previous) {
    const phrase =
      `${goingUp ? 'рост запрещён' : 'снижение запрещено'}: текущая ставка ` +
      `${formatMoney(previous)} уже ${goingUp ? 'выше' : 'ниже'} коридора окна (${window})`;
    return { rail: 'MAX_BID_CHANGE_WINDOW', limit: phrase, cap: phrase };
  }
  return { rail: 'MAX_BID_CHANGE_WINDOW', limit: window, cap: `изменение ставки ≤ ${window}` };
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
