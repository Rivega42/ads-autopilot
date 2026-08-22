import type { ApprovalAction } from '@/approval/types.js';
import { env } from '@/env.js';

/**
 * Политика «что нельзя делать без человека» (TZ §3.5).
 *
 * Модуль намеренно чистый: ни БД, ни сети, ни времени. Это единственное место,
 * где решается, уходит операция в Telegram или применяется автоматом, поэтому
 * его должно быть можно прогнать таблицей кейсов за миллисекунды.
 */

/**
 * Изменение дневного бюджета более чем на столько — к человеку.
 *
 * Значение приезжает из окружения, а не стоит здесь литералом. Пока литерал был
 * тут, а `src/optimizer/policy.ts` читал `BUDGET_CHANGE_THRESHOLD_PCT`, решал
 * именно литерал: `matchApprovalRule` — гейт `requestApprovalIfNeeded`, и по нему
 * же пишется текст карточки. Человек, выставивший переменную в проде, считал порог
 * настроенным. Тот же случай уже был с `MAX_BID_CHANGE_PCT`.
 *
 * Переменная — доля (0.2 = 20%): `src/env.ts` роняет старт на значении больше
 * единицы, чтобы «20» не превратилось в 2000%.
 */
export const BUDGET_CHANGE_APPROVAL_THRESHOLD = env.BUDGET_CHANGE_THRESHOLD_PCT;

/** Отключение большего числа сущностей за раз считается массовым. */
export const MASS_PAUSE_ENTITY_THRESHOLD = 10;

export type ApprovalRuleCode = 'new_campaign' | 'budget_change_over_threshold' | 'mass_pause';

export interface ApprovalRule {
  code: ApprovalRuleCode;
  /** Формулировка для карточки — её увидит человек. */
  title: string;
}

const RULES: Record<ApprovalRuleCode, ApprovalRule> = {
  new_campaign: { code: 'new_campaign', title: 'создание новой кампании' },
  budget_change_over_threshold: {
    code: 'budget_change_over_threshold',
    title: `изменение дневного бюджета более чем на ${Math.round(
      BUDGET_CHANGE_APPROVAL_THRESHOLD * 100,
    )}%`,
  },
  mass_pause: {
    code: 'mass_pause',
    title: `массовое отключение (более ${MASS_PAUSE_ENTITY_THRESHOLD} сущностей)`,
  },
};

/**
 * Относительное изменение бюджета.
 *
 * Бюджет 0 → любое ненулевое значение это не «+X%», а включение расхода с нуля;
 * возвращаем Infinity, чтобы такое всегда уходило человеку, а не делилось на ноль.
 */
export function budgetChangeRatio(before: number, after: number): number {
  if (before === after) return 0;
  if (before <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(after - before) / before;
}

/**
 * Какое правило требует апрува для этого действия, или null — можно автоматом.
 * Возвращаем правило, а не boolean, чтобы карточка объяснила человеку, почему его позвали.
 */
export function matchApprovalRule(action: ApprovalAction): ApprovalRule | null {
  switch (action.kind) {
    case 'create_campaign':
      return RULES.new_campaign;

    case 'budget_change':
      return budgetChangeRatio(action.before, action.after) > BUDGET_CHANGE_APPROVAL_THRESHOLD
        ? RULES.budget_change_over_threshold
        : null;

    case 'pause_entities':
      return action.externalIds.length > MASS_PAUSE_ENTITY_THRESHOLD ? RULES.mass_pause : null;

    // Возобновление, ставки и минус-слова в списке TZ §3.5 не значатся: они
    // обратимы и уже ограничены предохранителями оптимизатора (MAX_BID_CHANGE_PCT).
    case 'resume_entities':
    case 'bid_change':
    case 'add_negatives':
      return null;

    default: {
      // Новый вид действия обязан явно решить, нужен ли ему человек, — иначе не соберётся.
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function requiresApproval(action: ApprovalAction): boolean {
  return matchApprovalRule(action) !== null;
}
