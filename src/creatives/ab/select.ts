import {
  ctr,
  requiredTrialsPerVariant,
  twoProportionZTest,
  wilsonInterval,
  type Interval,
  type ProportionCounts,
} from './stats.js';

/**
 * Выбор победителя A/B-теста креативов (TZ §13.3).
 *
 * ТЗ формулирует правило как «3 варианта → 500 показов → победитель по CTR».
 * Реализовано оно здесь иначе, и это осознанное расхождение:
 *
 *  • 500 показов — порог «пора смотреть», а не «есть победитель». При CTR 2% это
 *    ~10 кликов на вариант; разница 8 против 12 кликов не отличима от шума.
 *  • Победитель объявляется, только когда лидер значимо обошёл КАЖДОГО соперника
 *    и обошёл заметно (минимальный относительный прирост). Иначе статус —
 *    «данных не хватает», и это нормальный, ожидаемый ответ, а не сбой.
 *
 * Дисциплина та же, что у `optimizer/guardrails.ts`: недостаток данных не делает
 * решение меньше, он делает его несостоятельным целиком, поэтому — отказ, не скидка.
 */

export interface VariantCounts {
  variantId: string;
  impressions: number;
  clicks: number;
  /**
   * Человекочитаемое имя варианта — заголовок объявления. Без него в карточку уходит
   * отпечаток текста (`t-9f3a1b…`), по которому человек не может понять, что именно
   * ему предлагают выключить. То же требование, что и у `Decision.label` оптимизатора.
   */
  label?: string;
}

export interface AbTestConfig {
  /** TZ §13.3: 500 показов на вариант. Нижняя граница, после которой можно смотреть. */
  minImpressionsPerVariant: number;
  /** np ≥ 5 и n(1−p) ≥ 5: граница применимости нормального приближения. */
  minExpectedCount: number;
  /** Уровень значимости ДО поправки на множественность сравнений. */
  alpha: number;
  /**
   * Минимальный относительный прирост CTR лидера над соперником. Статистическая
   * значимость на больших числах ловит и +1%, ради которого никто не станет
   * переделывать объявления; порог отделяет «различие есть» от «различие стоит денег».
   */
  minRelativeLift: number;
  /** Мощность, под которую считается рекомендация «сколько показов ещё нужно». */
  power: number;
  /**
   * Сколько дней эксперимент имеет право оставаться в статусе «данные набираются».
   *
   * Без срока «набираем данные» — это вечный ответ: вариант, остановленный на двенадцати
   * показах, никогда не доберёт свои 500, а решение по остальным так и не будет принято.
   * По истечении срока статус становится «неубедительно» — это уже повод действовать
   * (оставить всё как есть, выключить эксперимент, переписать креативы), а не ждать.
   */
  maxCollectingDays: number;
}

export const DEFAULT_AB_TEST: AbTestConfig = {
  minImpressionsPerVariant: 500,
  minExpectedCount: 5,
  alpha: 0.05,
  minRelativeLift: 0.1,
  power: 0.8,
  maxCollectingDays: 14,
};

export type AbStatus = 'collecting' | 'inconclusive' | 'winner';

export type AbReasonCode =
  | 'NOT_ENOUGH_VARIANTS'
  | 'MIN_IMPRESSIONS'
  | 'TOO_FEW_CLICKS'
  | 'TIE'
  | 'NOT_SIGNIFICANT'
  | 'LIFT_TOO_SMALL'
  | 'COLLECTION_TIMEOUT'
  | 'WINNER';

export interface SelectWinnerOptions {
  /** Возраст эксперимента в днях. Не задан — срок не проверяется. */
  elapsedDays?: number;
}

export interface VariantReport {
  variantId: string;
  /** Заголовок объявления; null — имени не передали, в тексте останется id. */
  label: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  /** Доверительный интервал Уилсона для CTR на уровне `1 − alpha`. */
  ctrInterval: Interval;
  /**
   * false — вариант не добрал минимума показов. Такой вариант не участвует в
   * сравнении, а значит и проиграть не может: см. `losingVariantIds`.
   */
  eligible: boolean;
}

export interface VariantComparison {
  /** С кем сравнивали лидера. */
  variantId: string;
  pValue: number;
  /** alpha после поправки Бонферрони на число сравнений. */
  alphaAdjusted: number;
  significant: boolean;
  /** Относительный прирост CTR лидера над этим вариантом. */
  relativeLift: number;
  approximationValid: boolean;
}

export interface AbDecision {
  status: AbStatus;
  /** id победителя или null. Заполнен только при status === 'winner'. */
  winner: string | null;
  reasonCode: AbReasonCode;
  /** Человеческая формулировка для карточки в TG и для отчёта. */
  reason: string;
  variants: VariantReport[];
  comparisons: VariantComparison[];
  /**
   * Сколько показов на вариант нужно, чтобы поймать `minRelativeLift` при текущем CTR.
   * null — оценить нельзя (нет ни одного клика). Заполняется, когда победителя нет:
   * без этого числа отказ выглядит как «система не работает».
   */
  requiredImpressionsPerVariant: number | null;
  config: AbTestConfig;
}

function counts(variant: VariantCounts): ProportionCounts {
  return { successes: variant.clicks, trials: variant.impressions };
}

function formatCtr(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** Имя варианта для человека. id остаётся только там, где имени не дали вовсе. */
function nameOf(variants: readonly VariantReport[], variantId: string): string {
  return variants.find((v) => v.variantId === variantId)?.label ?? variantId;
}

/**
 * Решение по набору вариантов.
 *
 * Порядок проверок неслучаен: сначала «есть ли что сравнивать», потом «набралось ли
 * данных», и только в конце — сама статистика. Обратный порядок дал бы p-value,
 * посчитанное по трём кликам, и красивый, но выдуманный ответ.
 */
export function selectWinner(
  input: readonly VariantCounts[],
  config: AbTestConfig = DEFAULT_AB_TEST,
  options: SelectWinnerOptions = {},
): AbDecision {
  const variants: VariantReport[] = input.map((variant) => ({
    variantId: variant.variantId,
    label: variant.label ?? null,
    impressions: variant.impressions,
    clicks: variant.clicks,
    ctr: ctr(counts(variant)),
    ctrInterval: wilsonInterval(counts(variant), config.alpha),
    eligible: variant.impressions >= config.minImpressionsPerVariant,
  }));

  const pooledCtr = pooled(input);
  const required = requiredTrialsPerVariant(
    pooledCtr,
    config.minRelativeLift,
    adjustedAlpha(config.alpha, input.length),
    config.power,
  );

  const base = { variants, comparisons: [] as VariantComparison[], config };

  if (input.length < 2) {
    return {
      ...base,
      status: 'inconclusive',
      winner: null,
      reasonCode: 'NOT_ENOUGH_VARIANTS',
      reason: 'Сравнивать не с чем: в тесте меньше двух вариантов.',
      requiredImpressionsPerVariant: required,
    };
  }

  /**
   * Сравниваем только набравшие минимум.
   *
   * Раньше один недобравший вариант останавливал весь набор: объявление, снятое с
   * показа на двенадцатом показе, замораживало эксперимент, где между лидерами уже
   * пропасть. Недобравший вариант остаётся в отчёте с пометкой `eligible: false` —
   * он не исчезает, он просто не участвует в сравнении, пока не наберёт данных.
   */
  const ready = variants.filter((v) => v.eligible);
  const notReady = variants.filter((v) => !v.eligible);
  if (ready.length < 2) {
    const worst = notReady.length > 0 ? Math.min(...notReady.map((v) => v.impressions)) : 0;
    return collecting(
      base,
      'MIN_IMPRESSIONS',
      `Данные ещё набираются: ${notReady.length} из ${variants.length} вариантов не добрали ` +
        `${config.minImpressionsPerVariant} показов (минимум по набору — ${worst}).`,
      required,
      config,
      options,
    );
  }

  const sorted = [...ready].sort((a, b) => b.ctr - a.ctr);
  const leader = sorted[0];
  const runnerUp = sorted[1];
  if (leader === undefined || runnerUp === undefined) {
    // Недостижимо: длина проверена выше. Ветка существует ради noUncheckedIndexedAccess.
    return {
      ...base,
      status: 'inconclusive',
      winner: null,
      reasonCode: 'NOT_ENOUGH_VARIANTS',
      reason: 'Сравнивать не с чем: в тесте меньше двух вариантов.',
      requiredImpressionsPerVariant: required,
    };
  }

  if (leader.ctr === runnerUp.ctr) {
    return {
      ...base,
      status: 'inconclusive',
      winner: null,
      reasonCode: 'TIE',
      reason: `У двух вариантов одинаковый CTR (${formatCtr(leader.ctr)}) — выбирать не из чего.`,
      requiredImpressionsPerVariant: required,
    };
  }

  const rivals = sorted.slice(1);
  // Поправка считается по числу реально сделанных сравнений, а не по размеру набора:
  // варианты, не добравшие показов, ни с кем не сравнивались.
  const alphaAdjusted = adjustedAlpha(config.alpha, ready.length);
  const comparisons: VariantComparison[] = [];

  for (const rival of rivals) {
    const test = twoProportionZTest(
      { successes: leader.clicks, trials: leader.impressions },
      { successes: rival.clicks, trials: rival.impressions },
      config.minExpectedCount,
    );
    if (test === null) continue;
    comparisons.push({
      variantId: rival.variantId,
      pValue: test.pValue,
      alphaAdjusted,
      significant: test.pValue < alphaAdjusted,
      relativeLift: rival.ctr > 0 ? leader.ctr / rival.ctr - 1 : Number.POSITIVE_INFINITY,
      approximationValid: test.approximationValid,
    });
  }

  const withDecision = { ...base, comparisons };

  const shaky = comparisons.filter((c) => !c.approximationValid);
  if (shaky.length > 0) {
    const totalClicks = ready.reduce((acc, v) => acc + v.clicks, 0);
    return collecting(
      withDecision,
      'TOO_FEW_CLICKS',
      `Кликов слишком мало для проверки: всего ${totalClicks} на ${ready.length} вариантов. ` +
        `Нужно не меньше ${config.minExpectedCount} ожидаемых кликов и непокликов в каждой группе.`,
      required,
      config,
      options,
    );
  }

  const insignificant = comparisons.filter((c) => !c.significant);
  if (insignificant.length > 0) {
    const worst = insignificant.reduce((a, b) => (a.pValue > b.pValue ? a : b));
    return {
      ...withDecision,
      status: 'inconclusive',
      winner: null,
      reasonCode: 'NOT_SIGNIFICANT',
      reason:
        `Лидер «${nameOf(variants, leader.variantId)}» (CTR ${formatCtr(leader.ctr)}) ` +
        `не отличается значимо от «${nameOf(variants, worst.variantId)}» ` +
        `(CTR ${formatCtr(byId(variants, worst.variantId))}): ` +
        `p = ${worst.pValue.toFixed(3)} при пороге ${alphaAdjusted.toFixed(3)}. ` +
        `Разница в пределах шума — победителя нет.`,
      requiredImpressionsPerVariant: required,
    };
  }

  const small = comparisons.filter((c) => c.relativeLift < config.minRelativeLift);
  if (small.length > 0) {
    const worst = small.reduce((a, b) => (a.relativeLift < b.relativeLift ? a : b));
    return {
      ...withDecision,
      status: 'inconclusive',
      winner: null,
      reasonCode: 'LIFT_TOO_SMALL',
      reason:
        `Разница значима, но мала: лидер «${nameOf(variants, leader.variantId)}» обходит ` +
        `«${nameOf(variants, worst.variantId)}» ` +
        `на ${(worst.relativeLift * 100).toFixed(1)}% при пороге ` +
        `${(config.minRelativeLift * 100).toFixed(0)}%. Менять креатив ради этого не стоит.`,
      requiredImpressionsPerVariant: required,
    };
  }

  return {
    ...withDecision,
    status: 'winner',
    winner: leader.variantId,
    reasonCode: 'WINNER',
    reason:
      `Победитель «${nameOf(variants, leader.variantId)}»: CTR ${formatCtr(leader.ctr)} ` +
      `(интервал ${formatCtr(leader.ctrInterval.low)}…${formatCtr(leader.ctrInterval.high)}) ` +
      `против ${formatCtr(runnerUp.ctr)} у ближайшего соперника, ` +
      `p = ${maxPValue(comparisons).toFixed(4)} при пороге ${alphaAdjusted.toFixed(3)}.`,
    requiredImpressionsPerVariant: null,
  };
}

/**
 * Варианты, которые действительно проиграли: их сравнили с победителем и они уступили.
 *
 * Не «все, кроме победителя». Вариант, не добравший минимума показов, ни с кем не
 * сравнивался — он не проиграл, у него просто нет данных. Разница не формальная:
 * проигравший уходит на паузу, а выключенный вариант больше никогда не наберёт
 * показов, чтобы себя оправдать. Лучший креатив группы с 400 показами и CTR 8%
 * попадал в этот список ровно по этой ошибке.
 */
export function losingVariantIds(decision: AbDecision): string[] {
  const winner = decision.winner;
  if (decision.status !== 'winner' || winner === null) return [];
  const compared = new Set(decision.comparisons.map((c) => c.variantId));
  return decision.variants
    .filter((v) => v.eligible && v.variantId !== winner && compared.has(v.variantId))
    .map((v) => v.variantId);
}

type DecisionBase = Pick<AbDecision, 'variants' | 'comparisons' | 'config'>;

/**
 * Ответ «данные набираются» — либо срок вышел, и тогда это уже «неубедительно».
 *
 * Разница не косметическая: `collecting` означает «вернись позже», и вызывающий имеет
 * право ничего не делать. Просроченный эксперимент такого права не даёт.
 */
function collecting(
  base: DecisionBase,
  reasonCode: AbReasonCode,
  reason: string,
  required: number | null,
  config: AbTestConfig,
  options: SelectWinnerOptions,
): AbDecision {
  const elapsed = options.elapsedDays;
  if (elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= config.maxCollectingDays) {
    return {
      ...base,
      status: 'inconclusive',
      winner: null,
      reasonCode: 'COLLECTION_TIMEOUT',
      reason:
        `Эксперимент идёт ${Math.round(elapsed)} дн. при сроке ${config.maxCollectingDays} — ` +
        `данных так и не набралось. ${reason} Ждать дальше смысла нет: решает человек.`,
      requiredImpressionsPerVariant: required,
    };
  }
  return {
    ...base,
    status: 'collecting',
    winner: null,
    reasonCode,
    reason,
    requiredImpressionsPerVariant: required,
  };
}

/**
 * Поправка Бонферрони: лидера сравниваем с каждым из остальных, значит сравнений
 * k−1. Без поправки при трёх вариантах вероятность объявить победителя на пустом
 * месте — уже не 5%, а около 10%.
 */
export function adjustedAlpha(alpha: number, variantCount: number): number {
  const comparisons = Math.max(1, variantCount - 1);
  return alpha / comparisons;
}

function pooled(input: readonly VariantCounts[]): number {
  const impressions = input.reduce((acc, v) => acc + v.impressions, 0);
  const clicks = input.reduce((acc, v) => acc + v.clicks, 0);
  return impressions > 0 ? clicks / impressions : 0;
}

function byId(variants: readonly VariantReport[], variantId: string): number {
  return variants.find((v) => v.variantId === variantId)?.ctr ?? 0;
}

function maxPValue(comparisons: readonly VariantComparison[]): number {
  return comparisons.reduce((acc, c) => Math.max(acc, c.pValue), 0);
}
