import { describe, expect, it } from 'vitest';

import { ImageCache, imageCacheKey } from './cache.js';
import type { GeneratedImage, ImageGenerationRequest } from './provider.js';

const SIZE = { width: 1024, height: 1024 };

function image(): GeneratedImage {
  return {
    data: new Uint8Array([1]),
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    provider: 'fusionbrain',
    model: 'kandinsky-3.1',
    censored: false,
  };
}

function req(over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return { prompt: 'баннер', format: 'square_1080', ...over };
}

describe('imageCacheKey', () => {
  it('одинаковый запрос — одинаковый ключ', () => {
    expect(imageCacheKey('p', 'm', req(), SIZE)).toBe(imageCacheKey('p', 'm', req(), SIZE));
  });

  it('любое поле, влияющее на картинку, меняет ключ', () => {
    const base = imageCacheKey('p', 'm', req(), SIZE);
    expect(imageCacheKey('p', 'm', req({ prompt: 'другое' }), SIZE)).not.toBe(base);
    expect(imageCacheKey('p', 'm', req({ seed: 7 }), SIZE)).not.toBe(base);
    expect(imageCacheKey('p', 'm', req({ style: 'ANIME' }), SIZE)).not.toBe(base);
    expect(imageCacheKey('p', 'm', req({ negativePrompt: 'текст' }), SIZE)).not.toBe(base);
    expect(imageCacheKey('p', 'm', req(), { width: 576, height: 1024 })).not.toBe(base);
    expect(imageCacheKey('other', 'm', req(), SIZE)).not.toBe(base);
  });
});

describe('ImageCache', () => {
  it('отдаёт положенное и считает попадания', () => {
    const cache = new ImageCache();
    cache.set('k', image());
    expect(cache.get('k')).toBeDefined();
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('протухшая запись не отдаётся', () => {
    const cache = new ImageCache(0);
    cache.set('k', image(), 0);
    expect(cache.get('k')).toBeUndefined();
  });

  it('вытесняет самую старую запись при переполнении', () => {
    const cache = new ImageCache(60_000, 2);
    cache.set('a', image());
    cache.set('b', image());
    cache.get('a');
    cache.set('c', image());

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('clear сбрасывает и записи, и счётчики', () => {
    const cache = new ImageCache();
    cache.set('k', image());
    cache.get('k');
    cache.clear();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, size: 0 });
  });
});
