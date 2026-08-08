import { z } from 'zod';

/**
 * Zod-схемы ответов ads.vk.ru.
 *
 * Почему почти везде `.passthrough()`: VK добавляет поля в ответы без анонса и
 * без версионирования пути. Строгий `.strict()` превратил бы такое добавление в
 * падение синка на проде. Мы валидируем только то, чем реально пользуемся,
 * остальное пропускаем и кладём в `raw`.
 *
 * ВНИМАНИЕ: часть имён полей проверена только по документации, живого токена у
 * нас на момент написания не было. Места, требующие эмпирической проверки,
 * помечены `@needs-live-token`.
 */

/**
 * VK отдаёт деньги строкой ("1234.56"), а счётчики — то числом, то строкой.
 * Единая нормализация: всё, что не парсится в конечное число, считаем нулём —
 * пропуск метрики не должен ронять весь батч статистики.
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Метрика: принимает число/строку/отсутствие, отдаёт число. */
export const vkMetric = z.unknown().transform((v) => toNumber(v, 0));

/** Необязательное денежное поле: null сохраняем, чтобы отличать «не задано» от нуля. */
export const vkMoneyNullable = z
  .unknown()
  .transform((v) => (v === null || v === undefined || v === '' ? null : toNumber(v, 0)));

/** id у VK числовой, но в статистике он иногда приходит строкой. Внутри системы — строка. */
export const vkId = z.union([z.number(), z.string()]).transform((v) => String(v));

// ── OAuth ───────────────────────────────────────────────────────────────────

export const vkTokenSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.string().optional(),
    /** Секунды. По документации всегда 86400, но полагаться на константу нельзя. */
    expires_in: z.coerce.number().int().positive().optional(),
    refresh_token: z.string().optional(),
    account_id: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

export type VkToken = z.infer<typeof vkTokenSchema>;

// ── Сущности ────────────────────────────────────────────────────────────────

/**
 * AdPlan — «кампания» в терминах остальной системы.
 *
 * @needs-live-token: набор полей бюджета (`budget_limit_day` / `budget_limit`)
 * и имя поля стратегии (`autobidding_mode`) взяты из документации myTarget,
 * в ads.vk.ru они могли быть переименованы.
 */
export const vkAdPlanSchema = z
  .object({
    id: z.number().int(),
    name: z.string().default(''),
    status: z.string().default('active'),
    objective: z.string().nullish(),
    budget_limit_day: vkMoneyNullable.optional(),
    budget_limit: vkMoneyNullable.optional(),
    autobidding_mode: z.string().nullish(),
    max_price: vkMoneyNullable.optional(),
    date_start: z.string().nullish(),
    date_end: z.string().nullish(),
  })
  .passthrough();

export type VkAdPlan = z.infer<typeof vkAdPlanSchema>;

export const vkAdGroupSchema = z
  .object({
    id: z.number().int(),
    ad_plan_id: z.number().int(),
    name: z.string().default(''),
    status: z.string().default('active'),
    budget_limit_day: vkMoneyNullable.optional(),
    max_price: vkMoneyNullable.optional(),
    autobidding_mode: z.string().nullish(),
    /** Таргетинги — большой полиморфный объект, разбирать его целиком нет смысла. */
    targetings: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export type VkAdGroup = z.infer<typeof vkAdGroupSchema>;

/**
 * Banner — «объявление».
 *
 * Тексты лежат в `textblocks`, состав ключей зависит от формата
 * (`title_25`, `text_90`, `about_company_90`, ...), поэтому — свободная запись.
 */
export const vkBannerSchema = z
  .object({
    id: z.number().int(),
    ad_group_id: z.number().int(),
    name: z.string().nullish(),
    status: z.string().default('active'),
    moderation_status: z.string().nullish(),
    moderation_reason_type: z.string().nullish(),
    moderation_reason: z.string().nullish(),
    textblocks: z.record(z.unknown()).nullish(),
    urls: z.record(z.unknown()).nullish(),
    content: z.record(z.unknown()).nullish(),
    url: z.string().nullish(),
  })
  .passthrough();

export type VkBanner = z.infer<typeof vkBannerSchema>;

/** Конверт списочных ответов VK: `{count, offset, items}`. */
export function vkListSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      count: z.coerce.number().int().nonnegative().optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
      items: z.array(item).default([]),
    })
    .passthrough();
}

/** Ответ загрузки медиа в `content/*`. */
export const vkContentSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    width: z.coerce.number().int().optional(),
    height: z.coerce.number().int().optional(),
  })
  .passthrough();

// ── Статистика ──────────────────────────────────────────────────────────────

/**
 * Блок метрик. VK кладёт их в `base`, но в части ответов (и в `summary`)
 * встречается плоская форма — маппер умеет читать оба варианта.
 */
export const vkStatBaseSchema = z
  .object({
    shows: vkMetric,
    clicks: vkMetric,
    goals: vkMetric,
    spent: vkMetric,
  })
  .passthrough();

export const vkStatRowSchema = z
  .object({
    date: z.string().optional(),
    base: vkStatBaseSchema.optional(),
  })
  .passthrough();

export const vkStatItemSchema = z
  .object({
    id: vkId,
    rows: z.array(vkStatRowSchema).default([]),
    total: vkStatRowSchema.optional(),
  })
  .passthrough();

export const vkStatsResponseSchema = z
  .object({
    items: z.array(vkStatItemSchema).default([]),
    total: z.unknown().optional(),
  })
  .passthrough();

export type VkStatsResponse = z.infer<typeof vkStatsResponseSchema>;
export type VkStatRow = z.infer<typeof vkStatRowSchema>;

// ── Ошибки ──────────────────────────────────────────────────────────────────

export interface VkErrorInfo {
  code?: string;
  message?: string;
}

/**
 * У VK нет единого формата ошибки: встречаются как минимум
 *   {"error": {"code": "...", "message": "..."}}
 *   {"error": "invalid_client", "error_description": "..."}
 *   {"field_name": [{"code": "...", "message": "..."}]}
 * Поэтому разбираем руками, а не схемой: задача — вытащить хоть что-то читаемое
 * в лог, а не отвергнуть тело ответа.
 */
export function parseVkError(data: unknown): VkErrorInfo {
  if (typeof data === 'string') return { message: data.slice(0, 500) };
  if (!data || typeof data !== 'object') return {};

  const obj = data as Record<string, unknown>;
  const err = obj['error'];

  if (typeof err === 'string') {
    const desc = obj['error_description'];
    return { code: err, message: typeof desc === 'string' ? desc : err };
  }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return {
      code: typeof e['code'] === 'string' ? e['code'] : undefined,
      message: typeof e['message'] === 'string' ? e['message'] : undefined,
    };
  }

  // Полевые ошибки валидации: берём первую, остальные всё равно про тот же payload.
  for (const [field, value] of Object.entries(obj)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const first = value[0];
    if (first && typeof first === 'object') {
      const f = first as Record<string, unknown>;
      const message = typeof f['message'] === 'string' ? f['message'] : JSON.stringify(first);
      return {
        code: typeof f['code'] === 'string' ? f['code'] : undefined,
        message: `${field}: ${message}`,
      };
    }
    if (typeof first === 'string') return { message: `${field}: ${first}` };
  }
  return {};
}
