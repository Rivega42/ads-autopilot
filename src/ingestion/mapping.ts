import {
  AdFormat,
  AdGroupStatus,
  AdStatus,
  CampaignStatus,
  KeywordStatus,
  ModerationStatus,
  Prisma,
} from '@prisma/client';

import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:mapping' });

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

/**
 * Что слово площадки означает про показы. Промежуточный слой нужен, потому что
 * enum'ы уровней разные, а словарь слов — один: пока таблиц было три, значения
 * `STOPPED`, `ENDED` и `CONVERTED` знала только кампания, и то же самое слово на
 * уровне группы или объявления молча уходило в дефолт «работает».
 */
type Lifecycle = 'SERVING' | 'STOPPED' | 'ENDED' | 'ARCHIVED' | 'DRAFT';

type StatusLevel = 'campaign' | 'adgroup' | 'ad' | 'keyword';

const LIFECYCLE_BY_WORD: Record<string, Lifecycle> = {
  ON: 'SERVING',
  ACTIVE: 'SERVING',
  ACCEPTED: 'SERVING',
  PREACCEPTED: 'SERVING',
  SERVING: 'SERVING',
  OFF: 'STOPPED',
  // Директ сам остановил показы: сайт не отвечает. Реклама не крутится, поэтому
  // «работает» по умолчанию тут врало бы — оптимизатор считал бы кампанию живой
  // и двигал ставки по цифрам, которых больше не будет.
  OFF_BY_MONITORING: 'STOPPED',
  PAUSED: 'STOPPED',
  SUSPENDED: 'STOPPED',
  STOPPED: 'STOPPED',
  BLOCKED: 'STOPPED',
  ARCHIVED: 'ARCHIVED',
  DELETED: 'ARCHIVED',
  ENDED: 'ENDED',
  CONVERTED: 'ENDED',
  DRAFT: 'DRAFT',
  MODERATION: 'DRAFT',
  REJECTED: 'DRAFT',
};

const CAMPAIGN_STATUS: Record<Lifecycle, CampaignStatus> = {
  SERVING: CampaignStatus.ACTIVE,
  STOPPED: CampaignStatus.PAUSED,
  ENDED: CampaignStatus.ENDED,
  ARCHIVED: CampaignStatus.ARCHIVED,
  DRAFT: CampaignStatus.DRAFT,
};

/**
 * У группы, объявления и фразы нет своих значений «завершено» и «черновик»:
 * показов в обоих случаях нет, а `ARCHIVED` соврал бы — сущность в кабинете на
 * месте и вернётся в эфир вместе с кампанией. Значит — пауза.
 */
const ADGROUP_STATUS: Record<Lifecycle, AdGroupStatus> = {
  SERVING: AdGroupStatus.ACTIVE,
  STOPPED: AdGroupStatus.PAUSED,
  ENDED: AdGroupStatus.PAUSED,
  ARCHIVED: AdGroupStatus.ARCHIVED,
  DRAFT: AdGroupStatus.PAUSED,
};

const AD_STATUS: Record<Lifecycle, AdStatus> = {
  SERVING: AdStatus.ACTIVE,
  STOPPED: AdStatus.PAUSED,
  ENDED: AdStatus.PAUSED,
  ARCHIVED: AdStatus.ARCHIVED,
  DRAFT: AdStatus.PAUSED,
};

const KEYWORD_STATUS: Record<Lifecycle, KeywordStatus> = {
  SERVING: KeywordStatus.ACTIVE,
  STOPPED: KeywordStatus.PAUSED,
  ENDED: KeywordStatus.PAUSED,
  ARCHIVED: KeywordStatus.ARCHIVED,
  DRAFT: KeywordStatus.PAUSED,
};

/**
 * Слова, о которых уже предупредили. Иначе одно неизвестное значение даёт строку
 * лога на каждое объявление кабинета — а такой поток читать никто не станет.
 * Множество не растёт бесконечно: словарь площадки конечен, и каждое слово
 * попадает сюда один раз за жизнь процесса.
 */
const warnedUnknownWords = new Set<string>();

/**
 * Слово площадки → жизненный цикл.
 *
 * Незнакомое считаем работающим: сущность приехала из кабинета обычным листингом,
 * который удалённое уже отфильтровал, и спрятать живую кампанию из отчётов дороже,
 * чем показать остановленную. Но молчать об этом нельзя — на дефолте «работает»
 * держится и A/B (выключенный вариант выигрывал бы у работающих), и правила
 * оптимизатора, а пробел в словаре иначе не виден ниоткуда.
 */
function lifecycleOf(raw: string, level: StatusLevel): Lifecycle {
  const word = normalize(raw);
  const known = LIFECYCLE_BY_WORD[word];
  if (known !== undefined) return known;

  const seenKey = `${level}:${word}`;
  if (!warnedUnknownWords.has(seenKey)) {
    warnedUnknownWords.add(seenKey);
    log.warn({ level, status: word }, 'unknown entity status from platform, treated as serving');
  }
  return 'SERVING';
}

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

/** Настоящее исчезновение из кабинета ловится отдельно — архивацией. */
export function toCampaignStatus(raw: string): CampaignStatus {
  return CAMPAIGN_STATUS[lifecycleOf(raw, 'campaign')];
}

export function toAdGroupStatus(raw: string): AdGroupStatus {
  return ADGROUP_STATUS[lifecycleOf(raw, 'adgroup')];
}

/** Крутится ли объявление: `Ad.State` у Директа, `banner.status` у VK. */
export function toAdStatus(raw: string): AdStatus {
  return AD_STATUS[lifecycleOf(raw, 'ad')];
}

export function toKeywordStatus(raw: string): KeywordStatus {
  return KEYWORD_STATUS[lifecycleOf(raw, 'keyword')];
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
 * `Search.BiddingStrategyType`, у VK — плоским `autobiddingMode`. Колонка
 * `strategy` строковая, поэтому берём то, что читается человеком в отчёте.
 *
 * Словарь имён живёт здесь, а не в адаптерах: `RemoteCampaign.strategy` — мешок
 * полей площадки, и каждый адаптер вправе назвать их по-своему (Директ отдаёт
 * подобъект как есть, VK — camelCase, как и остальные поля DTO). Место, где эти
 * диалекты сводятся к одной колонке, ровно одно — оно и обязано их знать.
 */
export function strategyName(strategy: Record<string, unknown>): string | null {
  const direct =
    strategy['BiddingStrategyType'] ??
    strategy['autobiddingMode'] ??
    strategy['type'] ??
    strategy['name'];
  if (typeof direct === 'string' && direct !== '') return direct;

  const search = strategy['Search'];
  if (typeof search === 'object' && search !== null) {
    const nested = (search as Record<string, unknown>)['BiddingStrategyType'];
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  return null;
}
