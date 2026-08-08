import type { Provider } from '@prisma/client';

import type { ChannelContext } from '@/channels/types.js';

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
  href?: string;
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
