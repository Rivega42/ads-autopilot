import { describe, expect, it, vi } from 'vitest';

import {
  fetchFrequencies,
  frequencyOf,
  unavailableFrequencySource,
  type FrequencyRequest,
  type FrequencySource,
  type PhraseFrequency,
} from '@/keywords/frequency.js';
import { dedupePhrases } from '@/keywords/normalise.js';

/** Источник, который отвечает по таблице и считает свои вызовы. Сети здесь нет. */
function stubSource(table: Readonly<Record<string, number>>): FrequencySource & {
  calls: FrequencyRequest[];
} {
  const calls: FrequencyRequest[] = [];
  return {
    name: 'stub',
    calls,
    isConfigured: () => true,
    fetch: (request): Promise<PhraseFrequency[]> => {
      calls.push(request);
      return Promise.resolve(
        request.phrases
          .filter((phrase) => table[phrase] !== undefined)
          .map((phrase) => ({ phrase, impressions: table[phrase] as number })),
      );
    },
  };
}

describe('fetchFrequencies', () => {
  it('дедупликация сокращает число фраз, отправленных в API', async () => {
    const raw = [
      'курсы английского онлайн',
      'Онлайн курсы английского',
      'курсы   английского   онлайн',
      'КУРСЫ АНГЛИЙСКОГО ОНЛАЙН',
      'английский для программистов',
    ];

    const deduped = dedupePhrases(raw);
    const source = stubSource({ [deduped.groups[0]?.phrase ?? '']: 12_000 });
    const lookup = await fetchFrequencies(source, deduped.groups);

    expect(lookup.phrasesRequested).toBe(2);
    expect(lookup.phrasesRequested).toBeLessThan(raw.length);
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.phrases).toHaveLength(2);
    expect(frequencyOf(lookup, deduped.groups[0]?.key ?? '')).toBe(12_000);
  });

  it('бьёт на батчи и не превышает размер пачки', async () => {
    const groups = dedupePhrases(Array.from({ length: 7 }, (_, i) => `фраза номер ${i}`)).groups;
    const source = stubSource({});

    const lookup = await fetchFrequencies(source, groups, { batchSize: 3 });

    expect(lookup.requests).toBe(3);
    expect(source.calls.map((c) => c.phrases.length)).toEqual([3, 3, 1]);
  });

  it('без настроенного источника частот нет, но и нулей нет', async () => {
    const groups = dedupePhrases(['курсы английского']).groups;
    const lookup = await fetchFrequencies(unavailableFrequencySource, groups);

    expect(lookup.available).toBe(false);
    expect(lookup.requests).toBe(0);
    expect(frequencyOf(lookup, groups[0]?.key ?? '')).toBeNull();
  });

  it('падение источника не роняет сборку и не выдумывает частоты', async () => {
    const groups = dedupePhrases(['курсы английского', 'английский с нуля']).groups;
    const source: FrequencySource = {
      name: 'broken',
      isConfigured: () => true,
      fetch: vi.fn().mockRejectedValue(new Error('502')),
    };

    const lookup = await fetchFrequencies(source, groups);

    expect(lookup.available).toBe(false);
    expect([...lookup.byKey.values()].every((value) => value === null)).toBe(true);
  });

  it('игнорирует фразы, которых не спрашивали, и отрицательные значения', async () => {
    const groups = dedupePhrases(['курсы английского']).groups;
    const source: FrequencySource = {
      name: 'noisy',
      isConfigured: () => true,
      fetch: () =>
        Promise.resolve([
          { phrase: 'курсы английского', impressions: -5 },
          { phrase: 'чего мы не просили', impressions: 999 },
        ]),
    };

    const lookup = await fetchFrequencies(source, groups);

    expect(lookup.available).toBe(true);
    expect(frequencyOf(lookup, groups[0]?.key ?? '')).toBeNull();
    expect([...lookup.byKey.keys()]).toHaveLength(1);
  });

  it('пустой вход не ходит в сеть', async () => {
    const source = stubSource({});
    const lookup = await fetchFrequencies(source, []);
    expect(lookup.requests).toBe(0);
    expect(source.calls).toHaveLength(0);
  });
});
