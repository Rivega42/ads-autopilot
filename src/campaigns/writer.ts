import type { Provider } from '@prisma/client';

import type { ChannelContext } from '@/channels/types.js';
import { AppError } from '@/lib/errors.js';

/**
 * Контракт создания сущностей в кабинете.
 *
 * `ChannelAdapter` (src/channels/types.ts) сегодня умеет только читать и править уже
 * существующее: ставки, бюджеты, пауза, возобновление. Методов создания в нём нет,
 * а файл общий — поэтому недостающая часть контракта живёт здесь, рядом с тем эпиком,
 * которому она понадобилась. Когда `create*` перестанут быть нужны только созданию
 * кампаний (следующий кандидат — заливка креативов), интерфейс переезжает в
 * `ChannelAdapter`, а этот модуль остаётся псевдонимом.
 *
 * Правила — те же, что у остальных write-методов адаптера:
 *  • `ctx.dryRun` уважается ДО вызова writer'а: сюда в dry-run не приходят вовсе,
 *    и реализация обязана падать, если пришли, — молчаливый запрос в сеть в dry-run
 *    хуже исключения;
 *  • ошибки площадки приводятся к ChannelError/AuthError/RateLimitError/OutOfUnitsError;
 *  • ответы валидируются zod.
 */

/**
 * Что известно про кабинет, когда создание упало.
 *
 *  • `not-created` — площадка отказала до записи: повторять безопасно;
 *  • `unknown` — ответ потерян (таймаут, 5xx, чужая форма тела). Объект мог быть
 *    создан и уже тратить деньги, а второго ключа идемпотентности у нас нет.
 *
 * Значение по умолчанию — `unknown`: молча считать «ничего не создалось» дороже,
 * чем позвать человека посмотреть кабинет.
 */
export type CreateOutcome = 'not-created' | 'unknown';

/** Ключ в `AppError.context`. Канал-независимый: у VK и TikTok та же развилка. */
export const CREATE_OUTCOME_KEY = 'createOutcome';

/**
 * Помечает ошибку создания известной судьбой. Возвращает ту же ошибку, чтобы
 * писалось `throw markCreateOutcome(err, 'not-created')` и не терялся тип и стек.
 */
export function markCreateOutcome<E>(err: E, outcome: CreateOutcome): E {
  if (err instanceof AppError) err.context[CREATE_OUTCOME_KEY] = outcome;
  return err;
}

/** Судьба создания по ошибке. Всё непомеченное — `unknown`. */
export function createOutcomeOf(err: unknown): CreateOutcome {
  if (err instanceof AppError && err.context[CREATE_OUTCOME_KEY] === 'not-created') {
    return 'not-created';
  }
  return 'unknown';
}

export interface CampaignCreateSpec {
  name: string;
  dailyBudgetRub: number;
  /** Обе стороны стратегии сразу: Директ заменяет её целиком. */
  strategy: {
    search: { type: string; settings?: Record<string, unknown> };
    network: { type: string; settings?: Record<string, unknown> };
  };
  negativeKeywords: string[];
  /** yyyy-MM-dd. Директ требует дату старта при создании. */
  startDate: string;
}

export interface AdGroupCreateSpec {
  name: string;
  /** Номера регионов показа; минус-регионы — отрицательными числами. */
  regionIds: number[];
  negativeKeywords: string[];
}

export interface KeywordCreateSpec {
  adGroupExternalId: string;
  phrase: string;
  bidRub: number;
}

export interface AdCreateSpec {
  adGroupExternalId: string;
  title: string;
  title2?: string;
  text: string;
  /**
   * Куда ведёт объявление. Не опционально: у Директа объявление обязано иметь цель
   * показа (Href / TurboPageId / VCardId / BusinessId), и Href — единственная из них,
   * которую система умеет заполнить.
   */
  href: string;
}

export interface CreatedEntity {
  externalId: string;
}

export interface CreatedNamedEntity extends CreatedEntity {
  name: string;
}

export interface CampaignWriter {
  readonly channel: Provider;

  createCampaign(ctx: ChannelContext, spec: CampaignCreateSpec): Promise<CreatedEntity>;

  /**
   * Создаёт группы и возвращает их **в порядке входа**: i-я запись ответа — про
   * i-ю группу спецификации.
   *
   * Порядок — единственный способ связать созданное с планом. Имя для этого не
   * годится: уникальности `Name` внутри кампании Директ не требует
   * (`AdGroups.add`: «от 1 до 255 символов», и только) — две группы с одинаковым
   * именем создаются обе и живут дальше с разными id. Ответ короче входа означает,
   * что часть групп не создалась; длиннее он быть не может.
   */
  createAdGroups(
    ctx: ChannelContext,
    campaignExternalId: string,
    groups: readonly AdGroupCreateSpec[],
  ): Promise<CreatedNamedEntity[]>;

  createKeywords(
    ctx: ChannelContext,
    keywords: readonly KeywordCreateSpec[],
  ): Promise<CreatedEntity[]>;

  createAds(ctx: ChannelContext, ads: readonly AdCreateSpec[]): Promise<CreatedEntity[]>;

  /**
   * Отправить созданные объявления на модерацию.
   *
   * Отдельным шагом, потому что в Директе объявление создаётся в статусе DRAFT и
   * само на модерацию не уходит: без этого вызова кампания существует, но не крутится.
   * Необязателен: у площадок, где модерация начинается автоматически, метода нет.
   */
  submitForModeration?(ctx: ChannelContext, adExternalIds: readonly string[]): Promise<void>;
}
