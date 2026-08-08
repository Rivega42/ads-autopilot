import { createHash } from 'node:crypto';
import { ChannelError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { sleep } from '@/lib/retry.js';
import { withRetry } from '@/lib/retry.js';
import { shouldRetryYandex, YANDEX_CHANNEL } from '@/clients/yandex/errors.js';
import type { RawCallResult, YandexHttpClient } from '@/clients/yandex/http.js';

const log = scoped('yandex.reports');

/** Типы отчётов, которые нужны сервису. Полный список сервиса Reports шире. */
export type YandexReportType =
  | 'CAMPAIGN_PERFORMANCE_REPORT'
  | 'AD_PERFORMANCE_REPORT'
  | 'SEARCH_QUERY_PERFORMANCE_REPORT';

/**
 * Модели атрибуции.
 *
 * ТЗ §2.1 требует LSC. По документации (снимок 2026-08-08) LSC устарела и
 * автоматически конвертируется в кросс-девайсную LSCCD с предупреждением
 * в ответе. Принимаем LSC как псевдоним и отправляем LSCCD — смысл («последний
 * значимый переход») сохраняется, а предупреждение в лог не сыплется.
 */
export type AttributionModel = 'LSC' | 'LSCCD' | 'FCCD' | 'LC' | 'AUTO';

const ATTRIBUTION_ALIASES: Record<string, string> = {
  LSC: 'LSCCD',
  FC: 'FCCD',
  LYDC: 'AUTO',
  LYDCCD: 'AUTO',
};

export const DEFAULT_ATTRIBUTION_MODEL: AttributionModel = 'LSC';

export function normaliseAttributionModel(model: AttributionModel | string): string {
  return ATTRIBUTION_ALIASES[model] ?? model;
}

/** SEARCH_QUERY_PERFORMANCE_REPORT формируется только офлайн — просить online бессмысленно. */
const OFFLINE_ONLY: ReadonlySet<YandexReportType> = new Set(['SEARCH_QUERY_PERFORMANCE_REPORT']);

export interface ReportFilter {
  Field: string;
  Operator: string;
  Values: string[];
}

export interface ReportSpec {
  reportType: YandexReportType;
  fieldNames: string[];
  /** yyyy-MM-dd, включительно. */
  dateFrom: string;
  dateTo: string;
  /** ID целей Метрики, не более 10. */
  goals?: string[];
  attributionModels?: AttributionModel[];
  filters?: ReportFilter[];
  includeVat?: boolean;
  /** Максимум строк. По умолчанию серверный лимит 1 000 000. */
  limit?: number;
  /** Имя отчёта. В офлайн-режиме обязано быть уникальным для пользователя. */
  reportName?: string;
}

export interface ParsedReport {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface FetchReportOptions {
  /** Сколько раз опрашивать готовность. По умолчанию 30. */
  maxPolls?: number;
  /** Верхняя граница паузы между опросами, мс — чтобы retryIn=600 не подвесил воркер. */
  maxRetryDelayMs?: number;
  /** Пауза, если retryIn не пришёл. */
  defaultRetryDelayMs?: number;
  /** Шов для тестов: без него каждый прогон ждёт реальными таймерами. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Имя отчёта должно быть стабильным между опросами (Директ узнаёт отчёт
 * по совпадению всех параметров, включая имя) и уникальным между разными
 * запросами — иначе «отчёт с таким именем, но другими параметрами» = ошибка.
 * Поэтому имя = тип + период + хеш остальных параметров.
 */
export function buildReportName(spec: ReportSpec): string {
  if (spec.reportName) return spec.reportName;
  const fingerprint = JSON.stringify({
    f: spec.fieldNames,
    g: spec.goals ?? [],
    a: (spec.attributionModels ?? [DEFAULT_ATTRIBUTION_MODEL]).map(normaliseAttributionModel),
    q: spec.filters ?? [],
    v: spec.includeVat ?? true,
    l: spec.limit ?? null,
  });
  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 10);
  return `${spec.reportType}-${spec.dateFrom}_${spec.dateTo}-${hash}`;
}

export function buildReportDefinition(spec: ReportSpec): Record<string, unknown> {
  const selection: Record<string, unknown> = {
    DateFrom: spec.dateFrom,
    DateTo: spec.dateTo,
  };
  if (spec.filters?.length) selection.Filter = spec.filters;

  const params: Record<string, unknown> = {
    SelectionCriteria: selection,
    FieldNames: spec.fieldNames,
    ReportName: buildReportName(spec),
    ReportType: spec.reportType,
    // DateFrom/DateTo допустимы только вместе с CUSTOM_DATE и запрещены с остальными.
    DateRangeType: 'CUSTOM_DATE',
    Format: 'TSV',
    IncludeVAT: spec.includeVat === false ? 'NO' : 'YES',
  };
  if (spec.goals?.length) params.Goals = spec.goals;
  params.AttributionModels = (spec.attributionModels ?? [DEFAULT_ATTRIBUTION_MODEL]).map(
    normaliseAttributionModel,
  );
  if (spec.limit) params.Page = { Limit: spec.limit };
  return params;
}

function reportHeaders(spec: ReportSpec): Record<string, string> {
  return {
    // Для SEARCH_QUERY онлайн-режима не существует — просим офлайн сразу.
    processingMode: OFFLINE_ONLY.has(spec.reportType) ? 'offline' : 'auto',
    // Без этого деньги приходят целыми микроединицами и их пришлось бы делить руками.
    returnMoneyInMicros: 'false',
    // Шапку и итоговую строку выключаем: парсеру нужны только заголовки колонок и данные.
    skipReportHeader: 'true',
    skipReportSummary: 'true',
    skipColumnHeader: 'false',
  };
}

/** retryIn приходит в секундах; зажимаем, чтобы не спать 10 минут внутри задачи. */
function retryDelayMs(res: RawCallResult, opts: Required<Pick<FetchReportOptions, 'maxRetryDelayMs' | 'defaultRetryDelayMs'>>): number {
  const raw = res.headers['retryin'];
  const seconds = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return opts.defaultRetryDelayMs;
  return Math.min(seconds * 1000, opts.maxRetryDelayMs);
}

/**
 * Асинхронный отчёт: ставим в очередь и опрашиваем тем же телом запроса.
 *
 * 200 — отчёт в теле, 201 — принят в офлайн-очередь, 202 — ещё формируется.
 * Слот в очереди отчётов держим на всё время опроса: у пользователя их всего 5,
 * и превышение возвращает HTTP 400, а не вежливое ожидание.
 */
export async function fetchReport(
  http: YandexHttpClient,
  spec: ReportSpec,
  opts: FetchReportOptions = {},
): Promise<ParsedReport> {
  const maxPolls = opts.maxPolls ?? 30;
  const pauses = {
    maxRetryDelayMs: opts.maxRetryDelayMs ?? 30_000,
    defaultRetryDelayMs: opts.defaultRetryDelayMs ?? 5_000,
  };
  const pause = opts.sleepFn ?? ((ms: number) => sleep(ms));
  const params = buildReportDefinition(spec);
  const headers = reportHeaders(spec);
  const label = `reports.${spec.reportType}`;

  const poll = async (): Promise<ParsedReport> => {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const res = await withRetry(
        () =>
          http.raw('reports', { params }, {
            headers,
            responseType: 'text',
            label,
            acceptStatuses: [200, 201, 202],
          }),
        { label: `yandex.${label}`, attempts: 3, shouldRetry: shouldRetryYandex },
      );

      if (res.status === 200) {
        return parseReportTsv(typeof res.data === 'string' ? res.data : String(res.data ?? ''));
      }

      const delay = retryDelayMs(res, pauses);
      log.debug(
        {
          clientId: http.clientId,
          reportType: spec.reportType,
          requestId: res.requestId,
          status: res.status,
          inQueue: res.headers['reportsinqueue'],
          delay,
          attempt: attempt + 1,
        },
        'report not ready, waiting',
      );
      await pause(delay);
    }

    throw new ChannelError(YANDEX_CHANNEL, `Report ${spec.reportType} not ready after ${maxPolls} polls`, {
      code: 'YANDEX_REPORT_TIMEOUT',
      // Отчёт всё ещё формируется — имеет смысл вернуться позже, но не сейчас.
      retryable: true,
      retryAfterMs: 15 * 60 * 1000,
      context: { reportType: spec.reportType, dateFrom: spec.dateFrom, dateTo: spec.dateTo },
    });
  };

  return http.reportQueue.add(poll, { throwOnTimeout: true });
}

// ── Разбор TSV ───────────────────────────────────────────────────────────────

/**
 * Разбивает строку TSV на поля.
 *
 * Формально Директ отдаёт «сырые» значения без кавычек, но поля Query и текстов
 * объявлений приходят из пользовательского ввода, и встречались выгрузки, где
 * значение обёрнуто в двойные кавычки с удвоением внутренних. Разбираем оба вида:
 * лишняя терпимость здесь дешевле, чем сломанная ночная статистика.
 */
export function splitTsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && current === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      fields.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  fields.push(current);
  return fields;
}

/**
 * Разбирает тело отчёта. Первая строка — названия колонок (шапка и итог отключены
 * заголовками запроса). Пустое тело или единственная строка заголовков — валидный
 * «нет данных» ответ, а не ошибка: за период без показов Директ возвращает именно это.
 */
export function parseReportTsv(body: string): ParsedReport {
  const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) return { headers: [], rows: [] };

  const headers = splitTsvLine(headerLine);
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const values = splitTsvLine(raw);
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (key === undefined) continue;
      row[key] = values[c] ?? '';
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * Числовое значение из TSV. Директ ставит `--` там, где данных нет
 * (например, Conversions без настроенных целей) — это ноль, а не NaN.
 */
export function reportNumber(value: string | undefined): number {
  if (value === undefined || value === '' || value === '--') return 0;
  const n = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
