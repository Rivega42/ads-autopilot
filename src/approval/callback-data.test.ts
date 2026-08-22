import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  decodeCallbackData,
  encodeCallbackData,
  type ApprovalVerdict,
} from '@/approval/callback-data.js';
import { buildApprovalKeyboard } from '@/approval/card.js';
import { AppError } from '@/lib/errors.js';

const VERDICTS: ApprovalVerdict[] = ['approve', 'reject', 'details'];

// cuid из Prisma — 25 символов; берём такой же, чтобы мерить реальный размер.
const CUID = 'clx7q2z8h0000v8k3f1a2b3c4';

describe('callback_data', () => {
  it('round-trip по всем вердиктам', () => {
    for (const verdict of VERDICTS) {
      const data = encodeCallbackData(verdict, CUID);
      expect(decodeCallbackData(data)).toEqual({ verdict, approvalId: CUID });
    }
  });

  it('укладывается в лимит Telegram в 64 байта', () => {
    for (const verdict of VERDICTS) {
      const data = encodeCallbackData(verdict, CUID);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('все кнопки карточки помещаются в лимит', () => {
    const kb = buildApprovalKeyboard(CUID);
    const buttons = kb.inline_keyboard.flat();
    expect(buttons).toHaveLength(3);
    for (const btn of buttons) {
      const data = 'callback_data' in btn ? btn.callback_data : '';
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('падает, если payload попытались засунуть в кнопку', () => {
    // Именно так выглядит соблазн «положу-ка я сюда описание изменения».
    expect(() => encodeCallbackData('approve', 'x'.repeat(80))).toThrow(AppError);
    expect(() => encodeCallbackData('approve', 'x'.repeat(80))).toThrow(/64/);
  });

  it('не даёт разделителю уехать в id', () => {
    expect(() => encodeCallbackData('approve', 'a:b')).toThrow(AppError);
  });

  it('игнорирует чужие и битые данные', () => {
    expect(decodeCallbackData('other:a:id')).toBeNull();
    expect(decodeCallbackData('ap:zz:id')).toBeNull();
    expect(decodeCallbackData('ap:a:')).toBeNull();
    expect(decodeCallbackData('ap:a')).toBeNull();
    expect(decodeCallbackData('')).toBeNull();
  });
});
