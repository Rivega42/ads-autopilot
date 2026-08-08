import axios from 'axios';
import PQueue from 'p-queue';
import type { ZodType } from 'zod';
import { env, YANDEX_DIRECT_BASE_URL } from '@/config/index.js';
import { ChannelError, OutOfUnitsError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { withRetry } from '@/lib/retry.js';
import { buildAuthHeaders, type YandexCredentials } from '@/clients/yandex/auth.js';
import {
  extractErrorBody,
  mapHttpStatus,
  mapYandexError,
  OUT_OF_UNITS_DEFER_MS,
  RETRY_SOON_ATTEMPTS,
  shouldRetryYandex,
  YANDEX_CHANNEL,
} from '@/clients/yandex/errors.js';

const log = scoped('yandex.http');

/** Жёсткий лимит площадки: не более 5 одновременных запросов от одного рекламодателя. */
export const MAX_CONCURRENT_REQUESTS = 5;
/** В очереди на формирование одновременно не более 5 офлайн-отчётов на пользователя. */
export const MAX_REPORTS_IN_QUEUE = 5;

// ── Транспорт ────────────────────────────────────────────────────────────────

export interface HttpRequest {
  url: string;
  body: unknown;
  headers: Record<string, string>;
  /** Reports отдаёт TSV, всё остальное — JSON. */
  responseType: 'json' | 'text';
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  data: unknown;
}

/**
 * Шов для тестов: юниты подсовывают чистую функцию и не трогают сеть.
 * Продовая реализация — axios (см. createAxiosTransport).
 */
export type HttpTransport = (req: HttpRequest) => Promise<HttpResponse>;

/** Заголовки axios в Node приходят в нижнем регистре — нормализуем на всякий случай. */
function normaliseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return out;
}

export function createAxiosTransport(timeoutMs = 60_000): HttpTransport {
  const instance = axios.create({
    timeout: timeoutMs,
    // Коды разбираем сами: 201/202 у Reports — это не ошибка, а стадия готовности.
    validateStatus: () => true,
    // Директ уже присылает UTF-8; просим axios не пытаться угадать JSON в TSV.
    transitional: { silentJSONParsing: false, forcedJSONParsing: false, clarifyTimeoutError: true },
  });

  return async (req) => {
    const res = await instance.post(req.url, req.body, {
      headers: req.headers,
      responseType: req.responseType === 'text' ? 'text' : 'json',
    });
    let data: unknown = res.data;
    // При forcedJSONParsing:false JSON приходит строкой — разбираем сами.
    if (req.responseType === 'json' && typeof data === 'string') {
      try {
        data = JSON.parse(data) as unknown;
      } catch {
        // Не JSON — оставляем строкой, дальше решит mapHttpStatus.
      }
    }
    return { status: res.status, headers: normaliseHeaders(res.headers), data };
  };
}

// ── Учёт баллов ──────────────────────────────────────────────────────────────

export interface UnitsSnapshot {
  /** Списано этим запросом. */
  spent: number;
  /** Остаток на момент ответа. */
  remaining: number;
  /** Суточный лимит рекламодателя. */
  dailyLimit: number;
}

/**
 * Разбирает `Units: 10/20828/64000`.
 *
 * Возвращает null на любой неожиданной форме: заголовок — вспомогательная
 * телеметрия, из-за его кривизны нельзя терять уже полученные данные ответа.
 */
export function parseUnitsHeader(raw: string | undefined | null): UnitsSnapshot | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [spent, remaining, dailyLimit] = parts.map((p) => Number(p.trim()));
  if (
    spent === undefined ||
    remaining === undefined ||
    dailyLimit === undefined ||
    !Number.isFinite(spent) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(dailyLimit)
  ) {
    return null;
  }
  return { spent, remaining, dailyLimit };
}

/** Куда пишем расход баллов. Инжектируется, чтобы тесты не поднимали Postgres. */
export interface UnitsLedgerWriter {
  record(entry: {
    clientId: string;
    method: string;
    spent: number;
    remaining: number;
    dailyLimit: number;
  }): Promise<void>;
}

export const prismaUnitsLedger: UnitsLedgerWriter = {
  async record(entry) {
    // Ленивый импорт: юнит-тесты с подменённым writer'ом вообще не грузят Prisma.
    const { prisma } = await import('@/db/prisma.js');
    await prisma.unitsLedger.create({ data: entry });
  },
};

// ── Разделяемое состояние на рекламодателя ───────────────────────────────────

/**
 * Очередь и остаток баллов живут на уровне модуля, а не экземпляра клиента.
 *
 * Иначе два адаптера одного кабинета (например, синк и оптимизатор в одном воркере)
 * дали бы 10 параллельных запросов вместо пяти и каждый считал бы баллы по-своему.
 */
const queues = new Map<string, PQueue>();
const reportQueues = new Map<string, PQueue>();
const unitsState = new Map<string, UnitsSnapshot>();

function getQueue(map: Map<string, PQueue>, key: string, concurrency: number): PQueue {
  let q = map.get(key);
  if (!q) {
    q = new PQueue({ concurrency });
    map.set(key, q);
  }
  return q;
}

/** Известный остаток баллов рекламодателя (null — ещё ни одного ответа). */
export function getKnownUnits(advertiserKey: string): UnitsSnapshot | null {
  return unitsState.get(advertiserKey) ?? null;
}

/** Сброс разделяемого состояния — только для тестов. */
export function resetYandexRuntimeState(): void {
  queues.clear();
  reportQueues.clear();
  unitsState.clear();
}

// ── Клиент ───────────────────────────────────────────────────────────────────

export interface YandexHttpOptions {
  clientId: string;
  credentials: YandexCredentials;
  baseUrl?: string;
  transport?: HttpTransport;
  ledger?: UnitsLedgerWriter;
  /** Ниже этого остатка вообще не выходим в сеть. По умолчанию env.YANDEX_UNITS_RESERVE. */
  unitsReserve?: number;
  /** Сколько попыток на «быстрые» ошибки. Больше 3 — сжигание квоты по 20 баллов. */
  retryAttempts?: number;
}

export interface RawCallOptions {
  /** Дополнительные заголовки (Reports: processingMode, skipReportHeader, ...). */
  headers?: Record<string, string>;
  responseType?: 'json' | 'text';
  /** Имя для журнала баллов и логов. По умолчанию `<service>.<method>`. */
  label?: string;
  /** Не пропускать через очередь: используется только вложенными вызовами. */
  bypassQueue?: boolean;
  /** HTTP-коды, которые не считаются ошибкой (Reports: 201/202). */
  acceptStatuses?: number[];
}

export interface RawCallResult {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  requestId?: string;
  units: UnitsSnapshot | null;
}

export class YandexHttpClient {
  readonly clientId: string;
  readonly baseUrl: string;
  private readonly credentials: YandexCredentials;
  private readonly transport: HttpTransport;
  private readonly ledger: UnitsLedgerWriter;
  private readonly unitsReserve: number;
  private readonly retryAttempts: number;
  /**
   * Ключ квоты — рекламодатель, а не наш clientId: у агентства несколько
   * кабинетов делят один токен, но у каждого свой лимит и свои 5 соединений.
   */
  private readonly advertiserKey: string;

  constructor(opts: YandexHttpOptions) {
    this.clientId = opts.clientId;
    this.credentials = opts.credentials;
    this.baseUrl = (opts.baseUrl ?? YANDEX_DIRECT_BASE_URL).replace(/\/?$/, '/');
    this.transport = opts.transport ?? createAxiosTransport();
    this.ledger = opts.ledger ?? prismaUnitsLedger;
    this.unitsReserve = opts.unitsReserve ?? env.YANDEX_UNITS_RESERVE;
    this.retryAttempts = opts.retryAttempts ?? RETRY_SOON_ATTEMPTS;
    this.advertiserKey = opts.credentials.clientLogin ?? opts.clientId;
  }

  get units(): UnitsSnapshot | null {
    return getKnownUnits(this.advertiserKey);
  }

  /** Очередь отчётов: отдельная от основной, лимит — 5 офлайн-отчётов в работе. */
  get reportQueue(): PQueue {
    return getQueue(reportQueues, this.advertiserKey, MAX_REPORTS_IN_QUEUE);
  }

  /**
   * Отказ выйти в сеть, когда остаток ниже резерва.
   *
   * Дешевле не звонить вовсе: отказ Директа по коду 152 сам стоит 20 баллов,
   * а исчерпание квоты блокирует кабинет до следующего часового начисления.
   */
  private assertUnitsAvailable(label: string): void {
    const snapshot = this.units;
    if (!snapshot) return; // Ещё ни одного ответа — остаток неизвестен, пробуем.
    if (snapshot.remaining >= this.unitsReserve) return;

    log.warn(
      { clientId: this.clientId, label, remaining: snapshot.remaining, reserve: this.unitsReserve },
      'refusing Yandex call: units below reserve',
    );
    throw new OutOfUnitsError(YANDEX_CHANNEL, OUT_OF_UNITS_DEFER_MS, {
      clientId: this.clientId,
      label,
      remaining: snapshot.remaining,
      dailyLimit: snapshot.dailyLimit,
      reserve: this.unitsReserve,
    });
  }

  /** Разбор `Units`, запись в журнал и обновление разделяемого остатка. */
  private async accountUnits(
    headers: Record<string, string>,
    label: string,
  ): Promise<UnitsSnapshot | null> {
    const snapshot = parseUnitsHeader(headers['units']);
    if (!snapshot) {
      if (headers['units'] !== undefined) {
        log.warn({ raw: headers['units'], label }, 'malformed Units header, skipping accounting');
      }
      return null;
    }

    unitsState.set(this.advertiserKey, snapshot);
    try {
      await this.ledger.record({
        clientId: this.clientId,
        method: label,
        spent: snapshot.spent,
        remaining: snapshot.remaining,
        dailyLimit: snapshot.dailyLimit,
      });
    } catch (err) {
      // Журнал баллов — аналитика. Сорванная запись в БД не повод терять ответ API.
      log.error({ err: String(err), label }, 'failed to persist UnitsLedger entry');
    }
    return snapshot;
  }

  /**
   * Один сетевой вызов: очередь → проверка баллов → запрос → учёт → маппинг ошибок.
   * Ретраев здесь нет, ими управляет `call`/`fetchReport`.
   */
  async raw(path: string, body: unknown, opts: RawCallOptions = {}): Promise<RawCallResult> {
    const label = opts.label ?? path;
    const responseType = opts.responseType ?? 'json';
    const accept = new Set(opts.acceptStatuses ?? [200]);

    const run = async (): Promise<RawCallResult> => {
      this.assertUnitsAvailable(label);

      const res = await this.transport({
        url: new URL(path, this.baseUrl).toString(),
        body,
        headers: { ...buildAuthHeaders(this.credentials), ...opts.headers },
        responseType,
      });

      const requestId = res.headers['requestid'];
      const units = await this.accountUnits(res.headers, label);

      // RequestId в каждой строке лога: поддержка Яндекса спрашивает именно его.
      log.debug(
        {
          clientId: this.clientId,
          label,
          requestId,
          status: res.status,
          spent: units?.spent,
          remaining: units?.remaining,
        },
        'yandex api call',
      );

      // Ошибка уровня запроса приходит с HTTP 200 и телом { error: {...} }.
      const errBody = extractErrorBody(res.data);
      if (errBody) {
        throw mapYandexError(errBody, {
          clientId: this.clientId,
          method: label,
          requestId,
          httpStatus: res.status,
        });
      }
      if (!accept.has(res.status)) {
        throw mapHttpStatus(res.status, res.data, {
          clientId: this.clientId,
          method: label,
          requestId,
        });
      }

      const result: RawCallResult = { status: res.status, headers: res.headers, data: res.data, units };
      if (requestId) result.requestId = requestId;
      return result;
    };

    if (opts.bypassQueue) return run();
    return getQueue(queues, this.advertiserKey, MAX_CONCURRENT_REQUESTS).add(run, {
      throwOnTimeout: true,
    });
  }

  /**
   * Типизированный вызов метода API v5: `POST <base>/<service>` с телом
   * `{ method, params }`. Ответ валидируется схемой — площадка меняет форму молча.
   */
  async call<T>(
    service: string,
    method: string,
    params: Record<string, unknown>,
    schema: ZodType<T>,
    opts: RawCallOptions = {},
  ): Promise<T> {
    const label = opts.label ?? `${service}.${method}`;

    const res = await withRetry(() => this.raw(service, { method, params }, { ...opts, label }), {
      label: `yandex.${label}`,
      attempts: this.retryAttempts,
      // OutOfUnitsError сюда не попадёт: ждать час внутри воркера нельзя.
      shouldRetry: shouldRetryYandex,
    });

    const parsed = schema.safeParse(res.data);
    if (!parsed.success) {
      throw new ChannelError(YANDEX_CHANNEL, `Unexpected Yandex response shape for ${label}`, {
        code: 'YANDEX_SCHEMA',
        retryable: false,
        context: {
          label,
          requestId: res.requestId,
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      });
    }
    return parsed.data;
  }
}
