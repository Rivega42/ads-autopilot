import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { YandexCredentials } from '@/clients/yandex-direct/auth.js';
import {
  MAX_CONCURRENT_REQUESTS,
  parseUnitsHeader,
  resetYandexRuntimeState,
  YandexHttpClient,
  type HttpRequest,
  type HttpResponse,
  type UnitsLedgerWriter,
} from '@/clients/yandex-direct/http.js';
import { AuthError, OutOfUnitsError } from '@/lib/errors.js';

// ── Тестовая обвязка: сеть не трогаем, Prisma не поднимаем ───────────────────

interface Step {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
}

interface FakeTransport {
  (req: HttpRequest): Promise<HttpResponse>;
  calls: HttpRequest[];
}

function transportOf(steps: Step[] | ((req: HttpRequest, n: number) => Step)): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = async (req: HttpRequest): Promise<HttpResponse> => {
    const index = calls.length;
    calls.push(req);
    const step = typeof steps === 'function' ? steps(req, index) : (steps[index] ?? steps.at(-1));
    return {
      status: step?.status ?? 200,
      headers: step?.headers ?? {},
      data: step?.data ?? { result: {} },
    };
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

function ledgerOf(): UnitsLedgerWriter & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    async record(entry) {
      entries.push({ ...entry });
    },
  };
}

const CREDS: YandexCredentials = { accessToken: 'token-abc' };
const okSchema = z.object({ result: z.object({}).passthrough() });

function clientOf(
  transport: FakeTransport,
  extra: Partial<{
    unitsReserve: number;
    ledger: UnitsLedgerWriter;
    credentials: YandexCredentials;
  }> = {},
) {
  return new YandexHttpClient({
    clientId: 'client-1',
    credentials: extra.credentials ?? CREDS,
    baseUrl: 'https://api-sandbox.direct.yandex.com/json/v5/',
    transport,
    ledger: extra.ledger ?? ledgerOf(),
    unitsReserve: extra.unitsReserve ?? 500,
    retryAttempts: 3,
  });
}

beforeEach(() => {
  resetYandexRuntimeState();
});

// ── Заголовок Units ──────────────────────────────────────────────────────────

describe('parseUnitsHeader', () => {
  it('parses the documented spent/remaining/daily-limit form', () => {
    expect(parseUnitsHeader('10/20828/64000')).toEqual({
      spent: 10,
      remaining: 20828,
      dailyLimit: 64000,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseUnitsHeader(' 5 / 100 / 1000 ')).toEqual({
      spent: 5,
      remaining: 100,
      dailyLimit: 1000,
    });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['two segments', '10/20828'],
    ['four segments', '1/2/3/4'],
    ['non-numeric', 'ten/twenty/thirty'],
    ['garbage', 'Units: unavailable'],
  ])('returns null for a malformed header (%s)', (_name, raw) => {
    expect(parseUnitsHeader(raw)).toBeNull();
  });
});

describe('units accounting', () => {
  it('persists every parsed Units header to the ledger', async () => {
    const ledger = ledgerOf();
    const transport = transportOf([{ headers: { units: '15/9000/64000' } }]);
    const http = clientOf(transport, { ledger });

    await http.call('campaigns', 'get', {}, okSchema);

    expect(ledger.entries).toEqual([
      {
        clientId: 'client-1',
        method: 'campaigns.get',
        spent: 15,
        remaining: 9000,
        dailyLimit: 64000,
      },
    ]);
    expect(http.units).toEqual({ spent: 15, remaining: 9000, dailyLimit: 64000 });
  });

  it('does not write a ledger entry when the Units header is malformed', async () => {
    const ledger = ledgerOf();
    const transport = transportOf([{ headers: { units: 'broken' } }]);
    const http = clientOf(transport, { ledger });

    await expect(http.call('campaigns', 'get', {}, okSchema)).resolves.toBeDefined();
    expect(ledger.entries).toHaveLength(0);
    expect(http.units).toBeNull();
  });

  it('survives a ledger write failure without losing the API response', async () => {
    const failing: UnitsLedgerWriter = {
      record: () => Promise.reject(new Error('db down')),
    };
    const transport = transportOf([
      { headers: { units: '1/2/3' }, data: { result: { ok: true } } },
    ]);
    const http = clientOf(transport, { ledger: failing });

    await expect(http.call('campaigns', 'get', {}, okSchema)).resolves.toBeDefined();
  });
});

describe('units reserve', () => {
  it('refuses the next call once the remaining balance drops below the reserve', async () => {
    const transport = transportOf([{ headers: { units: '20/400/64000' } }]);
    const http = clientOf(transport, { unitsReserve: 500 });

    // Первый вызов проходит: остаток ещё неизвестен.
    await http.call('campaigns', 'get', {}, okSchema);
    expect(transport.calls).toHaveLength(1);

    // Второй — отклоняется локально: отказ Директа стоил бы 20 баллов.
    await expect(http.call('campaigns', 'get', {}, okSchema)).rejects.toBeInstanceOf(
      OutOfUnitsError,
    );
    expect(transport.calls).toHaveLength(1);
  });

  it('keeps calling while the remaining balance is at or above the reserve', async () => {
    const transport = transportOf([{ headers: { units: '20/500/64000' } }]);
    const http = clientOf(transport, { unitsReserve: 500 });

    await http.call('campaigns', 'get', {}, okSchema);
    await http.call('campaigns', 'get', {}, okSchema);
    expect(transport.calls).toHaveLength(2);
  });

  it('shares the balance between clients of the same advertiser', async () => {
    const transport = transportOf([{ headers: { units: '20/10/64000' } }]);
    const first = clientOf(transport, { unitsReserve: 500 });
    await first.call('campaigns', 'get', {}, okSchema);

    const second = clientOf(transportOf([{}]), { unitsReserve: 500 });
    await expect(second.call('campaigns', 'get', {}, okSchema)).rejects.toBeInstanceOf(
      OutOfUnitsError,
    );
  });
});

// ── Ошибки и ретраи ──────────────────────────────────────────────────────────

describe('error handling', () => {
  it('maps error 152 in a HTTP 200 body to OutOfUnitsError without retrying', async () => {
    const transport = transportOf([
      { data: { error: { error_code: 152, error_string: 'Недостаточно баллов' } } },
    ]);
    const http = clientOf(transport);

    await expect(http.call('campaigns', 'get', {}, okSchema)).rejects.toBeInstanceOf(
      OutOfUnitsError,
    );
    // Один запрос — не три: ретраить в стену дороже, чем отложить задачу.
    expect(transport.calls).toHaveLength(1);
  });

  it('maps error 53 to AuthError without retrying', async () => {
    const transport = transportOf([
      { data: { error: { error_code: 53, error_string: 'Ошибка авторизации' } } },
    ]);
    const http = clientOf(transport);

    await expect(http.call('campaigns', 'get', {}, okSchema)).rejects.toBeInstanceOf(AuthError);
    expect(transport.calls).toHaveLength(1);
  });

  it('maps HTTP 401 to AuthError', async () => {
    const transport = transportOf([{ status: 401, data: 'unauthorized' }]);
    await expect(clientOf(transport).call('campaigns', 'get', {}, okSchema)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('retries error 52 and succeeds on the second attempt', async () => {
    const transport = transportOf((_req, n) =>
      n === 0
        ? { data: { error: { error_code: 52, error_string: 'Сервер авторизации недоступен' } } }
        : { data: { result: { ok: true } } },
    );
    // Пауза между попытками — ровно 1 с из подсказки ошибки; крутим таймеры, не ждём.
    vi.useFakeTimers();
    try {
      const pending = clientOf(transport).call('campaigns', 'get', {}, okSchema);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    expect(transport.calls).toHaveLength(2);
  });

  it('gives up on error 52 after the configured number of attempts', async () => {
    const transport = transportOf([{ data: { error: { error_code: 52 } } }]);
    vi.useFakeTimers();
    try {
      const pending = clientOf(transport).call('campaigns', 'get', {}, okSchema);
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    expect(transport.calls).toHaveLength(3);
  });

  it('retries a lost 5xx for an idempotent call', async () => {
    const transport = transportOf((_req, n) =>
      n === 0 ? { status: 503, data: '' } : { data: { result: { ok: true } } },
    );
    vi.useFakeTimers();
    try {
      const pending = clientOf(transport).call('campaigns', 'update', {}, okSchema);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    expect(transport.calls).toHaveLength(2);
  });

  it('never replays a nonIdempotent call whose response was lost', async () => {
    const transport = transportOf([{ status: 503, data: '' }]);
    vi.useFakeTimers();
    try {
      const pending = clientOf(transport).call('campaigns', 'add', {}, okSchema, {
        nonIdempotent: true,
      });
      const assertion = expect(pending).rejects.toThrow(/HTTP 503/);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    // Ровно один POST: у Campaigns.add нет ключа идемпотентности, и повтор
    // потерянного ответа означает вторую кампанию, а не вторую попытку.
    expect(transport.calls).toHaveLength(1);
  });

  it('still retries a nonIdempotent call that Direct rejected on the doorstep', async () => {
    const transport = transportOf((_req, n) =>
      n === 0
        ? { data: { error: { error_code: 52, error_string: 'Сервер авторизации недоступен' } } }
        : { data: { result: { ok: true } } },
    );
    vi.useFakeTimers();
    try {
      const pending = clientOf(transport).call('campaigns', 'add', {}, okSchema, {
        nonIdempotent: true,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    expect(transport.calls).toHaveLength(2);
  });

  it('rejects a response whose shape does not match the schema', async () => {
    const transport = transportOf([{ data: { result: { Campaigns: 'not-an-array' } } }]);
    const schema = z.object({ result: z.object({ Campaigns: z.array(z.number()) }) });
    await expect(clientOf(transport).call('campaigns', 'get', {}, schema)).rejects.toThrow(
      /Unexpected Yandex response shape/,
    );
  });
});

// ── Заголовки и телеметрия ───────────────────────────────────────────────────

describe('request shape', () => {
  it('sends the documented v5 envelope and auth headers', async () => {
    const transport = transportOf([{}]);
    await clientOf(transport).call('campaigns', 'get', { FieldNames: ['Id'] }, okSchema);

    const [req] = transport.calls;
    expect(req?.url).toBe('https://api-sandbox.direct.yandex.com/json/v5/campaigns');
    expect(req?.body).toEqual({ method: 'get', params: { FieldNames: ['Id'] } });
    expect(req?.headers['Authorization']).toBe('Bearer token-abc');
    expect(req?.headers['Accept-Language']).toBe('ru');
    // Прямой (не агентский) токен: агентских заголовков быть не должно.
    expect(req?.headers['Client-Login']).toBeUndefined();
    expect(req?.headers['Use-Operator-Units']).toBeUndefined();
  });

  it('adds the agency headers when a client login is configured', async () => {
    const transport = transportOf([{}]);
    const http = clientOf(transport, {
      credentials: { accessToken: 't', clientLogin: 'client-login', useOperatorUnits: true },
    });
    await http.call('campaigns', 'get', {}, okSchema);

    expect(transport.calls[0]?.headers['Client-Login']).toBe('client-login');
    expect(transport.calls[0]?.headers['Use-Operator-Units']).toBe('true');
  });

  it('surfaces the RequestId header for support tickets', async () => {
    const transport = transportOf([{ headers: { requestid: 'abc-123', units: '1/2/3' } }]);
    const res = await clientOf(transport).raw('campaigns', {}, { label: 'campaigns.get' });
    expect(res.requestId).toBe('abc-123');
  });
});

describe('concurrency', () => {
  it('never issues more than five simultaneous requests per advertiser', async () => {
    let inFlight = 0;
    let peak = 0;
    const transport = (async (): Promise<HttpResponse> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { status: 200, headers: {}, data: { result: {} } };
    }) as unknown as FakeTransport;

    const http = clientOf(transport);
    await Promise.all(
      Array.from({ length: 20 }, () => http.call('campaigns', 'get', {}, okSchema)),
    );

    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    expect(peak).toBeGreaterThan(1);
  });
});
