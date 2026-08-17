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

/** 53 — токен невалиден или отозван. 54 — нет доступа к API. 58 — заявка приложения не одобрена. */
const AUTH_CODES = new Set([53, 54, 58]);

/** Понятная подсказка вместо формулировок Директа: чинится это по-разному. */
export function explainAuthError(code: number): string {
  switch (code) {
    case 53:
      return 'Токен невалиден или отозван. Получи новый через OAuth.';
    case 54:
      return 'У аккаунта нет доступа к API Директа. Включается в интерфейсе Директа.';
    case 58:
      return 'Приложению не одобрен доступ к API. Директ → Настройки → API → заявка на доступ, дальше ждать подтверждения Яндекса.';
    default:
      return 'Проблема с авторизацией в Директе.';
  }
}

export function toDirectError(payload: DirectErrorPayload): YandexDirectError {
  if (payload.error_code === UNITS_EXHAUSTED) return new UnitsExhaustedError(payload);
  if (payload.error_code === RATE_LIMITED) return new RateLimitError(payload);
  if (AUTH_CODES.has(payload.error_code)) return new AuthError(payload);
  return new YandexDirectError(payload);
}

export function isRetryable(error: unknown): boolean {
  return error instanceof RateLimitError;
}
