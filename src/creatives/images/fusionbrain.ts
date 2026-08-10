import { z } from 'zod';

import { fitGenerationSize, IMAGE_FORMATS, type GenerationSizeLimits } from './formats.js';
import {
  ImageGenerationTimeoutError,
  ImageProviderError,
  ImageProviderNotConfiguredError,
  type GeneratedImage,
  type ImageGenerationRequest,
  type ImageProvider,
} from './provider.js';

import { env } from '@/env.js';
import { sleep } from '@/lib/retry.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'creatives:fusionbrain' });

/**
 * Kandinsky через FusionBrain API — генератор изображений для РФ-кабинетов (TZ §13.3).
 *
 * Контракт проверен по документации fusionbrain.ai и по эталонной реализации Сбера
 * (ai-forever/giga_agent), обе сверены 2026-08-10. Живого ключа при написании не было,
 * поэтому места, где документация допускает разночтения, помечены `@needs-live-token`.
 *
 * Схема работы асинхронная и это принципиально для денег:
 *   POST /key/api/v1/pipeline/run        → uuid задачи   ← ПЛАТНЫЙ шаг
 *   GET  /key/api/v1/pipeline/status/id  → результат     ← бесплатный опрос
 * Ретраить можно только второй шаг. Повтор первого при сетевой ошибке — это вторая
 * оплаченная генерация за ту же картинку, причём первая, возможно, уже выполняется.
 */

export const FUSIONBRAIN_PROVIDER = 'fusionbrain';
export const FUSIONBRAIN_MODEL = 'kandinsky-3.1';

/**
 * Ограничения генератора: не больше 1024 по стороне, размеры кратны 64.
 * Отсюда следует неприятное для ТЗ: 1200×628 и 1080×1080 напрямую не получить,
 * `fitGenerationSize` подбирает ближайший допустимый размер и помечает,
 * что картинку придётся увеличивать.
 */
export const FUSIONBRAIN_SIZE_LIMITS: GenerationSizeLimits = { maxSide: 1024, step: 64 };

const DEFAULT_BASE_URL = 'https://api-key.fusionbrain.ai/';
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_ATTEMPTS = 40;
/** Лимит длины запроса из документации. */
export const FUSIONBRAIN_PROMPT_MAX = 1_000;

const pipelinesSchema = z
  .array(
    z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        name: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  )
  .min(1);

const runSchema = z
  .object({
    uuid: z.string().min(1),
    status: z.string().optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    status: z.string(),
    errorDescription: z.string().nullish(),
    result: z
      .object({
        files: z.array(z.string()).default([]),
        censored: z.boolean().default(false),
      })
      .nullish(),
  })
  .passthrough();

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FusionBrainDeps {
  apiKey?: string;
  secretKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  pollIntervalMs?: number;
  pollAttempts?: number;
  /** Подменяется в тестах, чтобы не ждать реального опроса. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class FusionBrainProvider implements ImageProvider {
  readonly name = FUSIONBRAIN_PROVIDER;
  readonly model = FUSIONBRAIN_MODEL;
  readonly sizeLimits = FUSIONBRAIN_SIZE_LIMITS;

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly pollIntervalMs: number;
  private readonly pollAttempts: number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private pipelineIdCache: string | null = null;

  constructor(private readonly deps: FusionBrainDeps = {}) {
    this.baseUrl = (deps.baseUrl ?? DEFAULT_BASE_URL).replace(/\/*$/u, '/');
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollAttempts = deps.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    this.sleepImpl = deps.sleep ?? sleep;
  }

  isConfigured(): boolean {
    return this.missingKeys().length === 0;
  }

  async generate(
    req: ImageGenerationRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<GeneratedImage> {
    const missing = this.missingKeys();
    if (missing.length > 0) throw new ImageProviderNotConfiguredError(this.name, missing);

    const size = fitGenerationSize(IMAGE_FORMATS[req.format], this.sizeLimits);
    const pipelineId = await this.pipelineId(opts.signal);
    const uuid = await this.startGeneration(pipelineId, req, size, opts.signal);
    const files = await this.awaitResult(uuid, opts.signal);

    const first = files.images[0];
    if (first === undefined) {
      throw new ImageProviderError(this.name, 'generation finished with no image', {
        context: { uuid },
      });
    }

    const data = await this.decodeFile(first, opts.signal);
    return {
      data,
      mimeType: sniffMimeType(data),
      width: size.width,
      height: size.height,
      provider: this.name,
      model: this.model,
      censored: files.censored,
    };
  }

  private missingKeys(): string[] {
    const missing: string[] = [];
    if (!(this.deps.apiKey ?? env.KANDINSKY_API_KEY)) missing.push('KANDINSKY_API_KEY');
    if (!(this.deps.secretKey ?? env.KANDINSKY_SECRET_KEY)) missing.push('KANDINSKY_SECRET_KEY');
    return missing;
  }

  private headers(): Record<string, string> {
    return {
      'X-Key': `Key ${this.deps.apiKey ?? env.KANDINSKY_API_KEY ?? ''}`,
      'X-Secret': `Secret ${this.deps.secretKey ?? env.KANDINSKY_SECRET_KEY ?? ''}`,
    };
  }

  /** Список доступных пайплайнов. Бесплатный GET, поэтому кешируется на инстанс. */
  private async pipelineId(signal?: AbortSignal): Promise<string> {
    if (this.pipelineIdCache !== null) return this.pipelineIdCache;

    const res = await this.call('key/api/v1/pipelines', { method: 'GET', signal });
    const parsed = pipelinesSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ImageProviderError(this.name, 'unexpected /pipelines response', {
        context: { issues: parsed.error.issues.map((i) => i.message) },
      });
    }
    const first = parsed.data[0];
    if (first === undefined) {
      throw new ImageProviderError(this.name, 'no pipelines available for this key');
    }
    this.pipelineIdCache = first.id;
    return first.id;
  }

  /**
   * Платный шаг. Без ретраев: ошибка сети после отправки не означает, что задача
   * не создана, и вторая попытка легко превращается в две оплаченные генерации.
   *
   * @needs-live-token: часть ключей возвращает 415, если `params` уходит без
   * `Content-Type: application/json`. Отправляем его Blob'ом с явным типом — на живом
   * кабинете проверить, что multipart собирается именно так.
   */
  private async startGeneration(
    pipelineId: string,
    req: ImageGenerationRequest,
    size: { width: number; height: number },
    signal?: AbortSignal,
  ): Promise<string> {
    const params: Record<string, unknown> = {
      type: 'GENERATE',
      numImages: 1,
      width: size.width,
      height: size.height,
      generateParams: { query: req.prompt.slice(0, FUSIONBRAIN_PROMPT_MAX) },
    };
    if (req.style) params.style = req.style;
    if (req.negativePrompt) params.negativePromptDecoder = req.negativePrompt;

    const form = new FormData();
    form.append('pipeline_id', pipelineId);
    form.append('params', new Blob([JSON.stringify(params)], { type: 'application/json' }));

    const res = await this.call('key/api/v1/pipeline/run', { method: 'POST', body: form, signal });
    const parsed = runSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ImageProviderError(this.name, 'unexpected /pipeline/run response', {
        context: { issues: parsed.error.issues.map((i) => i.message) },
      });
    }

    log.info({ uuid: parsed.data.uuid, ...size }, 'fusionbrain generation started');
    return parsed.data.uuid;
  }

  /** Бесплатный опрос: здесь ретраи законны и нужны. */
  private async awaitResult(
    uuid: string,
    signal?: AbortSignal,
  ): Promise<{ images: string[]; censored: boolean }> {
    for (let attempt = 1; attempt <= this.pollAttempts; attempt += 1) {
      const res = await this.call(`key/api/v1/pipeline/status/${uuid}`, { method: 'GET', signal });
      const parsed = statusSchema.safeParse(await res.json());
      if (!parsed.success) {
        throw new ImageProviderError(this.name, 'unexpected /pipeline/status response', {
          context: { uuid, issues: parsed.error.issues.map((i) => i.message) },
        });
      }

      const { status, result, errorDescription } = parsed.data;
      if (status === 'DONE') {
        return { images: result?.files ?? [], censored: result?.censored ?? false };
      }
      if (status === 'FAIL' || status === 'DISABLED_BY_QUEUE') {
        throw new ImageProviderError(
          this.name,
          `generation failed: ${errorDescription ?? status}`,
          {
            context: { uuid, status },
          },
        );
      }

      if (attempt < this.pollAttempts) await this.sleepImpl(this.pollIntervalMs, signal);
    }

    throw new ImageGenerationTimeoutError(this.name, uuid, this.pollAttempts * this.pollIntervalMs);
  }

  /**
   * Документация обещает base64 в `result.files`, но часть реализаций получает там
   * ссылку. Поддерживаем оба варианта: скачивание по ссылке бесплатно, а падать
   * после оплаченной генерации из-за формата поля — самое дорогое, что можно сделать.
   */
  private async decodeFile(file: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (/^https?:\/\//iu.test(file)) {
      const res = await this.fetchImpl(file, signal ? { signal } : {});
      if (!res.ok) {
        throw new ImageProviderError(this.name, `cannot download result: HTTP ${res.status}`, {
          context: { url: file },
        });
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    return new Uint8Array(Buffer.from(file, 'base64'));
  }

  private async call(
    path: string,
    init: RequestInit & { signal?: AbortSignal },
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, { ...init, headers: this.headers() });
    if (!res.ok) {
      throw new ImageProviderError(this.name, `HTTP ${res.status} on ${path}`, {
        context: { status: res.status, path, body: await safeText(res) },
        // 429 и 5xx повторить можно, но решает это вызывающий, и только для GET.
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return res;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/**
 * Тип картинки по сигнатуре, а не по заголовку ответа: файл приходит base64-строкой,
 * заголовка у неё нет, а площадке нужен корректный Content-Type при заливке.
 */
export function sniffMimeType(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/** Провайдер по умолчанию для РФ-кабинетов. */
export function createFusionBrainProvider(deps: FusionBrainDeps = {}): ImageProvider {
  return new FusionBrainProvider(deps);
}
