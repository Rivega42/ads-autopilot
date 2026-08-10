import { z } from 'zod';

import { REJECTION_CATEGORIES } from '@/moderation/types.js';

/**
 * Схемы ответов AI-Модератора.
 *
 * Категория — закрытый перечень: если модель придумает пятнадцатую, `runAgent`
 * отправит её чинить ответ, а не вернёт нам строку, под которую в базе правил
 * заведомо ничего нет.
 */

export const rejectionClassificationSchema = z.object({
  category: z.enum(REJECTION_CATEGORIES),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1).max(600),
  fragments: z.array(z.string().min(1)).max(10).default([]),
});

export type RejectionClassificationDraft = z.infer<typeof rejectionClassificationSchema>;

export const adRewriteSchema = z.object({
  title: z.string().min(1),
  /** Второй заголовок необязателен: пустую строку Директ отклоняет, поэтому её же и режем. */
  title2: z.string().optional(),
  text: z.string().min(1),
  /** Что изменено и почему это снимает претензию. Уезжает в ChangeLog и в письмо человеку. */
  changes: z.string().min(1).max(600),
});

export type AdRewriteDraft = z.infer<typeof adRewriteSchema>;
