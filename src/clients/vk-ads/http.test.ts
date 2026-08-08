import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  computeThrottleDelayMs,
  mapVkHttpError,
  parseRateLimitHeaders,
  RateLimitGovernor,
  shouldRetryInProcess,
  VkHttpClient,
  VK_COLD_START_RPS,
  VK_MAX_BACKOFF_MS,
  VK_SNAPSHOT_TTL_MS,
  type VkResponse,
  type VkTransport,
} from '@/clients/vk-ads/http.js';
import { AuthError, ChannelError, RateLimitError } from '@/lib/errors.js';

const okSchema = z.object({ ok: z.boolean() });

function transportOf(responses: VkResponse[]): { transport: VkTransport; calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  const transport: VkTransport = async (config) => {
    calls.push(config);
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!res) throw new Error('no stub response');
    return res;
  };
  return { transport, calls };
}

/** Троттлинг в тестах должен быть мгновенным — паузы проверяются отдельно. */
function fastGovernor(): RateLimitGovernor {
  return new RateLimitGovernor(
    () => Date.now(),
    async () => undefined,
  );
}

describe('parseRateLimitHeaders', () => {
  it('reads every X-RateLimit family', () => {
    const snap = parseRateLimitHeaders(
      {
        'x-ratelimit-rps-limit': '20',
        'x-ratelimit-rps-remaining': '3',
        'x-ratelimit-hourly-limit': '5000',
        'x-ratelimit-hourly-remaining': '4990',
        'x-ratelimit-daily-limit': '50000',
        'x-ratelimit-daily-remaining': '49000',
      },
      1_000,
    );
    expect(snap).toEqual({
      rpsLimit: 20,
      rpsRemaining: 3,
      hourlyLimit: 5000,
      hourlyRemaining: 4990,
      dailyLimit: 50000,
      dailyRemaining: 49000,
      observedAt: 1_000,
    });
  });

  it('returns null when the platform sent no rate-limit headers', () => {
    expect(parseRateLimitHeaders({ 'content-type': 'application/json' }, 1)).toBeNull();
    expect(parseRateLimitHeaders(undefined, 1)).toBeNull();
  });
});

describe('computeThrottleDelayMs', () => {
  it('falls back to the cold-start rps before any header is seen', () => {
    const spacing = Math.ceil(1000 / VK_COLD_START_RPS);
    expect(computeThrottleDelayMs({ snapshot: null, lastRequestAt: null, now: 5_000 })).toBe(0);
    expect(computeThrottleDelayMs({ snapshot: null, lastRequestAt: 5_000, now: 5_000 })).toBe(
      spacing,
    );
  });

  it('spaces requests by 1000/rpsLimit, not by a hardcoded rate', () => {
    const snapshot = { rpsLimit: 20, rpsRemaining: 19, observedAt: 0 };
    // 20 rps → шаг 50 мс; прошло 10 мс → ждём ещё 40.
    expect(computeThrottleDelayMs({ snapshot, lastRequestAt: 1_000, now: 1_010 })).toBe(40);
    expect(computeThrottleDelayMs({ snapshot, lastRequestAt: 1_000, now: 1_100 })).toBe(0);
  });

  it('waits out the current second when the rps window is exhausted', () => {
    const snapshot = { rpsLimit: 20, rpsRemaining: 0, observedAt: 0 };
    expect(computeThrottleDelayMs({ snapshot, lastRequestAt: 1_000, now: 10_250 })).toBe(750);
  });

  it('waits for the next hour and next day on exhausted long windows', () => {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    const now = 3 * day + 5 * hour + 90_000;

    expect(
      computeThrottleDelayMs({
        snapshot: { hourlyRemaining: 0, rpsRemaining: 5, observedAt: now },
        lastRequestAt: null,
        now,
      }),
    ).toBe(hour - 90_000);

    // Дневное окно жёстче часового и проверяется первым.
    expect(
      computeThrottleDelayMs({
        snapshot: { dailyRemaining: 0, hourlyRemaining: 0, observedAt: now },
        lastRequestAt: null,
        now,
      }),
    ).toBe(day - (5 * hour + 90_000));
  });

  it('ignores exhausted counters from a snapshot older than its shelf life', () => {
    const now = 10 * 60 * 60 * 1000;
    const stale = { dailyRemaining: 0, rpsLimit: 10, observedAt: now - VK_SNAPSHOT_TTL_MS - 1 };
    // Счётчик «остатка» описывает окно на момент ответа; час спустя он ничего не значит,
    // иначе один ответ навсегда парализовал бы клиент в процессе.
    expect(computeThrottleDelayMs({ snapshot: stale, lastRequestAt: null, now })).toBe(0);
    expect(computeThrottleDelayMs({ snapshot: stale, lastRequestAt: now - 10, now })).toBe(90);

    const fresh = { ...stale, observedAt: now - VK_SNAPSHOT_TTL_MS + 1 };
    expect(computeThrottleDelayMs({ snapshot: fresh, lastRequestAt: null, now })).toBeGreaterThan(
      VK_MAX_BACKOFF_MS,
    );
  });
});

describe('shouldRetryInProcess', () => {
  it('refuses to sleep in-process longer than the backoff cap', () => {
    expect(shouldRetryInProcess(new RateLimitError('VK_ADS', 5_000))).toBe(true);
    expect(shouldRetryInProcess(new RateLimitError('VK_ADS', VK_MAX_BACKOFF_MS + 1))).toBe(false);
    expect(shouldRetryInProcess(new ChannelError('VK_ADS', 'boom', { retryable: true }))).toBe(
      true,
    );
    expect(shouldRetryInProcess(new AuthError('VK_ADS'))).toBe(false);
  });
});

describe('RateLimitGovernor', () => {
  it('sleeps for the computed spacing and serialises concurrent acquires', async () => {
    let clock = 0;
    const slept: number[] = [];
    const gov = new RateLimitGovernor(
      () => clock,
      async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    );
    gov.observe({ 'x-ratelimit-rps-limit': '10' });

    await gov.acquire();
    await gov.acquire();
    await gov.acquire();

    // Первый запрос идёт сразу, каждый следующий — через 100 мс (10 rps).
    expect(slept).toEqual([100, 100]);
  });

  it('throws RateLimitError instead of sleeping out an exhausted daily window', async () => {
    const day = 24 * 60 * 60 * 1000;
    const clock = 3 * day + 90_000;
    const slept: number[] = [];
    const gov = new RateLimitGovernor(
      () => clock,
      async (ms) => {
        slept.push(ms);
      },
    );
    gov.observe({ 'x-ratelimit-daily-remaining': '0' });

    const err = await gov.acquire().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    // Задача должна уехать в отложенные, а не занимать слот воркера почти сутки.
    expect((err as RateLimitError).retryAfterMs).toBe(day - 90_000);
    expect(slept).toEqual([]);
  });

  it('keeps serving the queue after a deferred acquire', async () => {
    const day = 24 * 60 * 60 * 1000;
    let clock = 3 * day + 90_000;
    const gov = new RateLimitGovernor(
      () => clock,
      async () => undefined,
    );
    gov.observe({ 'x-ratelimit-daily-remaining': '0' });
    await expect(gov.acquire()).rejects.toBeInstanceOf(RateLimitError);

    // Сутки сменились — снимок протух, цепочка не встала.
    clock += 2 * VK_SNAPSHOT_TTL_MS;
    await expect(gov.acquire()).resolves.toBeUndefined();
  });

  it('aborts a pending throttle wait instead of holding a timer open', async () => {
    let clock = 0;
    const controller = new AbortController();
    // Ожидание настоящее: проверяем, что сигнал доходит до sleep().
    const gov = new RateLimitGovernor(() => clock);
    gov.observe({ 'x-ratelimit-rps-limit': '1' });
    await gov.acquire(controller.signal);

    clock += 1;
    const startedAt = Date.now();
    const pending = gov.acquire(controller.signal);
    // Даём паузе действительно начаться, иначе проверили бы только ранний выход.
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toThrow(/Aborted/);
    // Секундный таймер снят, а не дождан: именно он не давал бы завершиться воркеру.
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('refuses a slot outright when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const gov = new RateLimitGovernor(
      () => 0,
      async () => undefined,
    );
    await expect(gov.acquire(controller.signal)).rejects.toMatchObject({ code: 'VK_ABORTED' });
  });
});

describe('mapVkHttpError', () => {
  it('maps 401 to AuthError and 429 to RateLimitError with Retry-After', () => {
    const auth = mapVkHttpError({ status: 401, data: { error: 'invalid_token' } }, 'GET', 'x.json');
    expect(auth).toBeInstanceOf(AuthError);
    expect(auth.retryable).toBe(false);

    const limited = mapVkHttpError(
      { status: 429, data: {}, headers: { 'retry-after': '7' } },
      'GET',
      'x.json',
    );
    expect(limited).toBeInstanceOf(RateLimitError);
    expect(limited.retryAfterMs).toBe(7_000);
  });

  it('caps Retry-After at 30s and only retries 5xx for idempotent methods', () => {
    const capped = mapVkHttpError(
      { status: 429, data: {}, headers: { 'retry-after': '600' } },
      'GET',
      'x.json',
    );
    expect(capped.retryAfterMs).toBe(30_000);

    expect(mapVkHttpError({ status: 502, data: {} }, 'GET', 'x.json').retryable).toBe(true);
    expect(mapVkHttpError({ status: 502, data: {} }, 'POST', 'x.json').retryable).toBe(false);
  });
});

describe('VkHttpClient', () => {
  it('refreshes the token once on 401 and replays the request', async () => {
    const { transport, calls } = transportOf([
      { status: 401, data: { error: 'expired' } },
      { status: 200, data: { ok: true } },
    ]);
    const getAccessToken = vi
      .fn<(opts?: { forceRefresh?: boolean }) => Promise<string>>()
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('fresh')
      .mockResolvedValue('fresh');

    const client = new VkHttpClient({
      transport,
      getAccessToken,
      attempts: 1,
      governor: fastGovernor(),
    });
    await expect(
      client.request({ method: 'GET', url: 'x.json', schema: okSchema }),
    ).resolves.toEqual({ ok: true });

    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(calls).toHaveLength(2);
    const [first, second] = calls as Array<{ headers: Record<string, string> }>;
    expect(first?.headers['Authorization']).toBe('Bearer stale');
    expect(second?.headers['Authorization']).toBe('Bearer fresh');
  });

  it('gives up with AuthError when 401 survives the refresh', async () => {
    const { transport, calls } = transportOf([{ status: 401, data: { error: 'revoked' } }]);
    const client = new VkHttpClient({
      transport,
      getAccessToken: async () => 'token',
      attempts: 1,
      governor: fastGovernor(),
    });

    await expect(
      client.request({ method: 'GET', url: 'x.json', schema: okSchema }),
    ).rejects.toBeInstanceOf(AuthError);
    // Ровно две попытки: исходная и одна после refresh.
    expect(calls).toHaveLength(2);
  });

  it('rejects a response that does not match its schema', async () => {
    const { transport } = transportOf([{ status: 200, data: { ok: 'yes' } }]);
    const client = new VkHttpClient({
      transport,
      getAccessToken: async () => 'token',
      attempts: 1,
      governor: fastGovernor(),
    });

    await expect(
      client.request({ method: 'GET', url: 'x.json', schema: okSchema }),
    ).rejects.toMatchObject({ code: 'VK_SCHEMA_MISMATCH', retryable: false });
  });

  it('wraps transport failures and keeps writes non-retryable', async () => {
    const transport: VkTransport = async () => {
      throw new Error('ECONNRESET');
    };
    const client = new VkHttpClient({
      transport,
      getAccessToken: async () => 'token',
      attempts: 1,
      governor: fastGovernor(),
    });

    const err = await client
      .request({ method: 'POST', url: 'x.json', schema: okSchema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).retryable).toBe(false);
  });

  it('surfaces an exhausted daily window as RateLimitError without hanging the worker', async () => {
    const day = 24 * 60 * 60 * 1000;
    const clock = 3 * day + 90_000;
    const { transport, calls } = transportOf([{ status: 200, data: { ok: true } }]);
    const governor = new RateLimitGovernor(
      () => clock,
      async () => {
        throw new Error('governor must not sleep out a whole day');
      },
    );
    governor.observe({ 'x-ratelimit-daily-remaining': '0' });

    const client = new VkHttpClient({
      transport,
      getAccessToken: async () => 'token',
      attempts: 4,
      governor,
    });

    const err = await client
      .request({ method: 'GET', url: 'x.json', schema: okSchema })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(day - 90_000);
    // И не ретраится внутри процесса: withRetry уснул бы ровно на эту подсказку.
    expect(calls).toHaveLength(0);
  });

  it('replays a 429 on a write, because mass_action writes are absolute assignments', async () => {
    const { transport, calls } = transportOf([
      { status: 429, data: {}, headers: { 'retry-after': '0' } },
      { status: 200, data: { ok: true } },
    ]);
    const client = new VkHttpClient({
      transport,
      getAccessToken: async () => 'token',
      attempts: 2,
      governor: fastGovernor(),
    });

    await expect(
      client.request({ method: 'POST', url: 'ad_plans/mass_action.json', schema: okSchema }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('records rate-limit headers from successful responses', async () => {
    const { transport } = transportOf([
      { status: 200, data: { ok: true }, headers: { 'x-ratelimit-rps-limit': '17' } },
    ]);
    const client = new VkHttpClient({
      transport,
      getAccessToken: async () => 'token',
      attempts: 1,
      governor: fastGovernor(),
    });
    await client.request({ method: 'GET', url: 'x.json', schema: okSchema });
    expect(client.rateLimit?.rpsLimit).toBe(17);
  });
});
