import { Provider } from '@prisma/client';
import { z } from 'zod';

import {
  DIRECT_MAX_ADS_PER_GROUP,
  DIRECT_MAX_GROUPS_PER_CAMPAIGN,
  DIRECT_MAX_KEYWORDS_PER_GROUP,
  DIRECT_MIN_DAILY_BUDGET_RUB,
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  textLength,
} from '@/campaigns/limits.js';

/**
 * Схемы плана кампании.
 *
 * Здесь две группы схем, и путать их нельзя:
 *
 *  • `*DraftSchema` — то, что вернула модель. Лимиты в них мягкие: жёсткие заставили бы
 *    `completeStructured` жечь токены на починку каждого длинного заголовка, тогда как
 *    обрезать его можно детерминированно и бесплатно.
 *  • `campaignPlanSchema` — то, что уходит в кабинет. Здесь лимиты Директа абсолютны:
 *    план, не прошедший эту схему, не отправляется никуда.
 */

const trimmed = (min: number, max: number): z.ZodString => z.string().trim().min(min).max(max);

/**
 * Строка длиной не больше `limit` в счёте площадки (см. limits.ts) и не пустая.
 *
 * Нижняя граница здесь не формальность: обрезка под лимит умеет схлопнуть строку
 * почти в ничто, а `Title: ""` Директ отклоняет на 20 баллов и оставляет группу
 * без объявлений. Пусть лучше падает схема плана, чем `Ads.add`.
 */
function withinLimit(limit: number, min = 1): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .trim()
    .min(min)
    .refine((value) => textLength(value) <= limit, {
      message: `длина больше ${limit} символов`,
    });
}

// ── Черновики от модели ──────────────────────────────────────────────────────

/** Запас над лимитом Директа: модель промахивается, но не в разы. */
const DRAFT_TEXT_SLACK = 3;

export const adTextDraftSchema = z.object({
  title: trimmed(3, DIRECT_TITLE_MAX * DRAFT_TEXT_SLACK),
  title2: trimmed(1, DIRECT_TITLE2_MAX * DRAFT_TEXT_SLACK).optional(),
  text: trimmed(10, DIRECT_TEXT_MAX * DRAFT_TEXT_SLACK),
});

export type AdTextDraftValue = z.infer<typeof adTextDraftSchema>;

export const structureDraftSchema = z.object({
  /** Одна строка про нишу — уезжает в промпт текстов, чтобы не звать стратега дважды. */
  summary: trimmed(1, 1_000),
  groups: z
    .array(
      z.object({
        name: trimmed(1, 100),
        /** Зачем эта группа существует: горячий спрос, бренд, конкуренты, регион. */
        intent: trimmed(1, 300),
        keywords: z
          .array(trimmed(1, 200))
          .min(1)
          .max(DIRECT_MAX_KEYWORDS_PER_GROUP * 2),
        // Не `.default([])`: у схемы, отданной в runAgent, вход обязан совпадать
        // с выходом, иначе она не подходит под `RunAgentOptions.schema`.
        negativeKeywords: z.array(trimmed(1, 200)).max(500).optional(),
      }),
    )
    .min(1)
    .max(DIRECT_MAX_GROUPS_PER_CAMPAIGN),
  campaignNegativeKeywords: z.array(trimmed(1, 200)).max(500).optional(),
});

export type StructureDraft = z.infer<typeof structureDraftSchema>;

export const adTextsDraftSchema = z.object({
  groups: z
    .array(
      z.object({
        name: trimmed(1, 100),
        ads: z.array(adTextDraftSchema).min(1).max(DIRECT_MAX_ADS_PER_GROUP),
      }),
    )
    .min(1),
});

export type AdTextsDraft = z.infer<typeof adTextsDraftSchema>;

// ── План, который уходит в кабинет ───────────────────────────────────────────

export const plannedAdSchema = z.object({
  title: withinLimit(DIRECT_TITLE_MAX),
  title2: withinLimit(DIRECT_TITLE2_MAX).optional(),
  text: withinLimit(DIRECT_TEXT_MAX),
  /**
   * Обязательна: Директ принимает объявление только с целью показа — хотя бы одним
   * из Href, TurboPageId, VCardId, BusinessId (Ads.add). Ничего, кроме Href, система
   * не создаёт, поэтому план без ссылки применить нельзя, и узнать об этом лучше
   * на разборе плана, чем после того, как кампания и группы уже созданы.
   */
  href: z.string().trim().url().max(1_024),
});

export type PlannedAd = z.infer<typeof plannedAdSchema>;

export const plannedKeywordSchema = z.object({
  phrase: trimmed(1, 100),
  /** Стартовая ставка в рублях. Считается кодом из целевого CPA, не моделью. */
  bidRub: z.number().positive().finite(),
});

export type PlannedKeyword = z.infer<typeof plannedKeywordSchema>;

export const plannedAdGroupSchema = z.object({
  name: trimmed(1, 100),
  regionIds: z.array(z.number().int()).min(1),
  keywords: z.array(plannedKeywordSchema).min(1).max(DIRECT_MAX_KEYWORDS_PER_GROUP),
  negativeKeywords: z.array(trimmed(1, 200)).max(500),
  ads: z.array(plannedAdSchema).min(1).max(DIRECT_MAX_ADS_PER_GROUP),
});

export type PlannedAdGroup = z.infer<typeof plannedAdGroupSchema>;

export const biddingStrategySideSchema = z.object({
  type: trimmed(1, 64),
  settings: z.record(z.unknown()).optional(),
});

export type BiddingStrategyPlan = {
  search: z.infer<typeof biddingStrategySideSchema>;
  network: z.infer<typeof biddingStrategySideSchema>;
};

/** Поиск и РСЯ — разные кампании: у них разные ставки, тексты живут одни. */
export const campaignPlacementSchema = z.enum(['search', 'network']);

export type CampaignPlacement = z.infer<typeof campaignPlacementSchema>;

export const plannedCampaignSchema = z.object({
  channel: z.nativeEnum(Provider),
  placement: campaignPlacementSchema,
  name: trimmed(1, 255),
  dailyBudgetRub: z.number().min(DIRECT_MIN_DAILY_BUDGET_RUB),
  targetCpaRub: z.number().positive(),
  strategy: z.object({ search: biddingStrategySideSchema, network: biddingStrategySideSchema }),
  negativeKeywords: z.array(trimmed(1, 200)).max(500),
  adGroups: z.array(plannedAdGroupSchema).min(1).max(DIRECT_MAX_GROUPS_PER_CAMPAIGN),
});

export type PlannedCampaign = z.infer<typeof plannedCampaignSchema>;

export const campaignPlanSchema = z
  .object({
    /** id строки-хранилища плана. null — план ещё не сохранён. */
    id: z.string().min(1).nullable().default(null),
    clientId: z.string().min(1),
    createdAt: z.string().min(1),
    totalDailyBudgetRub: z.number().nonnegative(),
    /** Одна строка от стратега: она же попадает в reason карточки апрува. */
    summary: trimmed(1, 1_000),
    campaigns: z.array(plannedCampaignSchema).min(1),
    /** Всё, что человек должен увидеть до запуска: обрезки, нераспознанные города. */
    warnings: z.array(z.string()).default([]),
    /** Имя@версия каждого использованного промпта — по ним воспроизводится результат. */
    prompts: z.array(z.string()).default([]),
  })
  .superRefine((plan, ctx) => {
    const sum = plan.campaigns.reduce((acc, c) => acc + c.dailyBudgetRub, 0);
    // Копейка расхождения означает, что бюджет считали не в splitBudget, а где-то ещё.
    if (Math.abs(sum - plan.totalDailyBudgetRub) > 0.005) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalDailyBudgetRub'],
        message: `сумма бюджетов кампаний ${sum} не равна общему ${plan.totalDailyBudgetRub}`,
      });
    }
  });

export type CampaignPlan = z.infer<typeof campaignPlanSchema>;

/**
 * Ссылка на кампанию плана, которая едет в `ApprovalAction.strategy`.
 *
 * В карточку апрува план целиком класть нельзя: `renderDetails` показывает
 * `strategy` пользователю одним alert'ом, а Telegram режет его на 200 символах.
 * Поэтому в заявке лежит ссылка, а сам план — в своей строке.
 */
export const campaignPlanRefSchema = z.object({
  planId: z.string().min(1),
  campaignIndex: z.number().int().nonnegative(),
  placement: campaignPlacementSchema,
});

export type CampaignPlanRef = z.infer<typeof campaignPlanRefSchema>;

export function readPlanRef(strategy: unknown): CampaignPlanRef | null {
  const parsed = campaignPlanRefSchema.safeParse(strategy);
  return parsed.success ? parsed.data : null;
}
