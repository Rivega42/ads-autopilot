import { describe, expect, it, vi } from 'vitest';

import { AppError, OutOfUnitsError, RateLimitError } from '@/lib/errors.js';
import { backoffDelay, withRetry, withTimeout } from '@/lib/retry.js';

describe('backoffDelay', () => {
  it('растёт экспоненциально по верхней границе', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      expect(backoffDelay(1, 1000, 30_000)).toBe(1000);
      expect(backoffDelay(2, 1000, 30_000)).toBe(2000);
      expect(backoffDelay(3, 1000, 30_000)).toBe(4000);
    } finally {
      spy.mockRestore();
    }
  });

  it('упирается в потолок', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      expect(backoffDelay(20, 1000, 30_000)).toBe(30_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('джиттерит вниз от границы', () => {
    // Полный джиттер обязателен: без него все воркеры, словившие 429
    // одновременно, вернутся тоже одновременно и получат 429 снова.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(backoffDelay(5, 1000, 30_000)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('withRetry', () => {
  it('возвращает результат без повторов, если всё хорошо', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('повторяет retryable-ошибку и в итоге отдаёт результат', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new RateLimitError('VK_ADS', 1))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('не повторяет неretryable-ошибку', async () => {
    const fn = vi.fn().mockRejectedValue(new AppError('fatal', { retryable: false }));
    await expect(withRetry(fn, { attempts: 5, baseMs: 1 })).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('пробрасывает последнюю ошибку, исчерпав попытки', async () => {
    const fn = vi.fn().mockRejectedValue(new RateLimitError('VK_ADS', 1));
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toThrow('Rate limited');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('уважает retryAfterMs площадки вместо собственной формулы', async () => {
    // Директ на error 52 просит вернуться через час — своя экспонента здесь вредна.
    const err = new OutOfUnitsError('YANDEX_DIRECT', 5);
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    const started = Date.now();
    await expect(withRetry(fn, { attempts: 2 })).resolves.toBe('ok');
    // Ждали ровно подсказанные 5 мс, а не baseMs=1000.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('слушается пользовательского shouldRetry', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('plain'));
    await expect(
      withRetry(fn, { attempts: 3, baseMs: 1, shouldRetry: () => true }),
    ).rejects.toThrow('plain');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('withTimeout', () => {
  it('отдаёт результат, если операция успела', async () => {
    await expect(withTimeout(async () => 'ok', 1000, 'быстрая')).resolves.toBe('ok');
  });

  it('падает по таймауту, а не ждёт вечно', async () => {
    const hanging = () => new Promise<never>(() => {});
    await expect(withTimeout(hanging, 5, 'зависшая')).rejects.toThrow(
      'зависшая: нет ответа за 5 мс',
    );
  });

  it('пробрасывает ошибку операции как есть', async () => {
    const failing = () => Promise.reject(new AppError('нет сети', { code: 'NET' }));
    await expect(withTimeout(failing, 1000, 'сетевая')).rejects.toThrow('нет сети');
  });

  it('снимает таймер после успеха: процесс не держится живым лишние секунды', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await withTimeout(async () => 'ok', 60_000, 'быстрая');
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });
});
