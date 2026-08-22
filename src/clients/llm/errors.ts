import { AppError } from '@/lib/errors.js';

/**
 * Провайдер не сконфигурирован (нет ключа в .env).
 *
 * Отдельный тип нужен, чтобы вызывающий код мог отличить «мы не умеем это
 * посчитать» от «сервис прилёг». Ретраить бессмысленно, тихо подменять
 * провайдера — нельзя: клиент платит за конкретную модель и должен узнать,
 * что задача не выполнена, а не получить ответ от другой модели.
 */
export class LlmConfigError extends AppError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, { code: 'LLM_NOT_CONFIGURED', retryable: false, context });
  }
}

/** Ошибка транспорта или самого API модели. Ретраибельность решает маппер провайдера. */
export class LlmApiError extends AppError {
  constructor(
    message: string,
    opts: {
      provider: string;
      model: string;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, {
      code: 'LLM_API',
      retryable: opts.retryable ?? false,
      retryAfterMs: opts.retryAfterMs,
      cause: opts.cause,
      context: { provider: opts.provider, model: opts.model, status: opts.status },
    });
  }
}

/**
 * Модель не смогла выдать объект нужной формы за отведённое число попыток.
 * Не ретраибельна на уровне withRetry: повтор с тем же промптом даст то же самое,
 * чинить надо промпт или схему.
 */
export class LlmSchemaError extends AppError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(message, { code: 'LLM_SCHEMA', retryable: false, context });
  }
}

/** Исчерпан месячный бюджет клиента на LLM. Задачу надо не ретраить, а показать человеку. */
export class LlmBudgetError extends AppError {
  constructor(
    message: string,
    context: { clientId: string; spentUsd: number; limitUsd: number } & Record<string, unknown>,
  ) {
    super(message, { code: 'LLM_BUDGET_EXCEEDED', retryable: false, context });
  }
}
