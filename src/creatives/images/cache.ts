import { createHash } from 'node:crypto';

import type { GeneratedImage, ImageGenerationRequest } from './provider.js';

import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:image-cache' });

/**
 * Кеш сгенерированных картинок по отпечатку промпта.
 *
 * Устроен как `clients/llm/cache.ts`, но причина другая и она жёстче. У LLM повтор
 * запроса стоит центы; здесь каждая генерация — платный и не идемпотентный вызов,
 * а поводов повторить её предостаточно: ретрай задачи в BullMQ, перезапуск пайплайна
 * после падения на заливке, второй прогон того же плана из CLI. Без кеша каждый такой
 * повтор — новые деньги за ту же картинку.
 *
 * TTL заметно длиннее LLM-шного: картинка не устаревает за час, а стоит дороже.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Байты картинок держим в памяти воркера, поэтому записей мало. */
const DEFAULT_MAX_ENTRIES = 64;

export interface ImageCacheEntry {
  image: GeneratedImage;
  storedAt: number;
  expiresAt: number;
}

export interface ImageCacheStats {
  hits: number;
  misses: number;
  size: number;
}

/**
 * Ключ строится из всего, что влияет на картинку. Забыть поле — значит однажды
 * выдать сторис вместо баннера, потому что промпт совпал.
 */
export function imageCacheKey(
  provider: string,
  model: string,
  req: ImageGenerationRequest,
  size: { width: number; height: number },
): string {
  const payload = JSON.stringify({
    provider,
    model,
    prompt: req.prompt,
    negativePrompt: req.negativePrompt ?? null,
    style: req.style ?? null,
    seed: req.seed ?? null,
    width: size.width,
    height: size.height,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export class ImageCache {
  private readonly entries = new Map<string, ImageCacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {}

  get(key: string): GeneratedImage | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // Перекладываем в конец: Map хранит порядок вставки, так получается LRU.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    log.debug({ key: key.slice(0, 12) }, 'image cache hit');
    return entry.image;
  }

  set(key: string, image: GeneratedImage, ttlMs = this.ttlMs): void {
    const now = Date.now();
    this.entries.set(key, { image, storedAt: now, expiresAt: now + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): ImageCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}

/** Общий на процесс. Тесты сбрасывают через `imageCache.clear()`. */
export const imageCache = new ImageCache();
