import { z } from 'zod';

import { PLATFORM_TEXT_LIMITS } from './platform-limits.js';

/**
 * Схема ответа копирайтера креативов.
 *
 * Лимиты здесь мягкие — с запасом над платформенными. Это то же разделение, что и в
 * `campaigns/plan.schema.ts`: жёсткая схема заставила бы `completeStructured` жечь
 * токены на починку каждого длинного заголовка, тогда как обрезать его можно
 * детерминированно и бесплатно. Жёсткая проверка — в `platform-limits.ts`, и через
 * неё проходит всё, что уезжает на площадку.
 */

/** Во сколько раз черновику разрешено превысить лимит площадки, прежде чем это брак. */
const DRAFT_SLACK = 3;

const LONGEST_TITLE = Math.max(
  ...Object.values(PLATFORM_TEXT_LIMITS).map((limits) => limits.title),
);
const LONGEST_TEXT = Math.max(...Object.values(PLATFORM_TEXT_LIMITS).map((limits) => limits.text));

export const creativeTextVariantSchema = z.object({
  /** Посыл: цена / скорость / результат / формат. Различает варианты по смыслу. */
  angle: z.string().trim().min(1).max(80),
  title: z
    .string()
    .trim()
    .min(3)
    .max(LONGEST_TITLE * DRAFT_SLACK),
  title2: z
    .string()
    .trim()
    .min(1)
    .max(LONGEST_TITLE * DRAFT_SLACK)
    .optional(),
  text: z
    .string()
    .trim()
    .min(10)
    .max(LONGEST_TEXT * DRAFT_SLACK),
});

export type CreativeTextVariantDraft = z.infer<typeof creativeTextVariantSchema>;

export const creativeTextsDraftSchema = z.object({
  variants: z.array(creativeTextVariantSchema).min(1).max(20),
});

export type CreativeTextsDraft = z.infer<typeof creativeTextsDraftSchema>;
