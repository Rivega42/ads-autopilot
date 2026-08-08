import { scoped } from '@/lib/logger.js';
import type { YandexHttpClient } from '@/clients/yandex/http.js';
import { chunk, MAX_KEYWORD_IDS, MAX_PAGE_LIMIT } from '@/clients/yandex/entities.js';
import {
  actionResultSchema,
  toMicros,
  updateResultsSchema,
  type ActionResult,
} from '@/clients/yandex/schemas.js';
import { classifyErrorCode } from '@/clients/yandex/errors.js';

const log = scoped('yandex.writes');

/** Лимит одного запроса KeywordBids.set по ключевым фразам. */
export const MAX_BIDS_PER_REQUEST = 10_000;
/** Лимит одного запроса Campaigns.update. */
export const MAX_CAMPAIGNS_PER_REQUEST = 10;
/** Лимит одного запроса Ads.update. */
export const MAX_ADS_PER_REQUEST = 1_000;

export interface FailedOperation {
  /** Позиция объекта во входном массиве — по ней зовущий поймёт, что не проехало. */
  index: number;
  code: number;
  message?: string;
  details?: string;
}

/**
 * Итог массовой операции.
 *
 * Директ выполняет операции над объектами независимо: часть проходит, часть
 * отваливается с ошибкой уровня операции. Валить весь батч из-за одной кривой
 * фразы нельзя — иначе одна опечатка блокирует всю ночную правку ставок.
 * Поэтому ошибки операций собираем и отдаём наверх, а не бросаем.
 */
export interface ActionSummary {
  succeeded: number[];
  failed: FailedOperation[];
  warnings: FailedOperation[];
}

function emptySummary(): ActionSummary {
  return { succeeded: [], failed: [], warnings: [] };
}

function mergeSummaries(base: ActionSummary, next: ActionSummary, offset: number): void {
  base.succeeded.push(...next.succeeded);
  base.failed.push(...next.failed.map((f) => ({ ...f, index: f.index + offset })));
  base.warnings.push(...next.warnings.map((w) => ({ ...w, index: w.index + offset })));
}

function toFailure(index: number, notice: { Code: number; Message?: string; Details?: string }): FailedOperation {
  const out: FailedOperation = { index, code: notice.Code };
  if (notice.Message !== undefined) out.message = notice.Message;
  if (notice.Details !== undefined) out.details = notice.Details;
  return out;
}

/** Раскладывает `*Results` на успехи, ошибки и предупреждения. */
export function summariseResults(results: ActionResult[] | undefined, label: string): ActionSummary {
  const summary = emptySummary();
  if (!results) return summary;

  results.forEach((res, index) => {
    for (const warn of res.Warnings ?? []) summary.warnings.push(toFailure(index, warn));

    const errors = res.Errors ?? [];
    if (errors.length > 0) {
      for (const err of errors) {
        const failure = toFailure(index, err);
        summary.failed.push(failure);
        // Ошибка операции = 20 баллов. Логируем каждую: молчаливый пропуск
        // означает, что оптимизатор считает ставку изменённой, а она прежняя.
        log.warn(
          { label, index, code: err.Code, message: err.Message, behaviour: classifyErrorCode(err.Code) },
          'yandex operation error, object skipped',
        );
      }
      continue;
    }

    const id = res.Id ?? res.KeywordId;
    if (typeof id === 'number') summary.succeeded.push(id);
  });

  return summary;
}

async function runBatched<T>(
  items: readonly T[],
  size: number,
  label: string,
  call: (batch: T[]) => Promise<ActionSummary>,
): Promise<ActionSummary> {
  const total = emptySummary();
  let offset = 0;
  for (const batch of chunk(items, size)) {
    mergeSummaries(total, await call(batch), offset);
    offset += batch.length;
  }
  log.info(
    { label, requested: items.length, ok: total.succeeded.length, failed: total.failed.length },
    'yandex write finished',
  );
  return total;
}

function pickResults(
  result: Record<string, unknown>,
): ActionResult[] | undefined {
  for (const key of ['UpdateResults', 'SetResults', 'SuspendResults', 'ResumeResults', 'AddResults']) {
    const value = result[key];
    if (Array.isArray(value)) {
      return value.map((v) => actionResultSchema.parse(v));
    }
  }
  return undefined;
}

// ── KeywordBids.set ──────────────────────────────────────────────────────────

export interface KeywordBidUpdate {
  keywordId: number;
  /** Ставка на поиске, в валюте кабинета (не в микроединицах). */
  searchBid?: number;
  /** Ставка в сетях (РСЯ), в валюте кабинета. */
  networkBid?: number;
  /** Для автостратегий вместо ставки задаётся приоритет фразы. */
  strategyPriority?: 'LOW' | 'NORMAL' | 'HIGH';
}

export async function setKeywordBids(
  http: YandexHttpClient,
  updates: readonly KeywordBidUpdate[],
): Promise<ActionSummary> {
  return runBatched(updates, MAX_BIDS_PER_REQUEST, 'keywordbids.set', async (batch) => {
    const KeywordBids = batch.map((b) => {
      const item: Record<string, unknown> = { KeywordId: b.keywordId };
      if (b.searchBid !== undefined) item.SearchBid = toMicros(b.searchBid);
      if (b.networkBid !== undefined) item.NetworkBid = toMicros(b.networkBid);
      if (b.strategyPriority !== undefined) item.StrategyPriority = b.strategyPriority;
      return item;
    });
    const res = await http.call('keywordbids', 'set', { KeywordBids }, updateResultsSchema);
    return summariseResults(pickResults(res.result), 'keywordbids.set');
  });
}

// ── Campaigns.update ─────────────────────────────────────────────────────────

export interface BiddingStrategySide {
  /** HIGHEST_POSITION | WB_MAXIMUM_CLICKS | AVERAGE_CPA | SERVING_OFF | ... */
  type: string;
  /** Параметры стратегии, как их ждёт API (WbMaximumClicks, AverageCpa, ...). */
  settings?: Record<string, unknown>;
}

export interface CampaignUpdate {
  campaignId: number;
  name?: string;
  /** Дневной бюджет в валюте кабинета. */
  dailyBudget?: number;
  dailyBudgetMode?: 'STANDARD' | 'DISTRIBUTED';
  /**
   * Стратегия заменяется целиком, поэтому нужны обе стороны сразу.
   * Передать только Search и получить обнулённые сети — классическая авария.
   */
  strategy?: { search: BiddingStrategySide; network: BiddingStrategySide };
  /** Полная замена списка минус-фраз кампании. */
  negativeKeywords?: string[];
  /** Тип подобъекта настроек: TextCampaign по умолчанию, UnifiedCampaign для ЕПК. */
  campaignKind?: 'TextCampaign' | 'UnifiedCampaign' | 'DynamicTextCampaign';
}

function buildStrategySide(side: BiddingStrategySide): Record<string, unknown> {
  const out: Record<string, unknown> = { BiddingStrategyType: side.type };
  if (side.settings) Object.assign(out, side.settings);
  return out;
}

export function buildCampaignPayload(update: CampaignUpdate): Record<string, unknown> {
  const campaign: Record<string, unknown> = { Id: update.campaignId };
  if (update.name !== undefined) campaign.Name = update.name;
  if (update.dailyBudget !== undefined) {
    campaign.DailyBudget = {
      Amount: toMicros(update.dailyBudget),
      Mode: update.dailyBudgetMode ?? 'STANDARD',
    };
  }
  if (update.negativeKeywords !== undefined) {
    campaign.NegativeKeywords = { Items: update.negativeKeywords };
  }
  if (update.strategy) {
    const kind = update.campaignKind ?? 'TextCampaign';
    campaign[kind] = {
      BiddingStrategy: {
        Search: buildStrategySide(update.strategy.search),
        Network: buildStrategySide(update.strategy.network),
      },
    };
  }
  return campaign;
}

export async function updateCampaigns(
  http: YandexHttpClient,
  updates: readonly CampaignUpdate[],
): Promise<ActionSummary> {
  return runBatched(updates, MAX_CAMPAIGNS_PER_REQUEST, 'campaigns.update', async (batch) => {
    const res = await http.call(
      'campaigns',
      'update',
      { Campaigns: batch.map(buildCampaignPayload) },
      updateResultsSchema,
    );
    return summariseResults(pickResults(res.result), 'campaigns.update');
  });
}

// ── suspend / resume ─────────────────────────────────────────────────────────

/** Сервисы, у которых есть парные suspend/resume. У AdGroups их в v5 нет. */
export type SuspendableService = 'campaigns' | 'ads' | 'keywords';

async function toggle(
  http: YandexHttpClient,
  service: SuspendableService,
  method: 'suspend' | 'resume',
  ids: readonly number[],
): Promise<ActionSummary> {
  const size = service === 'campaigns' ? MAX_CAMPAIGNS_PER_REQUEST : MAX_PAGE_LIMIT;
  return runBatched(ids, size, `${service}.${method}`, async (batch) => {
    const res = await http.call(
      service,
      method,
      { SelectionCriteria: { Ids: batch } },
      updateResultsSchema,
    );
    return summariseResults(pickResults(res.result), `${service}.${method}`);
  });
}

export function suspend(
  http: YandexHttpClient,
  service: SuspendableService,
  ids: readonly number[],
): Promise<ActionSummary> {
  return toggle(http, service, 'suspend', ids);
}

export function resume(
  http: YandexHttpClient,
  service: SuspendableService,
  ids: readonly number[],
): Promise<ActionSummary> {
  return toggle(http, service, 'resume', ids);
}

// ── Ads.update ───────────────────────────────────────────────────────────────

export interface AdTextUpdate {
  adId: number;
  title?: string;
  title2?: string;
  text?: string;
  href?: string;
  /** Формат объявления: у каждого свой подобъект. */
  adKind?: 'TextAd' | 'DynamicTextAd' | 'MobileAppAd';
}

/**
 * Переписывание текстов. Используется AI-модератором: после REJECTED объявление
 * правится и уходит на повторную модерацию автоматически — отдельный вызов
 * Ads.moderate нужен только объявлениям, оставшимся в статусе DRAFT.
 */
export async function updateAds(
  http: YandexHttpClient,
  updates: readonly AdTextUpdate[],
): Promise<ActionSummary> {
  return runBatched(updates, MAX_ADS_PER_REQUEST, 'ads.update', async (batch) => {
    const Ads = batch.map((u) => {
      const body: Record<string, unknown> = {};
      if (u.title !== undefined) body.Title = u.title;
      if (u.title2 !== undefined) body.Title2 = u.title2;
      if (u.text !== undefined) body.Text = u.text;
      if (u.href !== undefined) body.Href = u.href;
      return { Id: u.adId, [u.adKind ?? 'TextAd']: body };
    });
    const res = await http.call('ads', 'update', { Ads }, updateResultsSchema);
    return summariseResults(pickResults(res.result), 'ads.update');
  });
}

// ── Минус-фразы кампании ─────────────────────────────────────────────────────

/** Полная замена списка минус-фраз. Пустой массив очищает список. */
export function setCampaignNegativeKeywords(
  http: YandexHttpClient,
  campaignId: number,
  phrases: readonly string[],
): Promise<ActionSummary> {
  return updateCampaigns(http, [{ campaignId, negativeKeywords: [...phrases] }]);
}

/**
 * Добавление минус-фраз к существующим.
 *
 * API умеет только полную замену NegativeKeywords, поэтому это read-modify-write:
 * сначала читаем текущий список (Campaigns.get, 10 баллов), потом объединяем.
 * Без чтения любой вызов «добавить одну минус-фразу» стирал бы все накопленные.
 */
export async function addCampaignNegativeKeywords(
  http: YandexHttpClient,
  campaignId: number,
  phrases: readonly string[],
  current: readonly string[],
): Promise<{ summary: ActionSummary; added: string[]; total: string[] }> {
  const existing = new Set(current);
  const added = [...new Set(phrases)].filter((p) => !existing.has(p));
  if (added.length === 0) {
    return { summary: emptySummary(), added: [], total: [...current] };
  }
  const total = [...current, ...added];
  const summary = await setCampaignNegativeKeywords(http, campaignId, total);
  return { summary, added, total };
}

export { MAX_KEYWORD_IDS };
