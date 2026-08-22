import { Provider } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { setMessenger } from '@/approval/index.js';
import { env } from '@/env.js';
import { fakeMessenger } from '@/moderation/__tests__/fakes.js';
import { renderEscalation, sendEscalation } from '@/moderation/escalate.js';
import type { ModerationEscalation } from '@/moderation/escalate.js';
import { rulesFor } from '@/moderation/rules.js';

function escalation(over: Partial<ModerationEscalation> = {}): ModerationEscalation {
  return {
    clientId: 'cl1',
    clientName: 'Ромашка',
    chatId: '555',
    channel: Provider.YANDEX_DIRECT,
    campaignName: 'Поиск — ремонт',
    adId: 'ad1',
    adExternalId: '9',
    retries: 3,
    reason: 'Превосходная степень без подтверждения',
    classification: {
      category: 'superlative',
      confidence: 0.9,
      explanation: 'В заголовке «лучший» без подтверждения.',
      fragments: ['Лучший'],
      rules: rulesFor('superlative', Provider.YANDEX_DIRECT),
      promptVersion: 'moderation-classify@1.0.0',
    },
    ad: { title: 'Лучший ремонт', text: 'Починим сегодня.' },
    problems: ['площадка отклонила все три варианта'],
    cause: 'retries_exhausted',
    ...over,
  };
}

afterEach(() => {
  setMessenger(null);
});

describe('renderEscalation', () => {
  it('содержит всё, по чему человек примет решение', () => {
    const text = renderEscalation(escalation());

    expect(text).toContain('Ромашка');
    expect(text).toContain('Поиск — ремонт');
    expect(text).toContain('Превосходная степень без подтверждения');
    expect(text).toContain('superlative-unproven');
    expect(text).toContain('ФЗ «О рекламе» № 38-ФЗ');
    expect(text).toContain('Лучший ремонт');
    expect(text).toContain('площадка отклонила все три варианта');
  });

  it('не падает без классификации: до модели дело могло не дойти', () => {
    const text = renderEscalation(
      escalation({ classification: null, cause: 'channel_unsupported', reason: '' }),
    );

    expect(text).toContain('площадка причину не прислала');
    expect(text).toContain('канал не умеет обновлять текст');
  });

  it('режет длинный разбор под лимит Telegram', () => {
    const text = renderEscalation(escalation({ reason: 'ю'.repeat(9_000) }));
    expect(text.length).toBeLessThanOrEqual(3_900);
  });
});

describe('sendEscalation', () => {
  it('уходит в личный чат клиента через транспорт апрувов', async () => {
    const messenger = fakeMessenger();
    setMessenger(messenger);

    await sendEscalation(escalation());

    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]?.chatId).toBe('555');
    expect(messenger.sent[0]?.text).toContain('Модерация: нужен человек');
  });

  it.skipIf(Boolean(env.TELEGRAM_ADMIN_CHAT_ID))(
    'падает, если письму некуда идти: молча терять эскалацию нельзя',
    async () => {
      setMessenger(fakeMessenger());
      await expect(sendEscalation(escalation({ chatId: '' }))).rejects.toMatchObject({
        code: 'ESCALATION_NO_CHAT',
      });
    },
  );
});
