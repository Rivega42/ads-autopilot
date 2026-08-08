import { z } from 'zod';

import { briefDraftSchema, briefFieldSchema } from './brief.schema.js';

/**
 * Один ход интервьюера. Модель обязана вернуть ровно эту структуру — валидацию
 * и починку берёт на себя `completeStructured` внутри `runAgent`.
 */
export const interviewTurnSchema = z.object({
  /** Текст, который увидит клиент в Telegram: следующий вопрос или финальное подтверждение. */
  reply: z.string().trim().min(1).max(1_500),

  /** Поле, о котором спрашивает этот ход. Нужно для evals и разбора «почему застряли». */
  asking: briefFieldSchema.nullish(),

  /** Только то, что стало известно из ПОСЛЕДНЕГО ответа клиента. */
  updates: briefDraftSchema.default({}),

  /**
   * Цитаты из ответов клиента для денежных полей: `{ "targetCpaRub": "2000 рублей" }`.
   * Интервью не принимает сумму, цитату для которой не нашло в сообщениях клиента, —
   * это единственная механическая защита от выдуманного CPA.
   */
  evidence: z.record(z.string(), z.string()).default({}),

  /** Модель считает интервью законченным. Решает всё равно схема брифа, не модель. */
  done: z.boolean().default(false),
});

export type InterviewTurn = z.infer<typeof interviewTurnSchema>;

/** Ответ «клиента» в live-режиме evals: там вторую сторону диалога тоже играет модель. */
export const personaReplySchema = z.object({
  reply: z.string().trim().min(1).max(1_000),
});

export type PersonaReply = z.infer<typeof personaReplySchema>;
