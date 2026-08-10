import { Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { DIRECT_TEXT_MAX } from '@/campaigns/limits.js';
import { queueRunner } from '@/moderation/__tests__/fakes.js';
import { rewriteRejectedAd, validateRewrite, REWRITE_CALLS } from '@/moderation/rewrite.js';
import { rulesFor } from '@/moderation/rules.js';
import type { AdRewriteDraft } from '@/moderation/schema.js';
import type { ClassifiedRejection } from '@/moderation/types.js';

const ORIGINAL = {
  title: 'Лучший ремонт стиральных машин',
  text: 'Починим быстро и качественно, гарантия результата на все работы.',
};

const CLASSIFICATION: ClassifiedRejection = {
  category: 'superlative',
  confidence: 0.9,
  explanation: 'Превосходная степень «лучший» без подтверждения.',
  fragments: ['Лучший'],
  rules: rulesFor('superlative', Provider.YANDEX_DIRECT),
  promptVersion: 'moderation-classify@1.0.0',
};

function input(moderationAttempt = 0) {
  return {
    clientId: 'cl1',
    channel: Provider.YANDEX_DIRECT,
    reason: 'Превосходная степень без подтверждения',
    classification: CLASSIFICATION,
    ad: ORIGINAL,
    moderationAttempt,
  };
}

const GOOD: AdRewriteDraft = {
  title: 'Ремонт стиральных машин',
  title2: 'Выезд в день заявки',
  text: 'Мастер приедет с деталями. Диагностика перед ремонтом, договор и чек.',
  changes: 'Убрал превосходную степень и обещание результата.',
};

const TOO_LONG: AdRewriteDraft = {
  ...GOOD,
  text: 'Мастер приедет с деталями в день обращения, проведёт диагностику, оформит договор и даст чек на все выполненные работы.',
};

describe('validateRewrite', () => {
  it('пропускает нормальный вариант', () => {
    expect(validateRewrite(ORIGINAL, GOOD, Provider.YANDEX_DIRECT)).toEqual([]);
  });

  it('ловит превышение лимита текста', () => {
    expect(TOO_LONG.text.length).toBeGreaterThan(DIRECT_TEXT_MAX);
    const problems = validateRewrite(ORIGINAL, TOO_LONG, Provider.YANDEX_DIRECT);
    expect(problems.join(' ')).toMatch(/поле text: \d+ символов при лимите 81/u);
  });

  it('ловит вернувшееся нарушение по базе правил', () => {
    const problems = validateRewrite(
      ORIGINAL,
      { title: 'Самый быстрый ремонт', text: 'Приедем сегодня и починим.' },
      Provider.YANDEX_DIRECT,
    );
    expect(problems.join(' ')).toContain('superlative-unproven');
  });

  it('не принимает исходный текст обратно: площадка его уже отклонила', () => {
    const problems = validateRewrite(
      ORIGINAL,
      { title: '  лучший ремонт стиральных машин ', text: ORIGINAL.text },
      Provider.YANDEX_DIRECT,
    );
    expect(problems.join(' ')).toContain('текст не изменился');
  });
});

describe('rewriteRejectedAd', () => {
  it('возвращает годный вариант с первой попытки', async () => {
    const runner = queueRunner<AdRewriteDraft>([GOOD]);

    const result = await rewriteRejectedAd(input(), { run: runner.run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ad).toEqual({ title: GOOD.title, title2: GOOD.title2, text: GOOD.text });
    expect(result.regenerated).toBe(0);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.task).toBe('moderation.rewrite');
  });

  it('не влезший вариант отправляет модели заново, а не в кабинет', async () => {
    const runner = queueRunner<AdRewriteDraft>([TOO_LONG, GOOD]);

    const result = await rewriteRejectedAd(input(), { run: runner.run });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ad.text).toBe(GOOD.text);
    expect(result.regenerated).toBe(1);
    expect(runner.calls).toHaveLength(2);
    // Вторая попытка обязана идти мимо кеша, иначе вернётся тот же длинный текст.
    expect(runner.calls[0]?.cache).toBe(true);
    expect(runner.calls[1]?.cache).toBe(false);
    // И модель должна увидеть, что именно было не так.
    expect(runner.calls[1]?.system).toMatch(/поле text: \d+ символов при лимите 81/u);
  });

  it('сдаётся после исчерпания попыток и не отдаёт последний черновик', async () => {
    const runner = queueRunner<AdRewriteDraft>([TOO_LONG]);

    const result = await rewriteRejectedAd(input(), { run: runner.run });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(runner.calls).toHaveLength(REWRITE_CALLS);
    expect(result.problems.join(' ')).toContain('поле text');
  });

  it('на повторной попытке модерации просит другой ход и не берёт кеш', async () => {
    const runner = queueRunner<AdRewriteDraft>([GOOD]);

    await rewriteRejectedAd(input(2), { run: runner.run });

    expect(runner.calls[0]?.cache).toBe(false);
    expect(runner.calls[0]?.system).toContain('Это попытка №3');
  });

  it('отвергает ответ модели «и так всё в порядке»', async () => {
    const unchanged: AdRewriteDraft = { ...ORIGINAL, changes: 'Здесь нечего исправлять.' };
    const runner = queueRunner<AdRewriteDraft>([unchanged]);

    const result = await rewriteRejectedAd(input(), { run: runner.run });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(' ')).toContain('текст не изменился');
  });
});
