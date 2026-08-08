import { describe, expect, it } from 'vitest';
import { LlmCache, cacheKey } from './cache.js';
import type { LlmRequest, LlmResponse } from './types.js';

const base: LlmRequest = {
  model: { provider: 'deepseek', model: 'deepseek-v4-flash', maxTokens: 500 },
  system: 'Ты классификатор.',
  messages: [{ role: 'user', content: 'реклама лекарства без рецепта' }],
};

const response: LlmResponse = {
  text: '{"category":"medicine"}',
  usage: { tokensIn: 10, tokensOut: 5 },
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
};

describe('cacheKey', () => {
  it('одинаковые запросы дают одинаковый ключ', () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base, messages: [...base.messages] }));
  });

  it('различает всё, что влияет на ответ', () => {
    const key = cacheKey(base);
    expect(cacheKey({ ...base, system: 'другое' })).not.toBe(key);
    expect(cacheKey({ ...base, messages: [{ role: 'user', content: 'другое' }] })).not.toBe(key);
    expect(cacheKey({ ...base, maxTokens: 999 })).not.toBe(key);
    expect(cacheKey({ ...base, temperature: 0.7 })).not.toBe(key);
    expect(cacheKey({ ...base, model: { ...base.model, model: 'deepseek-v4-pro' } })).not.toBe(key);
    // Другая ожидаемая схема — другой запрос: structured.ts допишет другую инструкцию.
    expect(cacheKey(base, 'schema-a')).not.toBe(cacheKey(base, 'schema-b'));
  });
});

describe('LlmCache', () => {
  it('отдаёт сохранённое значение и считает попадания', () => {
    const cache = new LlmCache();
    const key = cacheKey(base);

    expect(cache.get(key)).toBeUndefined();
    cache.set(key, response);
    expect(cache.get(key)).toEqual(response);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('не отдаёт протухшую запись', () => {
    const cache = new LlmCache();
    const key = cacheKey(base);
    cache.set(key, response, -1);
    expect(cache.get(key)).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('вытесняет самые старые записи при переполнении', () => {
    const cache = new LlmCache(60_000, 2);
    cache.set('a', response);
    cache.set('b', response);
    // Обращение к 'a' делает его свежим — вытеснить должно 'b'.
    cache.get('a');
    cache.set('c', response);

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });
});
