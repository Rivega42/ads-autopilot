import { describe, expect, it, vi } from 'vitest';

import type { AgentRun } from '@/clients/llm/index.js';
import { buildKeywordCore } from '@/keywords/core.js';
import type { KeywordExpansion, RunExpandAgent } from '@/keywords/expand.js';
import type { FrequencyRequest, FrequencySource } from '@/keywords/frequency.js';
import type { NegativeSuggestion, RunNegativesAgent } from '@/keywords/negatives.js';
import type { KeywordSetStore } from '@/keywords/store.js';

/**
 * Сборка ядра целиком, но без сети и без БД: модель, источник частот и Prisma
 * подменены. Ни один тест не должен уметь потратить ни доллара, ни балла квоты.
 */

const RAW_PHRASES = [
  'курсы английского',
  'Курсы   Английского',
  'английского курсы',
  'курсы английского онлайн',
  'онлайн курсы английского',
  'английский для программистов',
  'один два три четыре пять шесть семь восемь',
];

function expansion(phrases: string[]): AgentRun<KeywordExpansion> {
  return {
    data: { phrases },
    text: '',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: { tokensIn: 10, tokensOut: 10 },
    costUsd: 0.0001,
    latencyMs: 10,
    cached: false,
    aiRunId: '1',
  };
}

function suggestion(data: NegativeSuggestion): AgentRun<NegativeSuggestion> {
  return {
    data,
    text: '',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: { tokensIn: 10, tokensOut: 10 },
    costUsd: 0.0001,
    latencyMs: 10,
    cached: false,
    aiRunId: '2',
  };
}

function countingSource(table: Readonly<Record<string, number>>): FrequencySource & {
  calls: FrequencyRequest[];
} {
  const calls: FrequencyRequest[] = [];
  return {
    name: 'stub',
    calls,
    isConfigured: () => true,
    fetch: (request) => {
      calls.push(request);
      return Promise.resolve(
        request.phrases.map((phrase) => ({ phrase, impressions: table[phrase] ?? 100 })),
      );
    },
  };
}

const runExpand: RunExpandAgent = () => Promise.resolve(expansion(RAW_PHRASES));
const runNegatives: RunNegativesAgent = () => Promise.resolve(suggestion({ negatives: [] }));

describe('buildKeywordCore', () => {
  it('дедуплицирует до похода в API: запросов меньше, чем фраз от модели', async () => {
    const source = countingSource({});

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives,
      frequencySource: source,
    });

    expect(core.frequencies.phrasesRequested).toBe(3);
    expect(core.frequencies.phrasesRequested).toBeLessThan(RAW_PHRASES.length);
    expect(core.duplicates).toBe(3);
    expect(source.calls[0]?.phrases).toHaveLength(3);
  });

  it('фразу длиннее семи слов отбрасывает и объясняет почему', async () => {
    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives,
      frequencySource: countingSource({}),
    });

    expect(core.phrases.map((p) => p.phrase)).not.toContain(
      'один два три четыре пять шесть семь восемь',
    );
    expect(core.rejected).toEqual([
      expect.objectContaining({ reason: 'too-many-words', words: 8 }),
    ]);
  });

  it('частоты берутся только из источника', async () => {
    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives,
      frequencySource: countingSource({ 'курсы английского': 55_000 }),
    });

    const main = core.phrases.find((p) => p.phrase === 'курсы английского');
    expect(main?.frequency).toBe(55_000);
    expect(core.frequencies.available).toBe(true);
  });

  it('без источника частот все частоты null, а ядро остаётся целым', async () => {
    const core = await buildKeywordCore({ seed: 'курсы английского', runExpand, runNegatives });

    expect(core.frequencies.available).toBe(false);
    expect(core.phrases.every((p) => p.frequency === null)).toBe(true);
    expect(core.phrases.length).toBeGreaterThan(0);
    expect(core.lowVolume).toBe(0);
  });

  it('число из ответа модели частотой не становится', async () => {
    // Модель «подсказывает» частоту прямо в тексте фразы — она обязана остаться текстом.
    const noisy: RunExpandAgent = () =>
      Promise.resolve(expansion(['курсы английского 12000 показов', 'английский с нуля']));

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand: noisy,
      runNegatives,
    });

    expect(core.frequencies.source).toBe('unavailable');
    expect(core.phrases.map((p) => p.frequency)).toEqual([null, null]);
  });

  it('отсекает низкочастотные, только когда частоты действительно получены', async () => {
    const source = countingSource({
      'курсы английского': 1,
      'курсы английского онлайн': 900,
      'английский для программистов': 900,
    });

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives,
      frequencySource: source,
      minImpressions: 5,
    });

    expect(core.phrases.map((p) => p.phrase)).not.toContain('курсы английского');
    expect(core.lowVolume).toBe(1);
  });

  it('помечает ослабленную кластеризацию', async () => {
    const core = await buildKeywordCore({ seed: 'курсы английского', runExpand, runNegatives });

    expect(core.clustering.method).toBe('lexical-fallback');
    expect(core.clustering.degraded).toBe(true);
    expect(core.clusters.length).toBeGreaterThan(0);
    expect(core.phrases.every((p) => typeof p.clusterId === 'number')).toBe(true);
  });

  it('собирает предиктивные минус-слова из поисковых запросов', async () => {
    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives,
      searchQueries: ['курсы английского бесплатно', 'скачать учебник'],
    });

    expect(core.negatives.map((n) => n.phrase).sort()).toEqual(['бесплатно', 'скачать']);
    expect(core.negatives.every((n) => n.source === 'dictionary')).toBe(true);
  });

  it('не даёт модели заминусовать собственный ключ', async () => {
    const harmful: RunNegativesAgent = () =>
      Promise.resolve(
        suggestion({
          negatives: [
            { phrase: 'английский', reason: 'нецелевое' },
            { phrase: 'реферат', reason: 'учебная работа' },
          ],
        }),
      );

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives: harmful,
      searchQueries: ['реферат по английскому'],
    });

    expect(core.negatives.map((n) => n.phrase)).toEqual(['реферат']);
  });

  it('падение агента минус-слов не роняет ядро', async () => {
    const broken: RunNegativesAgent = () => Promise.reject(new Error('429'));

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives: broken,
      searchQueries: ['курсы английского бесплатно'],
    });

    expect(core.phrases.length).toBeGreaterThan(0);
    expect(core.negatives.map((n) => n.phrase)).toEqual(['бесплатно']);
  });

  it('useModelNegatives:false обходится словарём и не тратит токены', async () => {
    const run = vi.fn<Parameters<RunNegativesAgent>, ReturnType<RunNegativesAgent>>();

    await buildKeywordCore({
      seed: 'курсы английского',
      runExpand,
      runNegatives: run,
      useModelNegatives: false,
      searchQueries: ['курсы английского бесплатно'],
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('готовые фразы отменяют вызов модели', async () => {
    const run = vi.fn<Parameters<RunExpandAgent>, ReturnType<RunExpandAgent>>();

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      phrases: ['курсы английского', 'английский с нуля'],
      runExpand: run,
      useModelNegatives: false,
    });

    expect(run).not.toHaveBeenCalled();
    expect(core.phrases).toHaveLength(2);
    expect(core.prompts).toEqual([]);
  });

  it('сохраняет снимок, когда передана БД', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'ks9' });
    const db = { keywordSet: { create } } as unknown as KeywordSetStore;

    const core = await buildKeywordCore({
      seed: 'курсы английского',
      clientId: 'c1',
      runExpand,
      runNegatives,
      db,
      now: () => new Date('2026-08-10T09:00:00Z'),
    });

    expect(core.keywordSetId).toBe('ks9');
    expect(create.mock.calls[0]?.[0].data.phrases.clustering.degraded).toBe(true);
    expect(create.mock.calls[0]?.[0].data.seed).toBe('курсы английского');
  });

  it('без clientId в БД ничего не пишет', async () => {
    const create = vi.fn();
    const db = { keywordSet: { create } } as unknown as KeywordSetStore;

    const core = await buildKeywordCore({ seed: 'курсы английского', runExpand, runNegatives, db });

    expect(create).not.toHaveBeenCalled();
    expect(core.keywordSetId).toBeNull();
  });
});
