import axios, { type AxiosRequestConfig } from 'axios';
import PQueue from 'p-queue';
import type { z } from 'zod';

import type { ChannelContext } from '@/channels/types.js';
import { getVkAccessToken, VK_CHANNEL } from '@/clients/vk/auth.js';
import { parseVkError } from '@/clients/vk/schemas.js';
import { VK_ADS_BASE_URL } from '@/constants.js';
import type { AppError} from '@/lib/errors.js';
import { AuthError, ChannelError, RateLimitError, isRetryable } from '@/lib/errors.js';
import { sleep, withRetry } from '@/lib/retry.js';
import { scoped } from '@/logger.js';

const log = scoped('vk:http');

/**
 * ВАЖНО, вопреки TZ §2.2: «5 req/sec» — это лимит старого api.vk.com/method/ads.*.
 * У ads.vk.ru лимит динамический и персональный, площадка сама сообщает его в
 * заголовках X-RateLimit-*. Поэтому мы не хардкодим частоту, а читаем её из
 * последнего ответа и строим паузу от неё. Константа ниже — только «холодный
 * старт»: чем ходить вслепую с неизвестной частотой, лучше начать осторожно
 * и разогнаться по первым же заголовкам.
 */
export const VK_COLD_START_RPS = 5;

/** Параллелизм внутри одного кабинета. Спейсинг всё равно задаёт governor. */
export const VK_DEFAULT_CONCURRENCY = 4;

/** Потолок ожидания по подсказке площадки: дольше держать воркер занятым бессмысленно. */
export const VK_MAX_BACKOFF_MS = 30_000;

/**
 * Срок годности снимка лимитов. Счётчики `*-remaining` — это состояние окна на
 * момент ответа; через минуту простоя они ничего не описывают. Без срока годности
 * один ответ с `daily-remaining: 0` навсегда парализует клиент в процессе, даже
 * когда сутки давно сменились. Сам `rpsLimit` — настройка аккаунта, он не протухает.
 */
export const VK_SNAPSHOT_TTL_MS = 60_000;

export interface RateLimitSnapshot {
  rpsLimit?: number;
  rpsRemaining?: number;
  hourlyLimit?: number;
  hourlyRemaining?: number;
  dailyLimit?: number;
  dailyRemaining?: number;
  /** Момент, когда заголовки прочитаны (ms). */
  observedAt: number;
}

function headerNumber(headers: Record<string, unknown>, name: string): number | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined || raw === null) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Возвращает null, если площадка не прислала ни одного X-RateLimit-заголовка. */
export function parseRateLimitHeaders(
  headers: Record<string, unknown> | undefined,
  now: number,
): RateLimitSnapshot | null {
  if (!headers) return null;
  const snap: RateLimitSnapshot = { observedAt: now };
  const map: Array<[keyof RateLimitSnapshot, string]> = [
    ['rpsLimit', 'x-ratelimit-rps-limit'],
    ['rpsRemaining', 'x-ratelimit-rps-remaining'],
    ['hourlyLimit', 'x-ratelimit-hourly-limit'],
    ['hourlyRemaining', 'x-ratelimit-hourly-remaining'],
    ['dailyLimit', 'x-ratelimit-daily-limit'],
    ['dailyRemaining', 'x-ratelimit-daily-remaining'],
  ];

  let seen = false;
  const writable = snap as unknown as Record<string, number>;
  for (const [key, header] of map) {
    const value = headerNumber(headers, header);
    if (value === undefined) continue;
    seen = true;
    writable[key] = value;
  }
  return seen ? snap : null;
}

export interface ThrottleInput {
  snapshot: RateLimitSnapshot | null;
  /** Когда ушёл предыдущий запрос (ms), null — запросов ещё не было. */
  lastRequestAt: number | null;
  now: number;
}

/**
 * Сколько подождать перед следующим запросом.
 *
 * Логика по убыванию жёсткости окна: исчерпанные сутки → до полуночи UTC,
 * исчерпанный час → до начала следующего часа, исчерпанная секунда → до конца
 * текущей секунды. Если запас есть — просто держим равномерный интервал
 * 1000/rps, чтобы не выбрать всю секунду одним залпом и не словить 429.
 */
export function computeThrottleDelayMs(input: ThrottleInput): number {
  const { snapshot, lastRequestAt, now } = input;

  if (snapshot && now - snapshot.observedAt <= VK_SNAPSHOT_TTL_MS) {
    if (snapshot.dailyRemaining !== undefined && snapshot.dailyRemaining <= 0) {
      return msUntilNextBoundary(now, 24 * 60 * 60 * 1000);
    }
    if (snapshot.hourlyRemaining !== undefined && snapshot.hourlyRemaining <= 0) {
      return msUntilNextBoundary(now, 60 * 60 * 1000);
    }
    if (snapshot.rpsRemaining !== undefined && snapshot.rpsRemaining <= 0) {
      return msUntilNextBoundary(now, 1000);
    }
  }

  const rps = snapshot?.rpsLimit && snapshot.rpsLimit > 0 ? snapshot.rpsLimit : VK_COLD_START_RPS;
  const spacing = Math.ceil(1000 / rps);
  if (lastRequestAt === null) return 0;
  const elapsed = now - lastRequestAt;
  return elapsed >= spacing ? 0 : spacing - elapsed;
}

/** Сколько миллисекунд до конца текущего окна длиной `windowMs` (окна выровнены по эпохе). */
function msUntilNextBoundary(now: number, windowMs: number): number {
  const rest = windowMs - (now % windowMs);
  return rest === 0 ? windowMs : rest;
}

/**
 * Хранит последний снимок лимитов и разводит запросы во времени.
 * Сериализация через цепочку промисов: без неё десять параллельных acquire()
 * прочитали бы один и тот же `lastRequestAt` и ушли бы одновременно.
 */
export class RateLimitGovernor {
  private snap: RateLimitSnapshot | null = null;
  private lastRequestAt: number | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
      sleep(ms, signal),
    /** Дольше этого внутри слота очереди не спим — см. acquire(). */
    private readonly maxWaitMs: number = VK_MAX_BACKOFF_MS,
  ) {}

  get snapshot(): RateLimitSnapshot | null {
    return this.snap;
  }

  observe(headers: Record<string, unknown> | undefined): void {
    const parsed = parseRateLimitHeaders(headers, this.now());
    if (parsed) this.snap = parsed;
  }

  /**
   * Занимает слот, выдержав нужную паузу.
   *
   * Пауза больше `maxWaitMs` (исчерпанные сутки — это до 24 часов) не отсиживается
   * здесь: воркер держал бы слот BullMQ, `setTimeout` не дал бы завершиться
   * graceful shutdown, и никто бы так и не узнал, что происходит. Вместо этого
   * бросаем RateLimitError с `retryAfterMs` — планировщик отложит задачу.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    const run = this.chain.then(async () => {
      if (signal?.aborted) {
        throw new ChannelError(VK_CHANNEL, 'VK request aborted', {
          code: 'VK_ABORTED',
          retryable: false,
        });
      }
      const delay = computeThrottleDelayMs({
        snapshot: this.snap,
        lastRequestAt: this.lastRequestAt,
        now: this.now(),
      });
      if (delay > this.maxWaitMs) {
        throw new RateLimitError(VK_CHANNEL, delay, {
          reason: 'vk-window-exhausted',
          waitMs: delay,
          maxWaitMs: this.maxWaitMs,
          snapshot: this.snap,
        });
      }
      if (delay > 0) await this.wait(delay, signal);
      this.lastRequestAt = this.now();
    });
    // Ошибку ожидания не тащим в следующую итерацию цепочки, иначе очередь встанет.
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export interface VkResponse {
  status: number;
  data: unknown;
  headers?: Record<string, unknown>;
}

export type VkTransport = (config: AxiosRequestConfig) => Promise<VkResponse>;

export interface VkHttpDeps {
  transport: VkTransport;
  getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  governor?: RateLimitGovernor;
  concurrency?: number;
  /** Сколько всего попыток на запрос, включая первую. */
  attempts?: number;
  /** Отмена: прерывает и паузы троттлинга, и паузы между ретраями. */
  signal?: AbortSignal;
}

export interface VkRequestOptions<T extends z.ZodTypeAny> {
  method: 'GET' | 'POST' | 'DELETE';
  /** Путь относительно базового URL, например `ad_plans.json`. */
  url: string;
  schema: T;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  label?: string;
}

/** Ретраить сетевые сбои и 5xx можно только там, где повтор безопасен. */
function isIdempotent(method: string): boolean {
  return method === 'GET';
}

function retryAfterMs(headers: Record<string, unknown> | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, VK_MAX_BACKOFF_MS);
}

/**
 * Повторять внутри процесса имеет смысл только короткие паузы. Если площадка
 * (или наш governor) просит вернуться позже, чем через `VK_MAX_BACKOFF_MS`,
 * ошибка уходит наверх: воркер освободит слот, а задачу отложит планировщик по
 * `retryAfterMs`. Иначе `withRetry` уснул бы на подсказанное время целиком —
 * `maxDelayMs` на подсказку площадки не распространяется.
 */
export function shouldRetryInProcess(err: unknown): boolean {
  if (!isRetryable(err)) return false;
  return err.retryAfterMs === undefined || err.retryAfterMs <= VK_MAX_BACKOFF_MS;
}

/** Раскладывает HTTP-ответ VK по доменным классам ошибок. */
export function mapVkHttpError(res: VkResponse, method: string, url: string): AppError {
  const info = parseVkError(res.data);
  const context = { status: res.status, url, method, vkCode: info.code };
  const message = info.message ?? `VK request failed with ${res.status}`;

  if (res.status === 401) {
    return new AuthError(VK_CHANNEL, `VK unauthorized: ${message}`, context);
  }
  if (res.status === 429) {
    // 429 ретраится независимо от метода — в отличие от таймаута и 5xx.
    // Инвариант, который это разрешает: 429 отдаёт лимитер до применения запроса,
    // а все наши записи в VK — абсолютные присваивания (status / max_price /
    // budget_limit_day через mass_action), поэтому повтор не «складывается».
    // Единственная неидемпотентная запись — создание баннера (createEntity);
    // повтор после 429 создал бы дубль, только если бы VK успел применить
    // запрос и всё равно ответил 429. Если такое поведение подтвердится на живом
    // токене — гейтить 429 по идемпотентности, как это сделано для 5xx.
    return new RateLimitError(VK_CHANNEL, retryAfterMs(res.headers) ?? 5_000, context);
  }
  if (res.status === 403) {
    // Не путать с потолком токенов: тот ловится в auth.ts на token.json.
    return new ChannelError(VK_CHANNEL, `VK forbidden: ${message}`, {
      code: 'VK_FORBIDDEN',
      retryable: false,
      context,
    });
  }
  if (res.status >= 500) {
    return new ChannelError(VK_CHANNEL, `VK server error: ${message}`, {
      code: 'VK_SERVER_ERROR',
      retryable: isIdempotent(method),
      context,
    });
  }
  return new ChannelError(VK_CHANNEL, `VK request rejected: ${message}`, {
    code: 'VK_BAD_REQUEST',
    retryable: false,
    context,
  });
}

/**
 * Транспорт ads.vk.ru: авторизация, троттлинг по заголовкам, ретраи, zod.
 * Один экземпляр на кабинет — состояние лимитов персонально для токена.
 */
export class VkHttpClient {
  private readonly transport: VkTransport;
  private readonly getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  private readonly governor: RateLimitGovernor;
  private readonly queue: PQueue;
  private readonly attempts: number;
  private readonly signal: AbortSignal | undefined;

  constructor(deps: VkHttpDeps) {
    this.transport = deps.transport;
    this.getAccessToken = deps.getAccessToken;
    this.governor = deps.governor ?? new RateLimitGovernor();
    this.queue = new PQueue({ concurrency: deps.concurrency ?? VK_DEFAULT_CONCURRENCY });
    this.attempts = deps.attempts ?? 4;
    this.signal = deps.signal;
  }

  get rateLimit(): RateLimitSnapshot | null {
    return this.governor.snapshot;
  }

  async request<T extends z.ZodTypeAny>(opts: VkRequestOptions<T>): Promise<z.infer<T>> {
    const label = opts.label ?? `${opts.method} ${opts.url}`;
    return withRetry(() => this.execute(opts, true), {
      attempts: this.attempts,
      baseMs: 1_000,
      maxDelayMs: VK_MAX_BACKOFF_MS,
      shouldRetry: shouldRetryInProcess,
      label: `vk ${label}`,
      ...(this.signal ? { signal: this.signal } : {}),
    });
  }

  /**
   * Одна попытка. `allowRefresh` истинен только на первом заходе: 401 после
   * свежевыпущенного токена означает не протухание, а отозванный доступ —
   * такое надо показывать человеку, а не крутить в цикле.
   */
  private async execute<T extends z.ZodTypeAny>(
    opts: VkRequestOptions<T>,
    allowRefresh: boolean,
  ): Promise<z.infer<T>> {
    const token = await this.getAccessToken();

    const res = await this.send({
      method: opts.method,
      url: opts.url,
      params: opts.params,
      data: opts.data,
      headers: { Authorization: `Bearer ${token}`, ...opts.headers },
    });

    if (res.status === 401 && allowRefresh) {
      log.warn({ url: opts.url }, 'vk 401, refreshing token and retrying once');
      await this.getAccessToken({ forceRefresh: true });
      return this.execute(opts, false);
    }

    if (res.status >= 400) throw mapVkHttpError(res, opts.method, opts.url);

    const parsed = opts.schema.safeParse(res.data);
    if (!parsed.success) {
      throw new ChannelError(VK_CHANNEL, `VK response failed validation: ${opts.url}`, {
        code: 'VK_SCHEMA_MISMATCH',
        retryable: false,
        context: {
          url: opts.url,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      });
    }
    return parsed.data as z.infer<T>;
  }

  /** Очередь + троттлинг + перевод сетевого сбоя в ChannelError. */
  private async send(config: AxiosRequestConfig): Promise<VkResponse> {
    const task = async (): Promise<VkResponse> => {
      await this.governor.acquire(this.signal);
      try {
        // Сигнал уходит и в транспорт: иначе отмена не прервёт запрос, уже ушедший в сеть.
        const res = await this.transport(this.signal ? { ...config, signal: this.signal } : config);
        this.governor.observe(res.headers);
        return res;
      } catch (err) {
        const method = config.method ?? 'GET';
        throw new ChannelError(VK_CHANNEL, 'VK transport failure', {
          code: 'VK_TRANSPORT',
          // Повтор небезопасного метода после таймаута может продублировать запись.
          retryable: isIdempotent(method),
          context: { url: config.url, method },
          cause: err,
        });
      }
    };
    return (await this.queue.add(task)) as VkResponse;
  }
}

function defaultTransport(): VkTransport {
  const instance = axios.create({
    baseURL: VK_ADS_BASE_URL,
    timeout: 60_000,
    // Статусы разбираем сами — так ветка 401→refresh и маппинг ошибок живут в одном месте.
    validateStatus: () => true,
  });
  return async (config) => {
    const res = await instance.request(config);
    return {
      status: res.status,
      data: res.data as unknown,
      headers: res.headers as unknown as Record<string, unknown>,
    };
  };
}

/** Клиент по контексту канала — обычный путь для адаптера. */
export function createVkHttpClient(
  ctx: ChannelContext,
  overrides: Partial<VkHttpDeps> = {},
): VkHttpClient {
  return new VkHttpClient({
    transport: overrides.transport ?? defaultTransport(),
    getAccessToken: overrides.getAccessToken ?? ((opts) => getVkAccessToken(ctx, opts)),
    ...(overrides.governor ? { governor: overrides.governor } : {}),
    ...(overrides.concurrency !== undefined ? { concurrency: overrides.concurrency } : {}),
    ...(overrides.attempts !== undefined ? { attempts: overrides.attempts } : {}),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  });
}
