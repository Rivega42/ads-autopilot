import { KeywordStatus, MatchType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { NegativeCandidate } from '@/keywords/negatives.js';
import {
  latestKeywordSet,
  saveKeywordSet,
  writeNegativeKeywords,
  KEYWORD_CORE_FORMAT,
  type KeywordSetStore,
  type NegativeKeywordStore,
  type StoredKeywordCore,
} from '@/keywords/store.js';

/**
 * Prisma подменена целиком: сюда попадает форма запроса, а не его результат в БД.
 * Проверяем именно форму — составной ключ upsert'а здесь и есть предмет теста.
 */

const CORE: StoredKeywordCore = {
  format: KEYWORD_CORE_FORMAT,
  generatedAt: '2026-08-10T09:00:00.000Z',
  items: [
    {
      phrase: 'курсы английского',
      key: 'английского курсы',
      frequency: 12_000,
      clusterId: 0,
      variants: ['курсы английского'],
    },
  ],
  clusters: [{ id: 0, label: 'курсы английского', phrases: ['курсы английского'] }],
  clustering: { method: 'lexical-fallback', degraded: true, note: 'лексическая' },
  frequencies: { available: true, source: 'stub', requests: 1, phrasesRequested: 1 },
  rejected: [],
  duplicates: 3,
  prompts: ['keywords-expand@1.0.0'],
};

function keywordSetStore(): KeywordSetStore & {
  keywordSet: { create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
} {
  return {
    keywordSet: {
      create: vi.fn().mockResolvedValue({ id: 'ks1' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  } as unknown as KeywordSetStore & {
    keywordSet: { create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  };
}

function keywordStore(): NegativeKeywordStore & {
  keyword: { upsert: ReturnType<typeof vi.fn> };
} {
  return {
    keyword: { upsert: vi.fn().mockResolvedValue({ id: 'k1' }) },
  } as unknown as NegativeKeywordStore & { keyword: { upsert: ReturnType<typeof vi.fn> } };
}

describe('saveKeywordSet', () => {
  it('кладёт снимок целиком, включая способ кластеризации', async () => {
    const db = keywordSetStore();
    const negatives: NegativeCandidate[] = [
      { phrase: 'бесплатно', reason: 'ищут бесплатное', source: 'dictionary', queries: ['q'] },
    ];

    const id = await saveKeywordSet(db, {
      clientId: 'c1',
      seed: 'курсы английского',
      core: CORE,
      negatives,
    });

    expect(id).toBe('ks1');
    const data = db.keywordSet.create.mock.calls[0]?.[0].data;
    expect(data.clientId).toBe('c1');
    expect(data.phrases.format).toBe(KEYWORD_CORE_FORMAT);
    expect(data.phrases.clustering.degraded).toBe(true);
    // Запросы, из которых выведено минус-слово, в колонку не едут — там только суть.
    expect(data.negatives).toEqual([
      { phrase: 'бесплатно', reason: 'ищут бесплатное', source: 'dictionary' },
    ]);
  });
});

describe('latestKeywordSet', () => {
  it('берёт последний снимок клиента', async () => {
    const db = keywordSetStore();
    db.keywordSet.findFirst.mockResolvedValue({
      id: 'ks1',
      seed: 'курсы английского',
      createdAt: new Date('2026-08-03T00:00:00Z'),
    });

    const found = await latestKeywordSet(db, 'c1');

    expect(found?.seed).toBe('курсы английского');
    expect(db.keywordSet.findFirst.mock.calls[0]?.[0].orderBy).toEqual({ createdAt: 'desc' });
  });
});

describe('writeNegativeKeywords', () => {
  it('пишет строки с matchType NEGATIVE', async () => {
    const db = keywordStore();

    const result = await writeNegativeKeywords(db, 'ag1', ['бесплатно', 'скачать']);

    expect(result.written).toBe(2);
    const first = db.keyword.upsert.mock.calls[0]?.[0];
    expect(first.create).toMatchObject({
      adGroupId: 'ag1',
      phrase: 'бесплатно',
      matchType: MatchType.NEGATIVE,
      status: KeywordStatus.ACTIVE,
    });
  });

  it('ключ upsert включает matchType: одна фраза может быть и ключом, и минус-словом', async () => {
    const db = keywordStore();

    await writeNegativeKeywords(db, 'ag1', ['курсы английского для детей']);

    const where = db.keyword.upsert.mock.calls[0]?.[0].where;
    expect(where).toEqual({
      adGroupId_matchType_phrase: {
        adGroupId: 'ag1',
        matchType: MatchType.NEGATIVE,
        phrase: 'курсы английского для детей',
      },
    });
    // Ключа (adGroupId, phrase) без matchType быть не должно: он переписал бы боевой ключ.
    expect(where).not.toHaveProperty('adGroupId_phrase');
  });

  it('не трогает существующий ключ с той же фразой: update пустой', async () => {
    const db = keywordStore();
    await writeNegativeKeywords(db, 'ag1', ['курсы английского']);
    expect(db.keyword.upsert.mock.calls[0]?.[0].update).toEqual({});
  });

  it('нормализует фразы и схлопывает повторы', async () => {
    const db = keywordStore();

    const result = await writeNegativeKeywords(db, 'ag1', ['Бесплатно', '  бесплатно ']);

    expect(result.written).toBe(1);
    expect(db.keyword.upsert).toHaveBeenCalledTimes(1);
  });

  it('фразу длиннее семи слов в кабинет не отправляет', async () => {
    const db = keywordStore();
    const long = 'один два три четыре пять шесть семь восемь';

    const result = await writeNegativeKeywords(db, 'ag1', [long]);

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([long]);
    expect(db.keyword.upsert).not.toHaveBeenCalled();
  });

  it('в dry run считает, но не пишет', async () => {
    const db = keywordStore();

    const result = await writeNegativeKeywords(db, 'ag1', ['бесплатно'], { dryRun: true });

    expect(result).toMatchObject({ written: 0, dryRun: true });
    expect(db.keyword.upsert).not.toHaveBeenCalled();
  });
});
