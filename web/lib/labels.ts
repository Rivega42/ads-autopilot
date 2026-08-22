import type {
  AdGroupStatus,
  ApprovalDecision,
  ApprovalKind,
  CampaignStatus,
  ChangeActor,
  ClientStatus,
  HandoverMode,
  Provider,
} from '@prisma/client';

/**
 * Словарь канонических решений — из того же файла, что читает оптимизатор.
 *
 * Импорт только типовой: `src/optimizer/types.ts` объявлен без единой зависимости
 * (там об этом прямо сказано), поэтому в сборку дашборда он не попадает и лишнего
 * пакета в `web/node_modules` не требует. Зато `Record<DecisionAction, string>`
 * ниже краснеет на `pnpm --filter web typecheck`, как только в бэкенде появится
 * новое решение — а это ровно тот случай, ради которого карта и переписывается.
 */
import type { DecisionAction } from '../../src/optimizer/types';

/** Тон бейджа. Совпадает со статусной палитрой в globals.css. */
export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

const PROVIDERS: Record<Provider, string> = {
  YANDEX_DIRECT: 'Яндекс Директ',
  VK_ADS: 'VK Реклама',
  TIKTOK_ADS: 'TikTok Ads',
  LINKEDIN_ADS: 'LinkedIn Ads',
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  TELEGRAM_ADS: 'Telegram Ads',
};

const CAMPAIGN_STATUSES: Record<CampaignStatus, string> = {
  DRAFT: 'Черновик',
  ACTIVE: 'Активна',
  PAUSED: 'На паузе',
  ARCHIVED: 'В архиве',
  ENDED: 'Завершена',
};

const CAMPAIGN_STATUS_TONES: Record<CampaignStatus, Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'good',
  PAUSED: 'warning',
  ARCHIVED: 'neutral',
  ENDED: 'neutral',
};

const CLIENT_STATUSES: Record<ClientStatus, string> = {
  ACTIVE: 'Активен',
  PAUSED: 'На паузе',
  ARCHIVED: 'В архиве',
};

const CLIENT_STATUS_TONES: Record<ClientStatus, Tone> = {
  ACTIVE: 'good',
  PAUSED: 'warning',
  ARCHIVED: 'neutral',
};

const APPROVAL_KINDS: Record<ApprovalKind, string> = {
  BUDGET_CHANGE: 'Изменение бюджета',
  BID_CHANGE: 'Изменение ставок',
  CREATIVE_UPLOAD: 'Загрузка креатива',
  NEGATIVE_KEYWORDS: 'Минус-слова',
  RESUME_ENTITIES: 'Возобновление',
  NEW_CAMPAIGN: 'Новая кампания',
  MASS_PAUSE: 'Массовая пауза',
  STRATEGY_CHANGE: 'Смена стратегии',
  IMPORT_HANDOVER: 'Передача управления',
};

const APPROVAL_DECISIONS: Record<ApprovalDecision, string> = {
  PENDING: 'Ожидает',
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
  EXPIRED: 'Истекло',
  APPLYING: 'Применяется',
  APPLIED: 'Применено',
  FAILED: 'Ошибка',
};

const APPROVAL_DECISION_TONES: Record<ApprovalDecision, Tone> = {
  PENDING: 'warning',
  APPROVED: 'good',
  REJECTED: 'neutral',
  EXPIRED: 'neutral',
  APPLYING: 'serious',
  APPLIED: 'good',
  FAILED: 'critical',
};

const CHANGE_ACTORS: Record<ChangeActor, string> = {
  SYSTEM: 'Система',
  USER: 'Человек',
  AI: 'AI',
};

const HANDOVER_MODES: Record<HandoverMode, string> = {
  OBSERVER: 'Наблюдение',
  ASSIST: 'Подсказки',
  FULL: 'Полное управление',
};

function lookup<T extends string>(table: Record<T, string>, value: T): string {
  return table[value] ?? value;
}

export function providerLabel(value: Provider): string {
  return lookup(PROVIDERS, value);
}

export function campaignStatusLabel(value: CampaignStatus): string {
  return lookup(CAMPAIGN_STATUSES, value);
}

export function campaignStatusTone(value: CampaignStatus): Tone {
  return CAMPAIGN_STATUS_TONES[value] ?? 'neutral';
}

export function clientStatusLabel(value: ClientStatus): string {
  return lookup(CLIENT_STATUSES, value);
}

export function clientStatusTone(value: ClientStatus): Tone {
  return CLIENT_STATUS_TONES[value] ?? 'neutral';
}

export function approvalKindLabel(value: ApprovalKind): string {
  return lookup(APPROVAL_KINDS, value);
}

export function approvalDecisionLabel(value: ApprovalDecision): string {
  return lookup(APPROVAL_DECISIONS, value);
}

export function approvalDecisionTone(value: ApprovalDecision): Tone {
  return APPROVAL_DECISION_TONES[value] ?? 'neutral';
}

export function changeActorLabel(value: ChangeActor): string {
  return lookup(CHANGE_ACTORS, value);
}

export function handoverModeLabel(value: HandoverMode): string {
  return lookup(HANDOVER_MODES, value);
}

/**
 * Названия действий из `ChangeLog.action`.
 *
 * В журнал пишут три разных места, и словари у них разные — поэтому карт три, а
 * не одна. Смешать их нельзя: `budget_change` и `BUDGET_CHANGE` — не опечатка, а
 * два разных события, и различает их только регистр.
 *
 * 1. `applied` — каноническая форма решения (`DecisionAction`): что стало с
 *    сущностью. Пишут `optimizer/apply.ts` и `approval/bid-journal.ts`.
 * 2. `decision` — аудиторская строка апрува (`ApprovalAction['kind']`): что
 *    решил человек в карточке. Пишет `approval/apply.ts`, в том числе в dry-run,
 *    когда до кабинета изменение не доехало вовсе.
 * 3. `service` — служебные отметки модерации (`moderation/repair.ts`).
 */
export type ChangeForm = 'applied' | 'decision' | 'service' | 'unknown';

/** Что стало с сущностью. Ключи держит `DecisionAction`, а не эта строка. */
export const APPLIED_ACTIONS: Record<DecisionAction, string> = {
  PAUSE: 'Остановлено',
  BID_DECREASE: 'Ставка понижена',
  BID_INCREASE: 'Ставка повышена',
  BUDGET_CHANGE: 'Бюджет изменён',
  ADD_NEGATIVE_KEYWORD: 'Добавлено минус-слово',
  NEW_CAMPAIGN: 'Создана кампания',
  STRATEGY_CHANGE: 'Стратегия изменена',
};

/**
 * Что решил человек. Названия начинаются с «Решение», потому что строка
 * рассказывает про нажатую кнопку, а не про состояние кабинета: при dry-run и при
 * отказе площадки она остаётся, а изменения не происходит.
 */
export const DECISION_ACTIONS: Record<string, string> = {
  create_campaign: 'Решение: создать кампанию',
  budget_change: 'Решение: изменить бюджет',
  strategy_change: 'Решение: сменить стратегию',
  pause_entities: 'Решение: остановить',
  resume_entities: 'Решение: возобновить',
  bid_change: 'Решение: изменить ставки',
  add_negatives: 'Решение: добавить минус-слова',
  upload_creatives: 'Решение: загрузить креативы',
};

export const SERVICE_ACTIONS: Record<string, string> = {
  moderation_rewrite: 'Текст объявления переписан',
  moderation_escalated: 'Модерация: передано человеку',
  moderation_missing: 'Объявление пропало из кабинета',
};

/** Действия, двигающие ставку. Зеркало `BID_ACTIONS` из `optimizer/bid-history.ts`. */
const BID_ACTIONS: readonly DecisionAction[] = ['BID_DECREASE', 'BID_INCREASE'];

/**
 * Карты — обычные объекты, поэтому `map[value]` находит и `constructor`, и
 * `toString`. Без проверки собственного ключа человек увидел бы в журнале
 * исходник функции вместо названия действия.
 */
function own(table: Record<string, string>, value: string): string | null {
  return Object.prototype.hasOwnProperty.call(table, value) ? (table[value] ?? null) : null;
}

export interface ChangeSubject {
  readonly action: string;
  readonly actor: ChangeActor;
  /** Telegram-имя подтвердившего. Заполняет только `approval/bid-journal.ts`. */
  readonly approvedBy: string | null;
}

export interface ChangeView {
  /** Что показать человеку. У незнакомого действия — сам идентификатор. */
  readonly label: string;
  readonly form: ChangeForm;
  /**
   * Строка описывает изменение, которое уже показано соседней строкой решения.
   * Человек не должен посчитать её вторым изменением.
   */
  readonly duplicate: boolean;
  /** Сноска под названием либо `null`. */
  readonly note: string | null;
}

const UNKNOWN_NOTE = 'действия нет в карте названий витрины — она отстала от кода';

/**
 * Строка журнала, выпущенная человеком через карточку ставки, всегда идёт парой:
 * аудиторская (`bid_change`) и каноническая (`BID_DECREASE`/`BID_INCREASE`).
 * Каноническую пишет только `approval/bid-journal.ts`, и только она сочетает
 * действие-ставку с `actor = USER` и заполненным `approvedBy`: ночной прогон
 * оптимизатора ставит `AI` и `approvedBy` не пишет вовсе. Признак точный —
 * ни окон по времени, ни сравнения текстов причин не требуется.
 */
function isApprovedBidTwin(row: ChangeSubject): boolean {
  return (
    row.actor === 'USER' &&
    row.approvedBy !== null &&
    row.approvedBy !== '' &&
    BID_ACTIONS.some((candidate) => candidate === row.action)
  );
}

export function describeChange(row: ChangeSubject): ChangeView {
  const applied = own(APPLIED_ACTIONS, row.action);
  if (applied !== null) {
    const duplicate = isApprovedBidTwin(row);
    return {
      label: applied,
      form: 'applied',
      duplicate,
      note: duplicate
        ? 'та же правка, что и в строке решения человека: запись нужна предохранителю ставок'
        : null,
    };
  }

  const decision = own(DECISION_ACTIONS, row.action);
  if (decision !== null) return { label: decision, form: 'decision', duplicate: false, note: null };

  const service = own(SERVICE_ACTIONS, row.action);
  if (service !== null) return { label: service, form: 'service', duplicate: false, note: null };

  return { label: row.action, form: 'unknown', duplicate: false, note: UNKNOWN_NOTE };
}

/** Только название — для мест, где формы записи не важны. */
export function changeActionLabel(value: string): string {
  return (
    own(APPLIED_ACTIONS, value) ??
    own(DECISION_ACTIONS, value) ??
    own(SERVICE_ACTIONS, value) ??
    value
  );
}

const AD_GROUP_STATUSES: Record<AdGroupStatus, string> = {
  ACTIVE: 'Активна',
  PAUSED: 'На паузе',
  ARCHIVED: 'В архиве',
};

const AD_GROUP_STATUS_TONES: Record<AdGroupStatus, Tone> = {
  ACTIVE: 'good',
  PAUSED: 'warning',
  ARCHIVED: 'neutral',
};

export function adGroupStatusLabel(value: AdGroupStatus): string {
  return lookup(AD_GROUP_STATUSES, value);
}

export function adGroupStatusTone(value: AdGroupStatus): Tone {
  return AD_GROUP_STATUS_TONES[value] ?? 'neutral';
}
