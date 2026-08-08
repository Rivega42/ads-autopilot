import { describe, expect, it, vi } from 'vitest';

import { YandexDirectClient, maskToken } from './client.js';
import { AuthError, RateLimitError, UnitsExhaustedError, YandexDirectError } from './errors.js';
import { buildCodeAuthUrl, buildImplicitAuthUrl } from './oauth.js';

interface MockResponseInit {
  readonly body: unknown;
  readonly status?: number;
  readonly units?: string;
  readonly requestId?: string;
}

function mockResponse({ body, status = 200, units, requestId }: MockResponseInit): Response {
  const headers = new Headers();
  if (units !== undefined) headers.set('Units', units);
  if (requestId !== undefined) headers.set('RequestId', requestId);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
  } as Response;
}

function makeClient(fetchImpl: typeof fetch, maxRetries = 3): YandexDirectClient {
  return new YandexDirectClient({
    token: 'test-token-abcd',
    sandbox: true,
    fetchImpl,
    maxRetries,
    sleep: async () => undefined,
  });
}

describe('YandexDirectClient', () => {
  it('отправляет запрос в песочницу с корректными заголовками и телом', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { result: { AddResults: [{ Id: 1 }] } } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const result = await client.request<{ AddResults: { Id: number }[] }>('campaigns', 'add', {
      Campaigns: [],
    });

    expect(result.AddResults[0]?.Id).toBe(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api-sandbox.direct.yandex.com/json/v5/campaigns');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token-abcd');
    expect(init.body).toBe(JSON.stringify({ method: 'add', params: { Campaigns: [] } }));
  });

  it('добавляет Client-Login только когда он задан', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: { result: {} } }));

    await new YandexDirectClient({
      token: 't',
      sandbox: true,
      clientLogin: 'smartsay-login',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).request('campaigns', 'get', {});

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Client-Login']).toBe('smartsay-login');
  });

  it('разбирает заголовок Units и RequestId', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { result: {} }, units: '20/19980/64000', requestId: 'abc123' }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.request('campaigns', 'get', {});

    expect(client.units).toEqual({ spent: 20, rest: 19980, limit: 64000 });
    expect(client.requestId).toBe('abc123');
  });

  it('не падает, когда Units отсутствует или битый', async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: { result: {} }, units: 'garbage' }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await client.request('campaigns', 'get', {});

    expect(client.units).toBeNull();
  });

  it('превращает ошибку в теле ответа в исключение, несмотря на HTTP 200', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: { error: { error_code: 54, error_string: 'Нет прав', error_detail: 'детали' } },
      }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('campaigns', 'add', {})).rejects.toBeInstanceOf(YandexDirectError);
  });

  it('распознаёт исчерпание баллов и не ретраит его', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { error: { error_code: 152, error_string: 'Баллы закончились' } } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('campaigns', 'add', {})).rejects.toBeInstanceOf(
      UnitsExhaustedError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('распознаёт протухший токен и не ретраит его', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { error: { error_code: 53, error_string: 'Нет авторизации' } } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('campaigns', 'get', {})).rejects.toBeInstanceOf(AuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ретраит превышение частоты и возвращает результат последней попытки', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({ body: { error: { error_code: 56, error_string: 'Слишком часто' } } }),
      )
      .mockResolvedValueOnce(mockResponse({ body: { result: { ok: true } } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('campaigns', 'get', {})).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('сдаётся после исчерпания попыток', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: { error: { error_code: 56, error_string: 'Слишком часто' } } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch, 2);

    await expect(client.request('campaigns', 'get', {})).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('ретраит временные HTTP-ошибки Директа', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ body: {}, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ body: { result: { ok: true } } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.request('campaigns', 'get', {})).resolves.toEqual({ ok: true });
  });

  it('не даёт создать клиент без токена', () => {
    expect(() => new YandexDirectClient({ token: '  ' })).toThrow(/пустой OAuth-токен/);
  });

  it('по умолчанию работает с боевым API', () => {
    expect(new YandexDirectClient({ token: 't' }).isSandbox).toBe(false);
    expect(new YandexDirectClient({ token: 't', sandbox: true }).isSandbox).toBe(true);
  });
});

describe('maskToken', () => {
  it('оставляет только последние 4 символа', () => {
    expect(maskToken('y0_AgAAAABsecret1234')).toBe('***1234');
  });
});

describe('OAuth URL', () => {
  it('неявный поток не требует секрета', () => {
    const url = buildImplicitAuthUrl('client-id-123');

    expect(url).toContain('response_type=token');
    expect(url).toContain('client_id=client-id-123');
    expect(url).toContain('verification_code');
    expect(url).not.toContain('secret');
  });

  it('поток с кодом прокидывает state', () => {
    expect(buildCodeAuthUrl('id', 'st4te')).toContain('state=st4te');
  });
});
