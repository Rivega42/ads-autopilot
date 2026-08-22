import type {
  BriefField,
  ClientBriefData,
  ClientBriefDraft,
} from '@/ai/onboarding/brief.schema.js';

/**
 * Формат eval-набора (CLAUDE.md §8).
 *
 * Один кейс — это персона клиента (что он вообще знает о своём бизнесе), ожидания
 * от результата и записанные ходы модели. Записанные ходы позволяют гонять кейс
 * офлайн в обычном `pnpm test`: без сети, без ключей и без счёта за токены.
 */

export interface ScriptedTurn {
  reply: string;
  asking?: BriefField | null;
  updates?: ClientBriefDraft;
  evidence?: Record<string, string>;
  done?: boolean;
}

export interface EvalExpectation {
  /**
   * `question` — интервью правомерно осталось открытым: клиент не дал того, чего
   * нельзя выдумывать, и агент обязан продолжать спрашивать, а не заполнять поле.
   */
  outcome: 'complete' | 'needs_human' | 'question';
  /** Значения, которые обязаны оказаться в итоговом брифе ровно такими. */
  brief?: Partial<ClientBriefData>;
  /**
   * Поля, которых в брифе быть НЕ должно. Главная проверка кейсов, где клиент
   * отказывается называть цифру: агент обязан остаться с пустым полем.
   */
  absent?: BriefField[];
  maxTurns?: number;
}

/**
 * Как получены записанные ходы. `handwritten` — их сочинил или правил человек:
 * прогонять такой кейс офлайн можно, но о качестве промпта он не говорит ничего,
 * и набор обязан сказать об этом вслух (`provenance.ts`).
 */
export type EvalRecordingSource = 'live' | 'handwritten';

export interface EvalCase {
  id: string;
  description: string;
  /** Версия промпта, под которой записаны `recorded`. Несовпадение = фикстуры устарели. */
  promptVersion: string;
  /**
   * Отпечаток ТЕКСТА промпта на момент записи. Версию можно поправить рукой и
   * получить зелёный набор на устаревших записях — отпечаток так не подделать.
   */
  promptFingerprint: string;
  source: EvalRecordingSource;
  /** Факты о клиенте: в live-режиме по ним отвечает модель-персона. */
  persona: Record<string, unknown>;
  /** Манера речи персоны — вторая переменная промпта персоны. */
  style: string;
  /** Ответы клиента для офлайн-прогона, по порядку. */
  answers: string[];
  /** Ходы интервьюера, записанные с живой модели. */
  recorded: ScriptedTurn[];
  expect: EvalExpectation;
}

export interface EvalRunResult {
  caseId: string;
  outcome: 'complete' | 'needs_human' | 'question' | 'error';
  turns: number;
  /** Итоговый бриф или черновик, если интервью не дошло до конца. */
  brief: ClientBriefDraft;
  /** Что наговорила модель в этом прогоне — материал для перезаписи фикстур. */
  recorded: ScriptedTurn[];
  answers: string[];
  error?: string;
}
