import { createHash } from 'node:crypto';
import { scoped } from '@/lib/logger.js';
import type { LlmRequest, LlmResponse } from './types.js';

const log = scoped('llm:cache');

/**
 * Кеш одинаковых промптов.
 *
 * Зачем: агенты в этом проекте вызываются пачками по расписанию — модератор
 * гоняет один и тот же классификатор по десяткам объявлений с повторяющимися
 * причинами отказа, wordstat переспрашивает те же seed-фразы после ретрая задачи
 * в BullMQ. Платить дважды за побайтово одинаковый запрос незачем.
 *
 * Кеш процессный и намеренно не в Redis: он должен быть быстрым и не создавать
 * ещё одну точку отказа. Потеря кеша при рестарте воркера стоит центы.
 */

export interface CacheEntry {
  response: LlmResponse;
  storedAt: number;
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

/** Ключ строится из всего, что влияет на ответ. Забыть поле = отдать чужой ответ. */
export function cacheKey(req: LlmRequest, extra?: string): string {
  const payload = JSON.stringify({
    provider: req.model.provider,
    model: req.model.model,
    effort: req.model.effort ?? null,
    thinking: req.model.adaptiveThinking ?? false,
    maxTokens: req.maxTokens ?? req.model.maxTokens,
    temperature: req.temperature ?? null,
    json: req.json ?? false,
    system: req.system ?? null,
    messages: req.messages,
    // Отпечаток zod-схемы: тот же промпт с другой ожидаемой формой ответа —
    // это другой запрос, потому что structured.ts допишет другую инструкцию.
    extra: extra ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export class LlmCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): LlmResponse | undefined {
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
    // Перекладываем в конец: Map хранит порядок вставки, так получается LRU
    // без отдельной структуры.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    log.debug({ key: key.slice(0, 12) }, 'llm cache hit');
    return entry.response;
  }

  set(key: string, response: LlmResponse, ttlMs = this.ttlMs): void {
    const now = Date.now();
    this.entries.set(key, { response, storedAt: now, expiresAt: now + ttlMs });
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

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}

/** Общий на процесс. Тесты могут сбросить через llmCache.clear(). */
export const llmCache = new LlmCache();
