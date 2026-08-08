import type {
  ApprovalDecision,
  ApprovalKind,
  CampaignStatus,
  ChangeActor,
  ClientStatus,
  HandoverMode,
  Provider,
} from '@prisma/client';

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

/** Технические имена действий из ChangeLog — в человеческие. */
const CHANGE_ACTIONS: Record<string, string> = {
  bid_up: 'Ставка повышена',
  bid_down: 'Ставка понижена',
  pause: 'Поставлено на паузу',
  resume: 'Возобновлено',
  budget_change: 'Бюджет изменён',
  negative_keyword: 'Добавлено минус-слово',
  strategy_change: 'Стратегия изменена',
  rollback: 'Откат',
};

export function changeActionLabel(value: string): string {
  return CHANGE_ACTIONS[value] ?? value;
}
