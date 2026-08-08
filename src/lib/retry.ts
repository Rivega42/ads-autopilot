import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'retry' });

export interface RetryOptions {
  /** Сколько всего попыток, включая первую. */
  attempts?: number;
  /** База экспоненты, мс. Задержка = baseMs * 2^(n-1) + jitter. */
  baseMs?: number;
  maxDelayMs?: number;
  /** Решает, стоит ли повторять. По умолчанию — только AppError с retryable. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  label?: string;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('Aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Экспоненциальный backoff с полным джиттером. Джиттер обязателен: без него
 * все воркеры, словившие 429 одновременно, ретраятся тоже одновременно.
 */
export function backoffDelay(attempt: number, baseMs: number, maxDelayMs: number): number {
  const exp = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.round(Math.random() * exp);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseMs = 1000,
    maxDelayMs = 30_000,
    shouldRetry = (err) => err instanceof AppError && err.retryable,
    label = 'operation',
    signal,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !shouldRetry(err, attempt)) throw err;

      // Площадка сама сказала, когда возвращаться — уважаем это вместо своей формулы.
      const hinted = err instanceof AppError ? err.retryAfterMs : undefined;
      const delay = hinted ?? backoffDelay(attempt, baseMs, maxDelayMs);
      log.warn(
        { label, attempt, attempts, delay, err: describeError(err) },
        'retrying after failure',
      );
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}
