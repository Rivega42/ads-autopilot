import type { Channel } from '@prisma/client';

/** Базовая ошибка домена: несёт контекст, который нужен для лога и алерта. */
export class AppError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;
  /** true — имеет смысл повторить операцию позже. */
  readonly retryable: boolean;
  /** Задержка до следующей попытки, мс. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      code?: string;
      context?: Record<string, unknown>;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code ?? 'APP_ERROR';
    this.context = opts.context ?? {};
    this.retryable = opts.retryable ?? false;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Ошибка на стороне рекламной площадки. */
export class ChannelError extends AppError {
  readonly channel: Channel;

  constructor(
    channel: Channel,
    message: string,
    opts: ConstructorParameters<typeof AppError>[1] = {},
  ) {
    super(message, opts);
    this.channel = channel;
  }
}

/** Кончились units Яндекс Директа (error_code 52) — задачу надо отложить, а не ретраить. */
export class OutOfUnitsError extends ChannelError {
  constructor(channel: Channel, retryAfterMs = 60 * 60 * 1000, context = {}) {
    super(channel, 'Out of API units', {
      code: 'OUT_OF_UNITS',
      retryable: true,
      retryAfterMs,
      context,
    });
  }
}

/** Токен протух или отозван — ретрай бесполезен, нужен алерт человеку. */
export class AuthError extends ChannelError {
  constructor(channel: Channel, message = 'Authentication failed', context = {}) {
    super(channel, message, { code: 'AUTH_FAILED', retryable: false, context });
  }
}

/** Превышен лимит запросов. */
export class RateLimitError extends ChannelError {
  constructor(channel: Channel, retryAfterMs: number, context = {}) {
    super(channel, 'Rate limited', {
      code: 'RATE_LIMIT',
      retryable: true,
      retryAfterMs,
      context,
    });
  }
}

/** Операция заблокирована предохранителем оптимизатора (см. src/optimizer/guardrails.ts). */
export class GuardrailError extends AppError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, { code: 'GUARDRAIL', retryable: false, context });
  }
}

export function isRetryable(err: unknown): err is AppError {
  return err instanceof AppError && err.retryable;
}

/** Приводит произвольный throw к строке, не теряя причину. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : '';
    return `${err.name}: ${err.message}${cause}`;
  }
  return String(err);
}
