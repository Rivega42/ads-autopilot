import { z } from 'zod';

/**
 * Схемы ответов Директа.
 *
 * Везде `.passthrough()`: Яндекс добавляет поля в существующие объекты без анонса
 * (последний пример — ЕПК и комбинаторные объявления). Падать на неизвестном поле
 * означает уронить ночную синхронизацию из-за косметического релиза площадки.
 * Валидируем только то, на что реально опираемся.
 */

/** Деньги в API — целые «микроединицы»: сумма в валюте × 1 000 000. */
export const MICROS = 1_000_000;

export function toMicros(value: number): number {
  // Округление, а не усечение: 2.01 × 1e6 в double даёт 2009999.999…,
  // а Директ отклоняет суммы, не кратные шагу 0.01.
  return Math.round(value * MICROS);
}

export function fromMicros(value: number): number {
  return value / MICROS;
}

/** Ошибка/предупреждение уровня операции над одним объектом. */
export const exceptionNoticeSchema = z
  .object({
    Code: z.number(),
    Message: z.string().optional(),
    Details: z.string().optional(),
  })
  .passthrough();

export type ExceptionNotice = z.infer<typeof exceptionNoticeSchema>;

/** Результат операции над одним объектом в методах add/update/set/suspend/... */
export const actionResultSchema = z
  .object({
    Id: z.number().optional(),
    KeywordId: z.number().optional(),
    Errors: z.array(exceptionNoticeSchema).optional(),
    Warnings: z.array(exceptionNoticeSchema).optional(),
  })
  .passthrough();

export type ActionResult = z.infer<typeof actionResultSchema>;

/** Обёртка успешного ответа: `{ result: {...} }`. */
export function resultEnvelope<T extends z.ZodTypeAny>(inner: T) {
  return z.object({ result: inner });
}

// ── Сущности ─────────────────────────────────────────────────────────────────

const amountSchema = z
  .object({ Amount: z.number().optional(), Mode: z.string().optional() })
  .passthrough();

export const campaignSchema = z
  .object({
    Id: z.number(),
    Name: z.string(),
    Type: z.string().optional(),
    Status: z.string().optional(),
    State: z.string().optional(),
    StatusClarification: z.string().optional(),
    DailyBudget: amountSchema.nullable().optional(),
    NegativeKeywords: z.object({ Items: z.array(z.string()) }).passthrough().nullable().optional(),
    // Стратегия лежит в подобъекте, имя которого зависит от типа кампании.
    TextCampaign: z.object({}).passthrough().nullable().optional(),
    UnifiedCampaign: z.object({}).passthrough().nullable().optional(),
    DynamicTextCampaign: z.object({}).passthrough().nullable().optional(),
    SmartCampaign: z.object({}).passthrough().nullable().optional(),
    MobileAppCampaign: z.object({}).passthrough().nullable().optional(),
  })
  .passthrough();

export type YandexCampaign = z.infer<typeof campaignSchema>;

export const adGroupSchema = z
  .object({
    Id: z.number(),
    CampaignId: z.number(),
    Name: z.string(),
    Status: z.string().optional(),
    Type: z.string().optional(),
    RegionIds: z.array(z.number()).nullable().optional(),
    NegativeKeywords: z.object({ Items: z.array(z.string()) }).passthrough().nullable().optional(),
  })
  .passthrough();

export type YandexAdGroup = z.infer<typeof adGroupSchema>;

const textAdSchema = z
  .object({
    Title: z.string().optional(),
    Title2: z.string().optional(),
    Text: z.string().optional(),
    Href: z.string().nullable().optional(),
    DisplayDomain: z.string().nullable().optional(),
  })
  .passthrough();

export const adSchema = z
  .object({
    Id: z.number(),
    CampaignId: z.number().optional(),
    AdGroupId: z.number(),
    State: z.string().optional(),
    Status: z.string().optional(),
    StatusClarification: z.string().nullable().optional(),
    // У каждого формата объявления свой подобъект; берём те, что умеем показывать.
    TextAd: textAdSchema.nullable().optional(),
    TextImageAd: z.object({}).passthrough().nullable().optional(),
    DynamicTextAd: textAdSchema.nullable().optional(),
    MobileAppAd: textAdSchema.nullable().optional(),
    SmartAdBuilderAd: z.object({}).passthrough().nullable().optional(),
  })
  .passthrough();

export type YandexAd = z.infer<typeof adSchema>;

export const keywordSchema = z
  .object({
    Id: z.number(),
    AdGroupId: z.number(),
    CampaignId: z.number().optional(),
    Keyword: z.string(),
    State: z.string().optional(),
    Status: z.string().optional(),
    Bid: z.number().nullable().optional(),
    ContextBid: z.number().nullable().optional(),
    StrategyPriority: z.string().nullable().optional(),
  })
  .passthrough();

export type YandexKeyword = z.infer<typeof keywordSchema>;

export const clientSchema = z
  .object({
    ClientId: z.number().optional(),
    Login: z.string().optional(),
    ClientInfo: z.string().nullable().optional(),
    Currency: z.string().optional(),
  })
  .passthrough();

// ── Ответы методов get ───────────────────────────────────────────────────────

/**
 * `LimitedBy` — порядковый номер последнего отданного объекта. Присутствует
 * только когда выборка обрезана, и служит `Offset` для следующей страницы.
 */
const limitedBy = z.number().optional();

export const campaignsGetSchema = resultEnvelope(
  z.object({ Campaigns: z.array(campaignSchema).optional(), LimitedBy: limitedBy }).passthrough(),
);

export const adGroupsGetSchema = resultEnvelope(
  z.object({ AdGroups: z.array(adGroupSchema).optional(), LimitedBy: limitedBy }).passthrough(),
);

export const adsGetSchema = resultEnvelope(
  z.object({ Ads: z.array(adSchema).optional(), LimitedBy: limitedBy }).passthrough(),
);

export const keywordsGetSchema = resultEnvelope(
  z.object({ Keywords: z.array(keywordSchema).optional(), LimitedBy: limitedBy }).passthrough(),
);

export const clientsGetSchema = resultEnvelope(
  z.object({ Clients: z.array(clientSchema).optional() }).passthrough(),
);

// ── Ответы write-методов ─────────────────────────────────────────────────────

export const updateResultsSchema = resultEnvelope(
  z
    .object({
      UpdateResults: z.array(actionResultSchema).optional(),
      SetResults: z.array(actionResultSchema).optional(),
      SuspendResults: z.array(actionResultSchema).optional(),
      ResumeResults: z.array(actionResultSchema).optional(),
      AddResults: z.array(actionResultSchema).optional(),
    })
    .passthrough(),
);

export type UpdateResultsResponse = z.infer<typeof updateResultsSchema>;

/** OAuth-ответ oauth.yandex.ru/token. */
export const oauthTokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string().optional(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
  })
  .passthrough();

export type OauthTokenResponse = z.infer<typeof oauthTokenSchema>;
