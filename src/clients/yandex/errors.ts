import type { Channel } from '@prisma/client';
import { AppError, AuthError, ChannelError, OutOfUnitsError, RateLimitError } from '@/lib/errors.js';

/**
 * Классификация ошибок Яндекс Директа API v5.
 *
 * ⚠️ Расхождение с ТЗ §2.1 / PLAN 01.3 — намеренное.
 * ТЗ утверждает «52 → нет баллов, 53 → ретрай, 152 → лог+skip». Официальный
 * справочник (yandex.ru/dev/direct/doc/ru/concepts/errors-list, снят 2026-08-08,
 * копия в research-артефактах) говорит ровно наоборот:
 *   • 52  — «Сервер авторизации временно недоступен» (серверная ошибка, ретраить);
 *   • 53  — «Ошибка авторизации», недействительный OAuth-токен (ретрай бесполезен);
 *   • 152 — «Недостаточно баллов» (те самые units).
 * Реализуем документированную семантику: если следовать ТЗ буквально, клиент будет
 * трижды долбиться в протухший токен (60 баллов в мусор) и «логировать и пропускать»
 * исчерпание квоты — то есть молча терять записи вместо того, чтобы отложить задачу.
 * Требуемые ТЗ *поведения* при этом все реализованы, просто привязаны к верным кодам.
 */

export const YANDEX_CHANNEL = 'YANDEX_DIRECT' satisfies Channel;

/** Коды, которые встречаются в обработке. Полный список — в документации. */
export const YandexErrorCode = {
  /** Сервер Яндекс.OAuth временно недоступен — повторить через секунду. */
  AUTH_SERVER_UNAVAILABLE: 52,
  /** Недействительный OAuth-токен. */
  INVALID_TOKEN: 53,
  /** Нет прав на аккаунт (не клиент агентства / только чтение / нет валюты). */
  NO_RIGHTS: 54,
  /** Незавершённая регистрация приложения — нужна заявка на доступ к API. */
  INCOMPLETE_REGISTRATION: 58,
  /** Недостаточно баллов (units). Именно этот код блокирует аккаунт до пополнения квоты. */
  NOT_ENOUGH_UNITS: 152,
  /** Логин не подключён к Директу. */
  LOGIN_NOT_IN_DIRECT: 513,
  /** Превышено ограничение на количество одновременных соединений. */
  TOO_MANY_CONNECTIONS: 506,
  /** Внутренняя ошибка сервера API. */
  INTERNAL_SERVER_ERROR: 1000,
  /** Нет доступа к API у пользователя. */
  NO_API_ACCESS: 3000,
  /** Нет доступа к конкретному методу. */
  NO_METHOD_ACCESS: 3001,
} as const;

export type YandexErrorBehaviour =
  /** Кончились баллы: откладываем задачу примерно на час, ретраить нельзя. */
  | 'out-of-units'
  /** Проблема с токеном или правами: нужен человек, ретрай бесполезен. */
  | 'auth'
  /** Слишком много соединений: подождать и повторить. */
  | 'rate-limit'
  /** Кратковременный сбой: повторить через секунду, максимум 3 попытки. */
  | 'retry-soon'
  /** Серверная ошибка: экспоненциальный backoff. */
  | 'retry-backoff'
  /** Ошибка операции над одним объектом: залогировать и пропустить объект. */
  | 'skip'
  /** Наша вина (кривой запрос, неверные поля) — ретрай ничего не изменит. */
  | 'fatal';

/** Сколько раз повторять «быстрые» ошибки. Каждая ошибка стоит 20 баллов, больше нельзя. */
export const RETRY_SOON_ATTEMPTS = 3;
export const RETRY_SOON_DELAY_MS = 1_000;
/** Кончились баллы — квота восстанавливается порциями по 1/24 в час, раньше смысла нет. */
export const OUT_OF_UNITS_DEFER_MS = 60 * 60 * 1000;

const AUTH_CODES = new Set<number>([
  YandexErrorCode.INVALID_TOKEN,
  YandexErrorCode.NO_RIGHTS,
  YandexErrorCode.INCOMPLETE_REGISTRATION,
  YandexErrorCode.LOGIN_NOT_IN_DIRECT,
  YandexErrorCode.NO_API_ACCESS,
  YandexErrorCode.NO_METHOD_ACCESS,
]);

/** 1000-1099 и 1020 — семейство «внутренняя ошибка сервера Директа». */
function isServerCode(code: number): boolean {
  return code >= 1000 && code < 1100;
}

export function classifyErrorCode(code: number): YandexErrorBehaviour {
  if (code === YandexErrorCode.NOT_ENOUGH_UNITS) return 'out-of-units';
  if (code === YandexErrorCode.AUTH_SERVER_UNAVAILABLE) return 'retry-soon';
  if (code === YandexErrorCode.TOO_MANY_CONNECTIONS) return 'rate-limit';
  if (AUTH_CODES.has(code)) return 'auth';
  if (isServerCode(code)) return 'retry-backoff';
  return 'fatal';
}

/** Тело ошибки уровня запроса — одинаковое у v5 и у сервиса Reports. */
export interface YandexErrorBody {
  error_code: number;
  error_string?: string;
  error_detail?: string;
  request_id?: string;
}

export interface YandexErrorMeta {
  service?: string;
  method?: string;
  clientId?: string;
  requestId?: string;
  httpStatus?: number;
}

/** Достаёт `{ error: {...} }` из произвольного тела ответа, не доверяя форме. */
export function extractErrorBody(data: unknown): YandexErrorBody | null {
  if (typeof data !== 'object' || data === null) return null;
  const wrapper = (data as { error?: unknown }).error;
  const raw = typeof wrapper === 'object' && wrapper !== null ? wrapper : data;
  const code = (raw as { error_code?: unknown }).error_code;
  const numeric = typeof code === 'number' ? code : typeof code === 'string' ? Number(code) : NaN;
  if (!Number.isFinite(numeric)) return null;

  const body: YandexErrorBody = { error_code: numeric };
  const str = (raw as { error_string?: unknown }).error_string;
  const detail = (raw as { error_detail?: unknown }).error_detail;
  const reqId = (raw as { request_id?: unknown }).request_id;
  if (typeof str === 'string') body.error_string = str;
  if (typeof detail === 'string') body.error_detail = detail;
  if (typeof reqId === 'string') body.request_id = reqId;
  return body;
}

/**
 * Превращает ошибку уровня запроса в доменную. Контекст сохраняем целиком:
 * поддержка Яндекса первым делом спрашивает RequestId, без него тикет закроют.
 */
export function mapYandexError(body: YandexErrorBody, meta: YandexErrorMeta = {}): ChannelError {
  const behaviour = classifyErrorCode(body.error_code);
  const context: Record<string, unknown> = {
    ...meta,
    error_code: body.error_code,
    error_string: body.error_string,
    error_detail: body.error_detail,
    requestId: meta.requestId ?? body.request_id,
  };
  const message = `Yandex Direct error ${body.error_code}: ${body.error_string ?? 'unknown'}`;

  switch (behaviour) {
    case 'out-of-units':
      return new OutOfUnitsError(YANDEX_CHANNEL, OUT_OF_UNITS_DEFER_MS, context);
    case 'auth':
      return new AuthError(YANDEX_CHANNEL, message, context);
    case 'rate-limit':
      return new RateLimitError(YANDEX_CHANNEL, RETRY_SOON_DELAY_MS * 5, context);
    case 'retry-soon':
      return new ChannelError(YANDEX_CHANNEL, message, {
        code: 'YANDEX_RETRY_SOON',
        retryable: true,
        retryAfterMs: RETRY_SOON_DELAY_MS,
        context,
      });
    case 'retry-backoff':
      return new ChannelError(YANDEX_CHANNEL, message, {
        code: 'YANDEX_SERVER_ERROR',
        retryable: true,
        context,
      });
    // 'skip' до этой функции не доходит: ошибки операций разбираются в writes.ts,
    // где известно, какой именно объект пропущен.
    case 'skip':
    case 'fatal':
    default:
      return new ChannelError(YANDEX_CHANNEL, message, {
        code: 'YANDEX_API_ERROR',
        retryable: false,
        context,
      });
  }
}

/** Ошибки транспорта: HTTP-код пришёл раньше, чем тело с error_code. */
export function mapHttpStatus(
  status: number,
  data: unknown,
  meta: YandexErrorMeta = {},
): ChannelError {
  // Если Директ всё-таки прислал разбираемое тело — оно точнее кода.
  const body = extractErrorBody(data);
  if (body) return mapYandexError(body, { ...meta, httpStatus: status });

  const context: Record<string, unknown> = { ...meta, httpStatus: status };

  if (status === 401 || status === 403) {
    return new AuthError(YANDEX_CHANNEL, `Yandex Direct rejected the token (HTTP ${status})`, context);
  }
  if (status === 429) {
    return new RateLimitError(YANDEX_CHANNEL, RETRY_SOON_DELAY_MS * 5, context);
  }
  if (status >= 500) {
    return new ChannelError(YANDEX_CHANNEL, `Yandex Direct HTTP ${status}`, {
      code: 'YANDEX_HTTP_5XX',
      retryable: true,
      context,
    });
  }
  return new ChannelError(YANDEX_CHANNEL, `Yandex Direct HTTP ${status}`, {
    code: 'YANDEX_HTTP_ERROR',
    retryable: false,
    context,
  });
}

/**
 * Единственный предикат ретрая для всего клиента.
 *
 * OutOfUnitsError формально retryable (её надо повторить — но через час),
 * и наивный `withRetry` уснул бы на час прямо внутри воркера. Поэтому здесь
 * она явно исключена: наверх, планировщику, и пусть он переставит задачу.
 */
export function shouldRetryYandex(err: unknown): boolean {
  if (err instanceof OutOfUnitsError) return false;
  return err instanceof AppError && err.retryable;
}
