import { describe, expect, it, vi } from 'vitest';

import {
  clusterPhrases,
  cosineSimilarity,
  lexicalSimilarity,
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from '@/keywords/cluster.js';

const PHRASES = [
  'курсы английского',
  'курсы английского онлайн',
  'курсы английского для детей',
  'ремонт квартир',
  'ремонт квартир под ключ',
];

describe('lexicalSimilarity', () => {
  it('близкие фразы выше далёких', () => {
    const near = lexicalSimilarity('курсы английского', 'курсы английского онлайн');
    const far = lexicalSimilarity('курсы английского', 'ремонт квартир');
    expect(near).toBeGreaterThan(far);
    expect(far).toBeLessThan(0.2);
  });

  it('склонения не разводятся: триграммы вытягивают то, что не поймали слова', () => {
    expect(lexicalSimilarity('курс английского', 'курсы английского')).toBeGreaterThan(0.4);
  });
});

describe('clusterPhrases (фолбэк)', () => {
  it('без провайдера эмбеддингов честно помечает результат как ослабленный', async () => {
    const result = await clusterPhrases(PHRASES);

    expect(result.method).toBe('lexical-fallback');
    expect(result.degraded).toBe(true);
    expect(result.note).toMatch(/лексическая/i);
    expect(result.note).toMatch(/эмбеддинг/i);
  });

  it('провайдера эмбеддингов в окружении нет — и функция об этом не врёт', () => {
    expect(resolveEmbeddingProvider()).toBeNull();
  });

  it('детерминирован: один и тот же вход даёт один и тот же выход', async () => {
    const first = await clusterPhrases(PHRASES);
    const second = await clusterPhrases(PHRASES);
    expect(second.clusters).toEqual(first.clusters);
  });

  it('не зависит от порядка входа', async () => {
    const straight = await clusterPhrases(PHRASES);
    const shuffled = await clusterPhrases([...PHRASES].reverse());
    expect(shuffled.clusters).toEqual(straight.clusters);
  });

  it('разводит несвязанные темы и собирает связанные', async () => {
    const result = await clusterPhrases(PHRASES);
    const english = result.clusters.find((c) => c.phrases.includes('курсы английского'));
    const repair = result.clusters.find((c) => c.phrases.includes('ремонт квартир'));

    expect(english?.id).not.toBe(repair?.id);
    expect(english?.phrases).toContain('курсы английского онлайн');
    expect(repair?.phrases).toContain('ремонт квартир под ключ');
  });

  it('каждая фраза попадает ровно в один кластер', async () => {
    const result = await clusterPhrases(PHRASES);
    const placed = result.clusters.flatMap((c) => c.phrases);
    expect(placed.sort()).toEqual([...PHRASES].sort());
  });

  it('имя кластера — самая общая фраза', async () => {
    const result = await clusterPhrases(PHRASES);
    const english = result.clusters.find((c) => c.phrases.includes('курсы английского'));
    expect(english?.label).toBe('курсы английского');
  });
});

describe('clusterPhrases (эмбеддинги)', () => {
  /** Векторы подставлены руками: «репетитор» рядом с «курсами», хотя слов общих нет. */
  const provider: EmbeddingProvider = {
    name: 'stub',
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) =>
          text.includes('ремонт') ? [0, 1] : text.includes('репетитор') ? [0.95, 0.31] : [1, 0],
        ),
      ),
  };

  it('помечает результат как полноценный, а не ослабленный', async () => {
    const result = await clusterPhrases(['курсы английского', 'ремонт квартир'], { provider });
    expect(result.method).toBe('embeddings');
    expect(result.degraded).toBe(false);
  });

  it('ловит синонимы, которых лексика не видит', async () => {
    const phrases = ['курсы английского', 'репетитор по английскому'];
    const semantic = await clusterPhrases(phrases, { provider });
    const lexical = await clusterPhrases(phrases);

    expect(semantic.clusters).toHaveLength(1);
    expect(lexical.clusters).toHaveLength(2);
  });

  it('короткий ответ провайдера — фолбэк, а не нулевые векторы', async () => {
    const broken: EmbeddingProvider = {
      name: 'broken',
      embed: vi.fn().mockResolvedValue([[1, 0]]),
    };
    const result = await clusterPhrases(PHRASES, { provider: broken });
    expect(result.method).toBe('lexical-fallback');
    expect(result.degraded).toBe(true);
  });

  it('cosineSimilarity: нулевой вектор не даёт NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });
});

describe('clusterPhrases (границы)', () => {
  it('пустой вход — пустой результат', async () => {
    const result = await clusterPhrases([]);
    expect(result.clusters).toEqual([]);
  });

  it('не создаёт кластеров больше лимита', async () => {
    const phrases = Array.from({ length: 12 }, (_, i) => `тема${i} слово${i}`);
    const result = await clusterPhrases(phrases, { maxClusters: 3 });
    expect(result.clusters).toHaveLength(3);
    expect(result.clusters.flatMap((c) => c.phrases)).toHaveLength(12);
  });
});
