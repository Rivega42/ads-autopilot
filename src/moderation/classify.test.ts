import { Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { queueRunner } from '@/moderation/__tests__/fakes.js';
import { classifyRejection } from '@/moderation/classify.js';
import type { RejectionClassificationDraft } from '@/moderation/schema.js';

const AD = {
  title: 'Лучший ремонт стиральных машин',
  title2: 'Выезд сегодня',
  text: 'Починим быстро и качественно, гарантия на работу мастера.',
};

function draft(over: Partial<RejectionClassificationDraft> = {}): RejectionClassificationDraft {
  return {
    category: 'superlative',
    confidence: 0.9,
    explanation: 'В заголовке превосходная степень без подтверждения.',
    fragments: ['Лучший ремонт'],
    ...over,
  };
}

describe('classifyRejection', () => {
  it('уходит в дешёвую задачу и возвращает правила под категорию', async () => {
    const runner = queueRunner<RejectionClassificationDraft>([draft()]);

    const result = await classifyRejection(
      {
        clientId: 'cl1',
        channel: Provider.YANDEX_DIRECT,
        reason: 'Превосходная степень без подтверждения',
        ad: AD,
      },
      { run: runner.run },
    );

    expect(runner.calls[0]?.task).toBe('moderation.classify');
    expect(runner.calls[0]?.clientId).toBe('cl1');
    expect(result.category).toBe('superlative');
    expect(result.rules.map((rule) => rule.id)).toContain('superlative-unproven');
    expect(result.promptVersion).toMatch(/^moderation-classify@/u);
  });

  it('кладёт в промпт дословную причину, тексты и подсказки', async () => {
    const runner = queueRunner<RejectionClassificationDraft>([draft()]);

    await classifyRejection(
      {
        clientId: 'cl1',
        channel: Provider.YANDEX_DIRECT,
        reason: 'Превосходная степень без подтверждения',
        ad: AD,
      },
      { run: runner.run },
    );

    const system = runner.calls[0]?.system ?? '';
    expect(system).toContain('Превосходная степень без подтверждения');
    expect(system).toContain(AD.title);
    expect(system).toContain(AD.text);
    expect(system).toContain('`superlative`');
  });

  it('пустую причину заменяет пояснением, а не пустотой', async () => {
    const runner = queueRunner<RejectionClassificationDraft>([draft({ category: 'other' })]);

    const result = await classifyRejection(
      { clientId: 'cl1', channel: Provider.YANDEX_DIRECT, reason: '   ', ad: AD },
      { run: runner.run },
    );

    expect(runner.calls[0]?.system).toContain('Площадка не указала причину');
    expect(result.category).toBe('other');
  });

  it('без фрагментов от модели отдаёт пустой список, а не undefined', async () => {
    const runner = queueRunner<RejectionClassificationDraft>([
      { category: 'medicine', confidence: 0.4, explanation: 'Медицинская тематика.' },
    ]);

    const result = await classifyRejection(
      { clientId: 'cl1', channel: Provider.VK_ADS, reason: 'Медицина', ad: AD },
      { run: runner.run },
    );

    expect(result.fragments).toEqual([]);
    // Правило VK попадает в набор только для своего канала.
    expect(result.rules.map((rule) => rule.id)).toContain('med-before-after');
  });
});
