import { z } from 'zod';

import { briefDraftSchema, type ClientBriefDraft } from './brief.schema.js';

import type { LlmMessage } from '@/clients/llm/index.js';

/**
 * Состояние интервью, которое живёт в БД, а не в памяти процесса.
 *
 * Разделение простое: `ClientBrief.data` — только бриф (его читают стратег и креативы,
 * им не нужен диалог), `ClientBrief.transcript` — весь ход интервью. Поэтому воркер
 * можно перезапустить между двумя сообщениями клиента, и он продолжит с того же места.
 */

/** Версия формата transcript. Меняется, если структура поедет: старые строки надо уметь читать. */
export const TRANSCRIPT_VERSION = 1;

export const transcriptTurnSchema = z.object({
  role: z.enum(['assistant', 'user']),
  text: z.string(),
  at: z.string(),
  /** Ссылка на строку AiRun: по ней восстанавливается модель, токены и цена хода. */
  aiRunId: z.string().nullish(),
  /** Версия промпта, которым получен ход ассистента. */
  promptVersion: z.string().nullish(),
  /** Поле брифа, о котором был вопрос. */
  asking: z.string().nullish(),
});

export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

export const transcriptSchema = z.object({
  version: z.literal(TRANSCRIPT_VERSION),
  askedCount: z.number().int().min(0),
  turns: z.array(transcriptTurnSchema),
});

export type InterviewTranscript = z.infer<typeof transcriptSchema>;

export function emptyTranscript(): InterviewTranscript {
  return { version: TRANSCRIPT_VERSION, askedCount: 0, turns: [] };
}

/**
 * Читает transcript из Json-колонки. Непонятная структура (старый формат, ручная
 * правка в БД) не роняет интервью: диалог начнётся заново, но бриф в `data` уцелеет —
 * потерять историю вопросов дешевле, чем потерять ответы.
 */
export function parseTranscript(value: unknown): InterviewTranscript {
  const parsed = transcriptSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyTranscript();
}

/** Читает черновик брифа из Json-колонки, отбрасывая всё, что не проходит схему. */
export function parseDraft(value: unknown): ClientBriefDraft {
  const parsed = briefDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * Первое сообщение диалога. Anthropic требует, чтобы история начиналась с роли `user`,
 * а интервью начинает ассистент — этот ход и есть недостающий первый `user`.
 */
export const KICKOFF_MESSAGE = 'Начинай интервью.';

/**
 * История для модели. Хвост, а не весь диалог: собранное знание уже лежит в системном
 * промпте черновиком брифа, поэтому старые ходы нужны только для связности речи.
 */
export function toLlmMessages(transcript: InterviewTranscript, maxTurns = 40): LlmMessage[] {
  const tail = transcript.turns.slice(-maxTurns);
  return [
    { role: 'user', content: KICKOFF_MESSAGE },
    ...tail.map((turn): LlmMessage => ({ role: turn.role, content: turn.text })),
  ];
}

export function lastAssistantTurn(transcript: InterviewTranscript): TranscriptTurn | undefined {
  for (let i = transcript.turns.length - 1; i >= 0; i -= 1) {
    const turn = transcript.turns[i];
    if (turn?.role === 'assistant') return turn;
  }
  return undefined;
}

/** Все реплики клиента: по ним проверяются цитаты для денежных полей. */
export function userMessages(transcript: InterviewTranscript): string[] {
  return transcript.turns.filter((t) => t.role === 'user').map((t) => t.text);
}
