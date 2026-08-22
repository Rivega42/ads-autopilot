import { AppError } from '@/lib/errors.js';

/**
 * Кодирование `callback_data` инлайн-кнопок.
 *
 * Telegram режет callback_data до 64 БАЙТ (не символов) и молча отдаёт
 * BUTTON_DATA_INVALID при превышении. Поэтому в кнопку кладём только
 * идентификатор апрува и вердикт — сам payload всегда читается из БД.
 * Так же решается вопрос доверия: содержимое кнопки приходит от клиента
 * Telegram и подделать его ничего не стоит, а вот id без строки PENDING
 * в базе ничего не сделает.
 */

export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** Префикс, чтобы бот мог отличить свои кнопки от чужих в общем роутере. */
export const CALLBACK_PREFIX = 'ap';

export type ApprovalVerdict = 'approve' | 'reject' | 'details';

const VERDICT_TO_CODE: Record<ApprovalVerdict, string> = {
  approve: 'a',
  reject: 'r',
  details: 'i',
};

const CODE_TO_VERDICT: Record<string, ApprovalVerdict> = {
  a: 'approve',
  r: 'reject',
  i: 'details',
};

export interface ParsedCallbackData {
  verdict: ApprovalVerdict;
  approvalId: string;
}

export function encodeCallbackData(verdict: ApprovalVerdict, approvalId: string): string {
  if (approvalId.includes(':')) {
    throw new AppError('Approval id must not contain ":"', {
      code: 'CALLBACK_DATA_INVALID',
      context: { approvalId },
    });
  }
  const data = `${CALLBACK_PREFIX}:${VERDICT_TO_CODE[verdict]}:${approvalId}`;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    // Лучше упасть при отправке карточки, чем получить неработающую кнопку у клиента.
    throw new AppError(`callback_data is ${bytes} bytes, limit is 64`, {
      code: 'CALLBACK_DATA_TOO_LONG',
      context: { bytes, approvalId },
    });
  }
  return data;
}

/** null — кнопка не наша либо данные повреждены; вызывающий обязан это пережить. */
export function decodeCallbackData(data: string): ParsedCallbackData | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [prefix, code, approvalId] = parts;
  if (prefix !== CALLBACK_PREFIX) return null;
  if (code === undefined || approvalId === undefined || approvalId === '') return null;
  const verdict = CODE_TO_VERDICT[code];
  if (!verdict) return null;
  return { verdict, approvalId };
}
