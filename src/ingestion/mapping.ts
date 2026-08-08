import {
  AdFormat,
  AdGroupStatus,
  CampaignStatus,
  KeywordStatus,
  ModerationStatus,
} from '@prisma/client';
import { Prisma } from '@prisma/client';

/** Decimal(12,2) — бюджеты и ставки. */
export const MONEY_SCALE = 2;
/** Decimal(14,4) — расход и производные метрики. */
export const SPEND_SCALE = 4;

/**
 * `number` из DTO адаптера → `Decimal` колонки.
 *
 * Через строку фиксированной точности, а не через конструктор от числа: у
 * `0.1 + 0.2` двоичное представление тянет хвост `…04`, и Decimal сохранил бы
 * его целиком, а потом Postgres округлил бы по своим правилам. Округляем сами,
 * ровно в масштаб колонки, чтобы записанное значение совпадало с посчитанным.
 */
export function toDecimal(value: number | null | undefined, scale: number): Prisma.Decimal {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return new Prisma.Decimal(0);
  }
  return new Prisma.Decimal(value.toFixed(scale));
}

/** Производная метрика: null вместо деления на ноль — «нет данных», а не «ноль». */
export function ratioOrNull(
  numerator: number,
  denominator: number,
  scale: number,
): Prisma.Decimal | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return toDecimal(numerator / denominator, scale);
}

/**
 * Сырой объект площадки → значение JSON-колонки.
 *
 * Прогон через JSON нужен не ради типа: в разобранном ответе попадаются
 * `undefined` (опциональные поля zod), а Prisma на них падает уже в рантайме.
 */
export function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function normalize(raw: string): string {
  return raw.trim().toUpperCase();
}

const CAMPAIGN_STATUS: Record<string, CampaignStatus> = {
  ON: CampaignStatus.ACTIVE,
  ACTIVE: CampaignStatus.ACTIVE,
  ACCEPTED: CampaignStatus.ACTIVE,
  PREACCEPTED: CampaignStatus.ACTIVE,
  SERVING: CampaignStatus.ACTIVE,
  OFF: CampaignStatus.PAUSED,
  PAUSED: CampaignStatus.PAUSED,
  SUSPENDED: CampaignStatus.PAUSED,
  STOPPED: CampaignStatus.PAUSED,
  BLOCKED: CampaignStatus.PAUSED,
  ARCHIVED: CampaignStatus.ARCHIVED,
  DELETED: CampaignStatus.ARCHIVED,
  ENDED: CampaignStatus.ENDED,
  CONVERTED: CampaignStatus.ENDED,
  DRAFT: CampaignStatus.DRAFT,
  MODERATION: CampaignStatus.DRAFT,
  REJECTED: CampaignStatus.DRAFT,
};

const ADGROUP_STATUS: Record<string, AdGroupStatus> = {
  ON: AdGroupStatus.ACTIVE,
  ACTIVE: AdGroupStatus.ACTIVE,
  ACCEPTED: AdGroupStatus.ACTIVE,
  PREACCEPTED: AdGroupStatus.ACTIVE,
  OFF: AdGroupStatus.PAUSED,
  PAUSED: AdGroupStatus.PAUSED,
  SUSPENDED: AdGroupStatus.PAUSED,
  BLOCKED: AdGroupStatus.PAUSED,
  DRAFT: AdGroupStatus.PAUSED,
  MODERATION: AdGroupStatus.PAUSED,
  REJECTED: AdGroupStatus.PAUSED,
  ARCHIVED: AdGroupStatus.ARCHIVED,
  DELETED: AdGroupStatus.ARCHIVED,
};

const KEYWORD_STATUS: Record<string, KeywordStatus> = {
  ON: KeywordStatus.ACTIVE,
  ACTIVE: KeywordStatus.ACTIVE,
  ACCEPTED: KeywordStatus.ACTIVE,
  PREACCEPTED: KeywordStatus.ACTIVE,
  OFF: KeywordStatus.PAUSED,
  PAUSED: KeywordStatus.PAUSED,
  SUSPENDED: KeywordStatus.PAUSED,
  BLOCKED: KeywordStatus.PAUSED,
  DRAFT: KeywordStatus.PAUSED,
  MODERATION: KeywordStatus.PAUSED,
  REJECTED: KeywordStatus.PAUSED,
  ARCHIVED: KeywordStatus.ARCHIVED,
  DELETED: KeywordStatus.ARCHIVED,
};

const MODERATION: Record<string, ModerationStatus> = {
  ACCEPTED: ModerationStatus.APPROVED,
  PREACCEPTED: ModerationStatus.APPROVED,
  APPROVED: ModerationStatus.APPROVED,
  ALLOWED: ModerationStatus.APPROVED,
  ACTIVE: ModerationStatus.APPROVED,
  REJECTED: ModerationStatus.REJECTED,
  BANNED: ModerationStatus.REJECTED,
  BLOCKED: ModerationStatus.REJECTED,
  DRAFT: ModerationStatus.PENDING,
  MODERATION: ModerationStatus.PENDING,
  PENDING: ModerationStatus.PENDING,
  NEW: ModerationStatus.PENDING,
};

/**
 * Незнакомый статус трактуем как «работает».
 *
 * Сущность приехала из кабинета обычным листингом, который удалённое уже
 * отфильтровал; спрятать живую кампанию из отчётов дороже, чем показать
 * остановленную. Настоящее исчезновение из кабинета ловится отдельно — архивацией.
 */
export function toCampaignStatus(raw: string): CampaignStatus {
  return CAMPAIGN_STATUS[normalize(raw)] ?? CampaignStatus.ACTIVE;
}

export function toAdGroupStatus(raw: string): AdGroupStatus {
  return ADGROUP_STATUS[normalize(raw)] ?? AdGroupStatus.ACTIVE;
}

export function toKeywordStatus(raw: string): KeywordStatus {
  return KEYWORD_STATUS[normalize(raw)] ?? KeywordStatus.ACTIVE;
}

export function toModerationStatus(raw: string): ModerationStatus {
  return MODERATION[normalize(raw)] ?? ModerationStatus.PENDING;
}

/**
 * Формат объявления по тому единственному признаку, который есть в контракте
 * канала. Видео и карусель адаптеры пока не различают — см. RemoteAd.
 */
export function toAdFormat(ad: { imageUrl?: string }): AdFormat {
  return ad.imageUrl ? AdFormat.IMAGE : AdFormat.TEXT;
}

/**
 * Имя стратегии из вложенного объекта площадки: у Директа оно лежит в
 * `Search.BiddingStrategyType`, у VK — плоским полем. Колонка `strategy`
 * строковая, поэтому берём то, что читается человеком в отчёте.
 */
export function strategyName(strategy: Record<string, unknown>): string | null {
  const direct = strategy['BiddingStrategyType'] ?? strategy['type'] ?? strategy['name'];
  if (typeof direct === 'string' && direct !== '') return direct;

  const search = strategy['Search'];
  if (typeof search === 'object' && search !== null) {
    const nested = (search as Record<string, unknown>)['BiddingStrategyType'];
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  return null;
}
