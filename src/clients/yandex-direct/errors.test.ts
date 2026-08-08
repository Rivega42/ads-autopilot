import { describe, expect, it } from 'vitest';

import {
  classifyErrorCode,
  extractErrorBody,
  mapHttpStatus,
  mapYandexError,
  OUT_OF_UNITS_DEFER_MS,
  RETRY_SOON_DELAY_MS,
  shouldRetryYandex,
  YandexErrorCode,
} from '@/clients/yandex-direct/errors.js';
import { AuthError, ChannelError, OutOfUnitsError, RateLimitError } from '@/lib/errors.js';

describe('classifyErrorCode', () => {
  it('treats 152 as running out of units', () => {
    expect(classifyErrorCode(YandexErrorCode.NOT_ENOUGH_UNITS)).toBe('out-of-units');
  });

  it('treats 53 as an authentication failure', () => {
    expect(classifyErrorCode(YandexErrorCode.INVALID_TOKEN)).toBe('auth');
  });

  it('treats 52 as a transient OAuth-server outage', () => {
    expect(classifyErrorCode(YandexErrorCode.AUTH_SERVER_UNAVAILABLE)).toBe('retry-soon');
  });

  it('treats 506 as a connection-limit breach', () => {
    expect(classifyErrorCode(YandexErrorCode.TOO_MANY_CONNECTIONS)).toBe('rate-limit');
  });

  it('treats the 1000 family as retryable server errors', () => {
    expect(classifyErrorCode(1000)).toBe('retry-backoff');
    expect(classifyErrorCode(1020)).toBe('retry-backoff');
  });

  it('treats permission codes as auth failures', () => {
    expect(classifyErrorCode(54)).toBe('auth');
    expect(classifyErrorCode(3000)).toBe('auth');
  });

  it('falls back to fatal for unknown codes', () => {
    expect(classifyErrorCode(8888)).toBe('fatal');
  });
});

describe('mapYandexError', () => {
  it('maps 152 to OutOfUnitsError deferred by an hour and never retried inline', () => {
    const err = mapYandexError({ error_code: 152, error_string: 'Недостаточно баллов' });
    expect(err).toBeInstanceOf(OutOfUnitsError);
    expect(err.retryAfterMs).toBe(OUT_OF_UNITS_DEFER_MS);
    expect(shouldRetryYandex(err)).toBe(false);
  });

  it('maps 53 to AuthError and does not retry', () => {
    const err = mapYandexError({ error_code: 53, error_string: 'Ошибка авторизации' });
    expect(err).toBeInstanceOf(AuthError);
    expect(err.retryable).toBe(false);
    expect(shouldRetryYandex(err)).toBe(false);
  });

  it('maps 52 to a retryable error with a one-second hint', () => {
    const err = mapYandexError({ error_code: 52, error_string: 'Сервер авторизации недоступен' });
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(RETRY_SOON_DELAY_MS);
    expect(shouldRetryYandex(err)).toBe(true);
  });

  it('maps 506 to RateLimitError', () => {
    expect(mapYandexError({ error_code: 506 })).toBeInstanceOf(RateLimitError);
  });

  it('carries error_code, error_string and error_detail into the context', () => {
    const err = mapYandexError(
      { error_code: 8888, error_string: 'Bad request', error_detail: 'Field X is required' },
      { service: 'campaigns', method: 'update', requestId: 'req-1' },
    );
    expect(err.context).toMatchObject({
      error_code: 8888,
      error_string: 'Bad request',
      error_detail: 'Field X is required',
      requestId: 'req-1',
    });
    expect(err.retryable).toBe(false);
  });
});

describe('mapHttpStatus', () => {
  it('maps HTTP 401 to AuthError', () => {
    const err = mapHttpStatus(401, '<html>unauthorized</html>');
    expect(err).toBeInstanceOf(AuthError);
    expect(err.retryable).toBe(false);
  });

  it('maps HTTP 5xx to a retryable error with exponential backoff (no fixed hint)', () => {
    const err = mapHttpStatus(503, '');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.code).toBe('YANDEX_HTTP_5XX');
  });

  it('prefers a parsable error body over the HTTP code', () => {
    const err = mapHttpStatus(400, { error: { error_code: 152, error_string: 'no units' } });
    expect(err).toBeInstanceOf(OutOfUnitsError);
  });

  it('maps a plain HTTP 400 to a non-retryable error', () => {
    expect(mapHttpStatus(400, 'nonsense').retryable).toBe(false);
  });
});

describe('extractErrorBody', () => {
  it('reads the wrapped shape', () => {
    expect(extractErrorBody({ error: { error_code: 53, error_string: 'x' } })).toEqual({
      error_code: 53,
      error_string: 'x',
    });
  });

  it('accepts a numeric string code', () => {
    expect(extractErrorBody({ error: { error_code: '152' } })).toEqual({ error_code: 152 });
  });

  it('returns null for successful payloads', () => {
    expect(extractErrorBody({ result: { Campaigns: [] } })).toBeNull();
    expect(extractErrorBody('plain text')).toBeNull();
    expect(extractErrorBody(null)).toBeNull();
  });
});
