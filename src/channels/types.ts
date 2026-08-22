import type { Provider } from '@prisma/client';

/**
 * Единый контракт для всех рекламных площадок.
 *
 * Смысл абстракции: оптимизатор, репортер и approval-flow не должны знать,
 * что у Директа кампания зовётся Campaign, а у VK — AdPlan. Адаптер переводит
 * доменные операции в вызовы конкретного API и обратно.
 *
 * Правила для реализаций:
 *  • Никакого состояния между вызовами, кроме кешей токенов.
 *  • Любой write обязан уважать `ctx.dryRun` — при true вернуть план, ничего не записав.
 *  • Ошибки площадки приводить к ChannelError/AuthError/RateLimitError/OutOfUnitsError.
 *  • Ответы валидировать через zod: площадки меняют схемы без предупреждения.
 */

export interface ChannelContext {
  clientId: string;
  /** Расшифрованные секреты кабинета. */
  credentials: Record<string, unknown>;
  /** Когда true — ни один запрос на изменение не уходит в сеть. */
  dryRun: boolean;
}

export interface DateRange {
  /** yyyy-MM-dd, МСК, включительно. */
  from: string;
  to: string;
}

export interface RemoteCampaign {
  externalId: string;
  name: string;
  type: string;
  status: string;
  dailyBudget: number | null;
  strategy: Record<string, unknown>;
  raw: unknown;
}

export interface RemoteAdGroup {
  externalId: string;
  campaignExternalId: string;
  name: string;
  status: string;
  /**
   * Ставка группы в рублях — там, где канал держит её на этом уровне (VK: `max_price`).
   *
   * Три значения, а не два: `undefined` — «кабинет про ставку не сказал» (у Директа
   * торг идёт по фразам, и уровня группы нет вовсе; у VK поле может не приехать под
   * проекцией `fields`), `null` — «ручной ставки нет», цену назначает автостратегия.
   * Различать их обязательно: иначе молчание канала обнуляло бы живую ставку в базе.
   */
  bid?: number | null;
  targeting: Record<string, unknown>;
  raw: unknown;
}

export interface RemoteAd {
  externalId: string;
  adGroupExternalId: string;
  title: string;
  title2?: string;
  text: string;
  href?: string;
  imageUrl?: string;
  status: string;
  moderationStatus: string;
  moderationReason?: string;
  raw: unknown;
}

export interface RemoteKeyword {
  externalId: string;
  adGroupExternalId: string;
  phrase: string;
  bid: number | null;
  status: string;
  raw: unknown;
}

export interface StatRow {
  /** yyyy-MM-dd */
  date: string;
  entityExternalId: string;
  impressions: number;
  clicks: number;
  /** Совпадает с колонкой CampaignStat.spend — имена намеренно одинаковые. */
  spend: number;
  conversions: number;
  revenue?: number;
}

export interface SearchQueryRow {
  date: string;
  campaignExternalId: string;
  /**
   * SearchQueryStat ключуется по группе: минус-слово вешается на неё.
   * Без этого поля многогрупповая кампания не даёт ни одного минус-слова.
   */
  adGroupExternalId?: string;
  query: string;
  impressions: number;
  clicks: number;
  /** Совпадает с колонкой CampaignStat.spend — имена намеренно одинаковые. */
  spend: number;
  conversions: number;
}

export type StatLevel = 'campaign' | 'adgroup' | 'ad' | 'keyword';

/** Результат write-операции. При dryRun выполнение пропущено, но план возвращён. */
export interface WriteResult<T = unknown> {
  applied: boolean;
  /** Что бы произошло / что произошло. */
  plan: Record<string, unknown>;
  result?: T;
}

export interface BidChange {
  keywordExternalId: string;
  bid: number;
}

export interface BudgetChange {
  campaignExternalId: string;
  dailyBudget: number;
}

export interface ChannelAdapter {
  readonly channel: Provider;

  /** Проверка доступа: должен упасть AuthError, если токен нерабочий. */
  verifyAccess(ctx: ChannelContext): Promise<{ ok: true; accountName?: string }>;

  // ── чтение ────────────────────────────────────────────────────────────────
  listCampaigns(ctx: ChannelContext): Promise<RemoteCampaign[]>;
  listAdGroups(ctx: ChannelContext, campaignExternalIds: string[]): Promise<RemoteAdGroup[]>;
  listAds(ctx: ChannelContext, adGroupExternalIds: string[]): Promise<RemoteAd[]>;
  listKeywords(ctx: ChannelContext, adGroupExternalIds: string[]): Promise<RemoteKeyword[]>;
  getStats(ctx: ChannelContext, level: StatLevel, range: DateRange): Promise<StatRow[]>;

  /** Не у всех площадок есть отчёт по поисковым запросам — тогда undefined. */
  getSearchQueries?(ctx: ChannelContext, range: DateRange): Promise<SearchQueryRow[]>;

  // ── запись ────────────────────────────────────────────────────────────────
  setBids(ctx: ChannelContext, changes: BidChange[]): Promise<WriteResult>;
  setBudgets(ctx: ChannelContext, changes: BudgetChange[]): Promise<WriteResult>;
  pauseEntities(ctx: ChannelContext, level: StatLevel, externalIds: string[]): Promise<WriteResult>;
  resumeEntities(
    ctx: ChannelContext,
    level: StatLevel,
    externalIds: string[],
  ): Promise<WriteResult>;

  /** Добавить минус-слова на уровне кампании. */
  addNegativeKeywords?(
    ctx: ChannelContext,
    campaignExternalId: string,
    phrases: string[],
  ): Promise<WriteResult>;

  /** Обновить тексты объявления (используется AI-модератором при ретрае). */
  updateAdText?(
    ctx: ChannelContext,
    adExternalId: string,
    text: { title: string; title2?: string; text: string },
  ): Promise<WriteResult>;
}

/** Реестр адаптеров заполняется в src/channels/registry.ts. */
export type ChannelRegistry = Partial<Record<Provider, ChannelAdapter>>;
