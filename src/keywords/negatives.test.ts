import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@/clients/llm/index.js';
import {
  findDictionaryNegatives,
  negativeSuggestionSchema,
  selectNegatives,
  suggestNegatives,
  type NegativeCandidate,
  type NegativeSuggestion,
  type RunNegativesAgent,
} from '@/keywords/negatives.js';

function agentRun(data: NegativeSuggestion): AgentRun<NegativeSuggestion> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: { tokensIn: 200, tokensOut: 100 },
    costUsd: 0.00002,
    latencyMs: 500,
    cached: false,
    aiRunId: '2',
  };
}

describe('findDictionaryNegatives', () => {
  it('ловит заведомо нецелевые маркеры без единого вызова модели', () => {
    const found = findDictionaryNegatives([
      'курсы английского бесплатно',
      'скачать учебник английского',
      'курсы английского цена',
    ]);

    expect(found.map((n) => n.phrase).sort()).toEqual(['бесплатно', 'скачать']);
    expect(found.every((n) => n.source === 'dictionary')).toBe(true);
  });

  it('не трогает горячий спрос: «цена» и «отзывы» минус-словами не считаются', () => {
    const found = findDictionaryNegatives(['курсы английского отзывы', 'английский цена москва']);
    expect(found).toEqual([]);
  });

  it('срабатывает по слову целиком, а не по подстроке', () => {
    // «Бесплатность» содержит «бесплатн», но не слово «бесплатно».
    expect(findDictionaryNegatives(['бесплатность обучения'])).toEqual([]);
  });

  it('находит многословный маркер', () => {
    const found = findDictionaryNegatives(['ремонт квартиры своими руками']);
    expect(found.map((n) => n.phrase)).toEqual(['своими руками']);
    expect(found[0]?.queries).toEqual(['ремонт квартиры своими руками']);
  });

  it('копит запросы под одним маркером, не дублируя его', () => {
    const found = findDictionaryNegatives(['курсы бесплатно', 'английский бесплатно']);
    expect(found).toHaveLength(1);
    expect(found[0]?.queries).toHaveLength(2);
  });
});

describe('negativeSuggestionSchema', () => {
  it('в ответе модели нет места числам', () => {
    const parsed = negativeSuggestionSchema.safeParse({
      negatives: [{ phrase: 'реферат', reason: 'учебная работа', spend: 1200 }],
    });
    expect(parsed.success).toBe(true);
    // Лишнее поле отброшено схемой, а не пронесено дальше.
    expect(parsed.success && parsed.data.negatives[0]).toEqual({
      phrase: 'реферат',
      reason: 'учебная работа',
    });
  });
});

describe('suggestNegatives', () => {
  it('уходит в дешёвую задачу keywords.classify и показывает модели ядро', async () => {
    const run = vi
      .fn<RunNegativesAgent>()
      .mockResolvedValue(
        agentRun({ negatives: [{ phrase: 'реферат', reason: 'учебная работа' }] }),
      );

    const result = await suggestNegatives({
      clientId: 'c1',
      phrases: ['курсы английского'],
      queries: ['реферат по английскому'],
      run,
    });

    const call = run.mock.calls[0]?.[0];
    expect(call?.task).toBe('keywords.classify');
    expect(call?.system).toContain('курсы английского');
    expect(call?.system).toContain('реферат по английскому');
    expect(result).toEqual([
      { phrase: 'реферат', reason: 'учебная работа', source: 'model', queries: [] },
    ]);
  });

  it('без запросов и без ядра модель не зовётся', async () => {
    const run = vi.fn<RunNegativesAgent>();
    await expect(suggestNegatives({ phrases: [], queries: [], run })).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('selectNegatives', () => {
  const candidate = (phrase: string): NegativeCandidate => ({
    phrase,
    reason: 'тест',
    source: 'model',
    queries: [],
  });

  it('выбрасывает минус-слово, которое отключило бы собственный ключ', () => {
    const result = selectNegatives({
      candidates: [candidate('английский'), candidate('реферат')],
      protectedPhrases: ['курсы английского'],
    });

    expect(result.negatives.map((n) => n.phrase)).toEqual(['реферат']);
    expect(result.dropped).toEqual([{ phrase: 'английский', reason: 'self-harm' }]);
  });

  it('короткая словоформа не проносит минус-слово мимо защиты ядра', () => {
    // Директ минусует по лемме: «тур» выключит показы по ключу «туры в турцию»
    // ровно так же, как «туры». Проверка обязана видеть это в обе стороны —
    // короткая форма может оказаться и в минус-слове, и в самом ядре.
    const short = selectNegatives({
      candidates: [candidate('тур')],
      protectedPhrases: ['туры в турцию'],
    });
    expect(short.negatives).toEqual([]);
    expect(short.dropped).toEqual([{ phrase: 'тур', reason: 'self-harm' }]);

    const long = selectNegatives({
      candidates: [candidate('розы')],
      protectedPhrases: ['роза доставка'],
    });
    expect(long.negatives).toEqual([]);
    expect(long.dropped).toEqual([{ phrase: 'розы', reason: 'self-harm' }]);
  });

  it('схлопывает дубликаты по каноническому ключу', () => {
    const result = selectNegatives({
      candidates: [candidate('Бесплатно'), candidate('бесплатно')],
      protectedPhrases: [],
    });

    expect(result.negatives).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe('duplicate');
  });

  it('отклоняет минус-фразу длиннее семи слов', () => {
    const long = 'один два три четыре пять шесть семь восемь';
    const result = selectNegatives({ candidates: [candidate(long)], protectedPhrases: [] });

    expect(result.negatives).toEqual([]);
    expect(result.dropped).toEqual([{ phrase: long, reason: 'invalid' }]);
  });

  it('уважает лимит', () => {
    const result = selectNegatives({
      candidates: [candidate('раз'), candidate('два'), candidate('три')],
      protectedPhrases: [],
      limit: 2,
    });

    expect(result.negatives).toHaveLength(2);
    expect(result.dropped).toEqual([{ phrase: 'три', reason: 'over-limit' }]);
  });

  it('нормализует то, что оставил', () => {
    const result = selectNegatives({
      candidates: [candidate('  СКАЧАТЬ   Бесплатно ')],
      protectedPhrases: [],
    });
    expect(result.negatives[0]?.phrase).toBe('скачать бесплатно');
  });
});
