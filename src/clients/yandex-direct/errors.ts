/** Ошибки Yandex Direct API v5. */

export interface DirectErrorPayload {
  readonly error_code: number;
  readonly error_string: string;
  readonly error_detail?: string;
  readonly request_id?: string;
}

export class YandexDirectError extends Error {
  readonly code: number;
  readonly detail: string;
  readonly requestId: string | undefined;

  constructor(payload: DirectErrorPayload) {
    super(`[${payload.error_code}] ${payload.error_string}: ${payload.error_detail ?? ''}`.trim());
    this.name = 'YandexDirectError';
    this.code = payload.error_code;
    this.detail = payload.error_detail ?? '';
    this.requestId = payload.request_id;
  }
}

/** error_code 152 — суточный лимит баллов исчерпан, до полуночи по Москве делать нечего. */
export class UnitsExhaustedError extends YandexDirectError {
  constructor(payload: DirectErrorPayload) {
    super(payload);
    this.name = 'UnitsExhaustedError';
  }
}

/** error_code 56 — слишком частые запросы, повторяем с задержкой. */
export class RateLimitError extends YandexDirectError {
  constructor(payload: DirectErrorPayload) {
    super(payload);
    this.name = 'RateLimitError';
  }
}

/** Токен протух или отозван — ретраить бессмысленно. */
export class AuthError extends YandexDirectError {
  constructor(payload: DirectErrorPayload) {
    super(payload);
    this.name = 'AuthError';
  }
}

const UNITS_EXHAUSTED = 152;
const RATE_LIMITED = 56;
const AUTH_CODES = new Set([53, 58, 152.1, 8000]);

export function toDirectError(payload: DirectErrorPayload): YandexDirectError {
  if (payload.error_code === UNITS_EXHAUSTED) return new UnitsExhaustedError(payload);
  if (payload.error_code === RATE_LIMITED) return new RateLimitError(payload);
  if (AUTH_CODES.has(payload.error_code)) return new AuthError(payload);
  return new YandexDirectError(payload);
}

export function isRetryable(error: unknown): boolean {
  return error instanceof RateLimitError;
}
