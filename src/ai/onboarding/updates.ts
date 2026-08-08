import { isMoneyField, type BriefField, type ClientBriefDraft } from './brief.schema.js';
import type { InterviewTurn } from './turn.schema.js';

/**
 * Приём обновлений брифа от модели.
 *
 * Здесь живёт защита от выдуманных цифр. Для денежных полей модель обязана приложить
 * цитату из ответа клиента; если такой фразы в сообщениях клиента нет — значение
 * отбрасывается, и интервью спросит ещё раз. Пустое поле стоит одного лишнего вопроса,
 * выдуманный CPA — реальных денег на ставках.
 */

export interface RejectedUpdate {
  field: BriefField;
  reason: 'no-evidence' | 'evidence-not-found';
  /** Что именно модель пыталась записать — нужно в логе, чтобы разбирать промпт. */
  value: unknown;
  quote?: string;
}

export interface AppliedUpdates {
  draft: ClientBriefDraft;
  rejected: RejectedUpdate[];
  accepted: BriefField[];
}

/** Сравниваем по буквам и цифрам: пунктуация и регистр в цитате модели не совпадут. */
export function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function quoteFound(quote: string, messages: readonly string[]): boolean {
  const needle = normalizeQuote(quote);
  // Однобуквенная «цитата» найдётся в любом тексте — это не подтверждение.
  if (needle.length < 2) return false;
  return messages.some((message) => normalizeQuote(message).includes(needle));
}

export function applyTurnUpdates(
  draft: ClientBriefDraft,
  turn: InterviewTurn,
  clientMessages: readonly string[],
): AppliedUpdates {
  const next: ClientBriefDraft = { ...draft };
  const rejected: RejectedUpdate[] = [];
  const accepted: BriefField[] = [];

  for (const [field, value] of Object.entries(turn.updates) as [BriefField, unknown][]) {
    if (value === undefined) continue;

    if (isMoneyField(field)) {
      const quote = turn.evidence[field];
      if (quote === undefined || quote.trim() === '') {
        rejected.push({ field, reason: 'no-evidence', value });
        continue;
      }
      if (!quoteFound(quote, clientMessages)) {
        rejected.push({ field, reason: 'evidence-not-found', value, quote });
        continue;
      }
    }

    Object.assign(next, { [field]: value });
    accepted.push(field);
  }

  return { draft: next, rejected, accepted };
}
