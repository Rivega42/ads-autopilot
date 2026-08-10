import type { ImageFormatName, GenerationSizeLimits } from './formats.js';

import { AppError } from '@/lib/errors.js';

/**
 * Контракт генератора изображений.
 *
 * Смысл абстракции тот же, что у `LlmProvider`: для РФ-кабинетов это Kandinsky
 * (FusionBrain) или YandexART, для международных — DALL·E, и модуль креативов не
 * должен знать, у кого результат приходит base64-строкой, а у кого ссылкой.
 *
 * Ключевое отличие от LLM: каждый вызов стоит денег и не идемпотентен. Отсюда два
 * правила для реализаций, которые нельзя нарушать:
 *  • платный запрос не ретраится вслепую — ретраить можно только бесплатные опросы
 *    статуса уже начатой генерации;
 *  • провайдер обязан честно сообщать свои ограничения по размеру (`sizeLimits`),
 *    чтобы вызывающий код не платил за картинку, которую площадка не примет.
 */

export interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  format: ImageFormatName;
  /** Стиль провайдера, если он его поддерживает. */
  style?: string;
  /** Разводит варианты одного промпта. Без него провайдер вернёт похожие картинки. */
  seed?: number;
}

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  model: string;
  /** Провайдер счёл результат нежелательным контентом и вернул заглушку. */
  censored: boolean;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  readonly sizeLimits: GenerationSizeLimits;
  /** Есть ли ключи. Проверяется в момент вызова: .env может подгрузиться позже. */
  isConfigured(): boolean;
  generate(req: ImageGenerationRequest, opts?: { signal?: AbortSignal }): Promise<GeneratedImage>;
}

export class ImageProviderError extends AppError {
  constructor(
    provider: string,
    message: string,
    opts: { context?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(`${provider}: ${message}`, {
      code: 'IMAGE_PROVIDER_ERROR',
      context: { provider, ...opts.context },
      retryable: opts.retryable ?? false,
      cause: opts.cause,
    });
  }
}

export class ImageProviderNotConfiguredError extends AppError {
  constructor(provider: string, missing: string[]) {
    super(`Image provider ${provider} is not configured`, {
      code: 'IMAGE_PROVIDER_NOT_CONFIGURED',
      context: { provider, missing },
    });
  }
}

/**
 * Генерация началась, но результат не забрали.
 *
 * Отдельный класс, потому что это единственная ситуация, в которой деньги уже
 * списаны, а картинки нет: задача у провайдера создана и `taskId` известен.
 * Повторять генерацию по этой ошибке нельзя — можно только дозабрать по id.
 */
export class ImageGenerationTimeoutError extends AppError {
  constructor(provider: string, taskId: string, waitedMs: number) {
    super(`${provider}: generation ${taskId} did not finish in ${waitedMs}ms`, {
      code: 'IMAGE_GENERATION_TIMEOUT',
      context: { provider, taskId, waitedMs },
      retryable: false,
    });
  }
}

/** Куда заливать готовую картинку. Реализация живёт в адаптере канала, не здесь. */
export interface ImageUploader {
  readonly channel: string;
  upload(image: GeneratedImage, filename: string): Promise<{ mediaId: string }>;
}
