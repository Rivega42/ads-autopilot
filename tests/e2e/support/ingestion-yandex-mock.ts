import { http, HttpResponse, type HttpHandler } from 'msw';

/** Совпадает с `YANDEX_DIRECT_BASE_URL` при `YANDEX_DIRECT_USE_SANDBOX=true`. */
export const YANDEX_BASE = 'https://api-sandbox.direct.yandex.com/json/v5';

/**
 * Мок Директа v5 для загрузки данных, который ведёт себя как протокол.
 *
 * Отдельный от `yandex-api-mock.ts`: тот держит кабинет для цикла оптимизации и
 * знает про suspend/бюджеты; здесь нужны ровно чтения — четыре `get`-метода и
 * сервис Reports, зато с теми правилами площадки, на которых ломается разбор:
 *
 *  • ответ содержит РОВНО запрошенные `FieldNames` и ничего сверх: подобъекты
 *    `TextCampaign` и `TextAd` появляются только вместе со своими
 *    `*FieldNames`, и внутри — только перечисленные поля;
 *  • отсутствие обязательного параметра — это ошибка 8000, а не пустой ответ;
 *  • деньги в методах `get` — целые микроединицы, в отчётах при
 *    `returnMoneyInMicros: false` — строка с двумя знаками;
 *  • пагинация по `Page.Limit/Offset` + `LimitedBy` настоящая: страницу режет мок,
 *    а не тест, и оборванный листинг видно так же, как в проде;
 *  • отчёт агрегируется по запрошенным разрезам, отдаёт `--` там, где значения
 *    нет (`CriterionId` у РСЯ, `Conversions` без целей), и не выпускает ни одной
 *    строки за пределы `DateFrom`/`DateTo` — иначе скользящее окно нечем проверить;
 *  • офлайн-отчёт (`SEARCH_QUERY_PERFORMANCE_REPORT`) сперва отвечает 201 с
 *    `retryIn`, и только следующий опрос отдаёт данные.
 *
 * Состояние кабинета живое: тест меняет его между прогонами и проверяет, что
 * изменение доехало до строк.
 */

export interface CabinetCampaign {
  id: number;
  name: string;
  /** TEXT_CAMPAIGN / UNIFIED_CAMPAIGN — от него зависит имя подобъекта стратегии. */
  type: 'TEXT_CAMPAIGN' | 'UNIFIED_CAMPAIGN';
  /** Показы: ON / OFF / SUSPENDED / ENDED / ARCHIVED / CONVERTED. */
  state: string;
  /** Модерация: ACCEPTED / MODERATION / DRAFT / REJECTED. */
  status: string;
  /** В рублях; `null` — дневного лимита у кампании нет. */
  dailyBudgetRub: number | null;
  strategyType: string | null;
  negativeKeywords: string[];
}

export interface CabinetAdGroup {
  id: number;
  campaignId: number;
  name: string;
  status: string;
  type: string;
  regionIds: number[];
}

export interface CabinetAd {
  id: number;
  campaignId: number;
  adGroupId: number;
  state: string;
  status: string;
  statusClarification?: string;
  title: string;
  title2?: string;
  text: string;
  href?: string;
}

export interface CabinetKeyword {
  id: number;
  campaignId: number;
  adGroupId: number;
  keyword: string;
  state: string;
  status: string;
  /** В рублях; `null` — ставки нет (автостратегия). */
  bidRub: number | null;
}

/**
 * Факт открутки — то, из чего Директ собирает любой отчёт.
 *
 * `criterionId: null` — показ без ключевой фразы (автотаргетинг РСЯ): в отчёте
 * такая строка приходит с `--`, и сопоставить её с фразой нельзя в принципе.
 * `conversions: null` — целей нет, в TSV тоже `--`.
 */
export interface CabinetFact {
  date: string;
  campaignId: number;
  adGroupId?: number;
  adId?: number;
  criterionId?: number | null;
  query?: string;
  impressions: number;
  clicks: number;
  cost: number;
  conversions?: number | null;
  revenue?: number | null;
}

export interface Cabinet {
  campaigns: CabinetCampaign[];
  adGroups: CabinetAdGroup[];
  ads: CabinetAd[];
  keywords: CabinetKeyword[];
  /** Открутка для CAMPAIGN_PERFORMANCE_REPORT и AD_PERFORMANCE_REPORT. */
  facts: CabinetFact[];
  /** Открутка для SEARCH_QUERY_PERFORMANCE_REPORT. */
  queries: CabinetFact[];
}

export interface YandexError {
  error_code: number;
  error_string: string;
  error_detail?: string;
}

export interface YandexCall {
  service: string;
  method: string;
  params: Record<string, unknown>;
}

export interface FailureRule {
  service: string;
  /** Для `reports` сравнивается тип отчёта. */
  method?: string;
  /** Ограничить отказ одним кабинетом: у соседнего кабинет обязан работать. */
  accessToken?: string;
  error: YandexError;
  /** Сколько раз сработать. По умолчанию — всегда. */
  times?: number;
}

/** Один кабинет = один токен: чужой Bearer не должен видеть чужие кампании. */
export interface YandexAccount {
  accessToken: string;
  cabinet: Cabinet;
}

export interface YandexDirectMockOptions {
  accounts: readonly YandexAccount[];
  /** Сколько объектов отдавать за одну страницу `get`. По умолчанию — все. */
  pageSize?: number;
}

export interface YandexDirectMock {
  handlers: HttpHandler[];
  /** Кабинет по токену — тест меняет его между прогонами. */
  cabinetOf(accessToken: string): Cabinet;
  calls: YandexCall[];
  /** Тела запросов к сервису Reports — по ним видно запрошенное окно. */
  reportRequests: Array<{ params: Record<string, unknown>; headers: Record<string, string> }>;
  fail(rule: FailureRule): void;
  clearFailures(): void;
  callsTo(service: string): YandexCall[];
}

const HEADERS = { Units: '10/60000/64000', RequestId: '4242424242424242424' };

const MICROS = 1_000_000;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map(Number).filter((v): v is number => Number.isFinite(v))
    : [];
}

function ok(result: Record<string, unknown>): Response {
  return HttpResponse.json({ result }, { headers: HEADERS });
}

/**
 * Ошибка уровня запроса. Директ отдаёт её с HTTP 200 и телом `{ error: {...} }` —
 * ровно это и разбирает `extractErrorBody`, поэтому форма здесь важнее кода.
 */
function fault(error: YandexError, status = 200): Response {
  return HttpResponse.json(
    { error: { ...error, request_id: HEADERS.RequestId } },
    { status, headers: HEADERS },
  );
}

const MISSING_PARAM = 8000;

/** Проекция объекта на запрошенные поля: лишнего площадка не отдаёт никогда. */
function project(
  full: Record<string, unknown>,
  fieldNames: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fieldNames) {
    if (field in full) out[field] = full[field];
  }
  return out;
}

interface Page<T> {
  items: T[];
  limitedBy?: number;
}

function paginate<T>(
  all: readonly T[],
  params: Record<string, unknown>,
  pageSize: number,
): Page<T> {
  const page = asRecord(params['Page']);
  const offset = Number(page['Offset'] ?? 0) || 0;
  const requested = Number(page['Limit'] ?? pageSize) || pageSize;
  const limit = Math.min(requested, pageSize);
  const items = all.slice(offset, offset + limit);
  const consumed = offset + items.length;
  return consumed < all.length ? { items, limitedBy: consumed } : { items };
}

// ── Отчёты ───────────────────────────────────────────────────────────────────

type ReportType =
  'CAMPAIGN_PERFORMANCE_REPORT' | 'AD_PERFORMANCE_REPORT' | 'SEARCH_QUERY_PERFORMANCE_REPORT';

/** Разрезы, доступные каждому типу отчёта. Остальные поля — метрики. */
const DIMENSIONS: Record<ReportType, readonly string[]> = {
  CAMPAIGN_PERFORMANCE_REPORT: ['Date', 'CampaignId'],
  AD_PERFORMANCE_REPORT: ['Date', 'CampaignId', 'AdGroupId', 'AdId', 'CriterionId'],
  SEARCH_QUERY_PERFORMANCE_REPORT: ['Date', 'CampaignId', 'AdGroupId', 'Query'],
};

const METRICS: readonly string[] = ['Impressions', 'Clicks', 'Cost', 'Conversions', 'Revenue'];

/** `--` — то, чем Директ обозначает «значения нет»: нет фразы, нет целей. */
const NO_VALUE = '--';

function dimensionValue(fact: CabinetFact, field: string): string {
  switch (field) {
    case 'Date':
      return fact.date;
    case 'CampaignId':
      return String(fact.campaignId);
    case 'AdGroupId':
      return fact.adGroupId === undefined ? NO_VALUE : String(fact.adGroupId);
    case 'AdId':
      return fact.adId === undefined ? NO_VALUE : String(fact.adId);
    case 'CriterionId':
      return fact.criterionId === undefined || fact.criterionId === null
        ? NO_VALUE
        : String(fact.criterionId);
    case 'Query':
      return fact.query ?? NO_VALUE;
    default:
      return NO_VALUE;
  }
}

interface Bucket {
  dimensions: string[];
  impressions: number;
  clicks: number;
  cost: number;
  /** `null` — ни один факт не принёс измеренных конверсий. */
  conversions: number | null;
  revenue: number | null;
}

function accumulate(bucket: Bucket, fact: CabinetFact): void {
  bucket.impressions += fact.impressions;
  bucket.clicks += fact.clicks;
  bucket.cost += fact.cost;
  if (fact.conversions !== undefined && fact.conversions !== null) {
    bucket.conversions = (bucket.conversions ?? 0) + fact.conversions;
  }
  if (fact.revenue !== undefined && fact.revenue !== null) {
    bucket.revenue = (bucket.revenue ?? 0) + fact.revenue;
  }
}

function metricValue(bucket: Bucket, field: string): string {
  switch (field) {
    case 'Impressions':
      return String(bucket.impressions);
    case 'Clicks':
      return String(bucket.clicks);
    // returnMoneyInMicros: false — деньги приходят в валюте кабинета.
    case 'Cost':
      return bucket.cost.toFixed(2);
    case 'Conversions':
      return bucket.conversions === null ? NO_VALUE : String(bucket.conversions);
    case 'Revenue':
      return bucket.revenue === null ? NO_VALUE : bucket.revenue.toFixed(2);
    default:
      return NO_VALUE;
  }
}

/**
 * Собирает TSV ровно так, как это делает Директ: агрегирует факты по
 * запрошенным разрезам, отдаёт колонки в порядке `FieldNames` и не выпускает ни
 * одной строки за границы периода.
 */
function buildReportTsv(
  facts: readonly CabinetFact[],
  reportType: ReportType,
  fieldNames: readonly string[],
  from: string,
  to: string,
): string {
  const dims = fieldNames.filter((f) => DIMENSIONS[reportType].includes(f));
  const buckets = new Map<string, Bucket>();

  for (const fact of facts) {
    if (fact.date < from || fact.date > to) continue;
    // Строк без единого показа и клика отчёт не содержит.
    if (fact.impressions === 0 && fact.clicks === 0 && fact.cost === 0) continue;
    const dimensions = dims.map((field) => dimensionValue(fact, field));
    const key = dimensions.join(' ');
    const bucket = buckets.get(key) ?? {
      dimensions,
      impressions: 0,
      clicks: 0,
      cost: 0,
      conversions: null,
      revenue: null,
    };
    accumulate(bucket, fact);
    buckets.set(key, bucket);
  }

  const lines = [fieldNames.join('\t')];
  for (const bucket of buckets.values()) {
    lines.push(
      fieldNames
        .map((field) => {
          const at = dims.indexOf(field);
          return at >= 0 ? (bucket.dimensions[at] ?? NO_VALUE) : metricValue(bucket, field);
        })
        .join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ── Мок ──────────────────────────────────────────────────────────────────────

export function createYandexDirectMock(options: YandexDirectMockOptions): YandexDirectMock {
  const byToken = new Map(options.accounts.map((a) => [a.accessToken, a.cabinet]));
  const pageSize = options.pageSize ?? Number.MAX_SAFE_INTEGER;
  const calls: YandexCall[] = [];
  const reportRequests: Array<{
    params: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  const failures: FailureRule[] = [];
  /** Сколько раз опрошен офлайн-отчёт с этим именем: первый ответ — 201. */
  const offlinePolls = new Map<string, number>();

  const takeFailure = (service: string, method: string, token: string): YandexError | null => {
    const at = failures.findIndex(
      (rule) =>
        rule.service === service &&
        (rule.method === undefined || rule.method === method) &&
        (rule.accessToken === undefined || rule.accessToken === token),
    );
    if (at < 0) return null;
    const rule = failures[at] as FailureRule;
    if (rule.times !== undefined) {
      rule.times -= 1;
      if (rule.times <= 0) failures.splice(at, 1);
    }
    return rule.error;
  };

  const tokenOf = (request: Request): string => {
    const raw = request.headers.get('Authorization') ?? '';
    return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length) : '';
  };

  /** Кабинет, которому принадлежит Bearer запроса. `null` — токен неизвестен. */
  const accountOf = (request: Request): Cabinet | null => byToken.get(tokenOf(request)) ?? null;

  const projectCampaign = (
    campaign: CabinetCampaign,
    params: Record<string, unknown>,
  ): Record<string, unknown> => {
    const full: Record<string, unknown> = {
      Id: campaign.id,
      Name: campaign.name,
      Type: campaign.type,
      Status: campaign.status,
      State: campaign.state,
      DailyBudget:
        campaign.dailyBudgetRub === null
          ? null
          : { Amount: campaign.dailyBudgetRub * MICROS, Mode: 'STANDARD' },
      NegativeKeywords: { Items: [...campaign.negativeKeywords] },
    };
    const out = project(full, asStrings(params['FieldNames']));

    // Подобъект стратегии приезжает только со своим списком полей — и только у
    // кампании подходящего типа. Именно поэтому `strategyName` разбирает вложенность.
    const subFields =
      campaign.type === 'TEXT_CAMPAIGN'
        ? asStrings(params['TextCampaignFieldNames'])
        : asStrings(params['UnifiedCampaignFieldNames']);
    if (subFields.length > 0) {
      const key = campaign.type === 'TEXT_CAMPAIGN' ? 'TextCampaign' : 'UnifiedCampaign';
      out[key] = project(
        {
          BiddingStrategy: {
            Search: { BiddingStrategyType: campaign.strategyType ?? 'HIGHEST_POSITION' },
            Network: { BiddingStrategyType: 'SERVING_OFF' },
          },
        },
        subFields,
      );
    }
    return out;
  };

  const projectAd = (ad: CabinetAd, params: Record<string, unknown>): Record<string, unknown> => {
    const full: Record<string, unknown> = {
      Id: ad.id,
      CampaignId: ad.campaignId,
      AdGroupId: ad.adGroupId,
      State: ad.state,
      Status: ad.status,
      StatusClarification: ad.statusClarification ?? null,
    };
    const out = project(full, asStrings(params['FieldNames']));

    const textFields = asStrings(params['TextAdFieldNames']);
    if (textFields.length > 0) {
      out['TextAd'] = project(
        {
          Title: ad.title,
          Title2: ad.title2,
          Text: ad.text,
          Href: ad.href ?? null,
          DisplayDomain: null,
        },
        // Поля, которых у объявления нет вовсе, площадка просто не присылает.
        textFields.filter((f) => f !== 'Title2' || ad.title2 !== undefined),
      );
    }
    return out;
  };

  const jsonHandler = http.post(`${YANDEX_BASE}/:service`, async ({ request, params }) => {
    const service = String(params['service']);
    const cabinet = accountOf(request);
    if (!cabinet) return fault({ error_code: 53, error_string: 'Ошибка авторизации' });

    const body = (await request.json()) as { method?: unknown; params?: unknown };
    const method = typeof body.method === 'string' ? body.method : '';
    const p = asRecord(body.params);
    calls.push({ service, method, params: p });

    if (method === '') {
      return fault({ error_code: MISSING_PARAM, error_string: 'Не задан метод' });
    }

    const injected = takeFailure(service, method, tokenOf(request));
    if (injected) return fault(injected);

    const fieldNames = asStrings(p['FieldNames']);
    if (fieldNames.length === 0) {
      return fault({
        error_code: MISSING_PARAM,
        error_string: 'Отсутствует обязательный параметр',
        error_detail: 'FieldNames',
      });
    }

    const selection = asRecord(p['SelectionCriteria']);
    // У campaigns и clients критерий отбора необязателен, у остальных — обязателен.
    if (
      service !== 'campaigns' &&
      service !== 'clients' &&
      Object.keys(selection).length === 0 &&
      p['SelectionCriteria'] === undefined
    ) {
      return fault({
        error_code: MISSING_PARAM,
        error_string: 'Отсутствует обязательный параметр',
        error_detail: 'SelectionCriteria',
      });
    }

    if (service === 'clients' && method === 'get') {
      return ok({
        Clients: [
          project(
            {
              ClientId: 90210,
              Login: 'e2e-ingestion',
              ClientInfo: 'ООО «Кофемолка»',
              Currency: 'RUB',
            },
            fieldNames,
          ),
        ],
      });
    }

    if (service === 'campaigns' && method === 'get') {
      const ids = asNumbers(selection['Ids']);
      const all = cabinet.campaigns.filter((c) => ids.length === 0 || ids.includes(c.id));
      const { items, limitedBy } = paginate(all, p, pageSize);
      return ok({
        Campaigns: items.map((c) => projectCampaign(c, p)),
        ...(limitedBy === undefined ? {} : { LimitedBy: limitedBy }),
      });
    }

    if (service === 'adgroups' && method === 'get') {
      const campaignIds = asNumbers(selection['CampaignIds']);
      const ids = asNumbers(selection['Ids']);
      const all = cabinet.adGroups.filter(
        (g) =>
          (campaignIds.length === 0 || campaignIds.includes(g.campaignId)) &&
          (ids.length === 0 || ids.includes(g.id)),
      );
      const { items, limitedBy } = paginate(all, p, pageSize);
      return ok({
        AdGroups: items.map((g) =>
          project(
            {
              Id: g.id,
              CampaignId: g.campaignId,
              Name: g.name,
              Status: g.status,
              Type: g.type,
              RegionIds: [...g.regionIds],
            },
            fieldNames,
          ),
        ),
        ...(limitedBy === undefined ? {} : { LimitedBy: limitedBy }),
      });
    }

    if (service === 'ads' && method === 'get') {
      const adGroupIds = asNumbers(selection['AdGroupIds']);
      const campaignIds = asNumbers(selection['CampaignIds']);
      const all = cabinet.ads.filter(
        (a) =>
          (adGroupIds.length === 0 || adGroupIds.includes(a.adGroupId)) &&
          (campaignIds.length === 0 || campaignIds.includes(a.campaignId)),
      );
      const { items, limitedBy } = paginate(all, p, pageSize);
      return ok({
        Ads: items.map((a) => projectAd(a, p)),
        ...(limitedBy === undefined ? {} : { LimitedBy: limitedBy }),
      });
    }

    if (service === 'keywords' && method === 'get') {
      const adGroupIds = asNumbers(selection['AdGroupIds']);
      const all = cabinet.keywords.filter(
        (k) => adGroupIds.length === 0 || adGroupIds.includes(k.adGroupId),
      );
      const { items, limitedBy } = paginate(all, p, pageSize);
      return ok({
        Keywords: items.map((k) =>
          project(
            {
              Id: k.id,
              CampaignId: k.campaignId,
              AdGroupId: k.adGroupId,
              Keyword: k.keyword,
              State: k.state,
              Status: k.status,
              Bid: k.bidRub === null ? null : k.bidRub * MICROS,
              ContextBid: null,
              StrategyPriority: null,
            },
            fieldNames,
          ),
        ),
        ...(limitedBy === undefined ? {} : { LimitedBy: limitedBy }),
      });
    }

    return fault({
      error_code: 8000,
      error_string: `Метод ${service}.${method} не поддерживается`,
    });
  });

  const reportHandler = http.post(`${YANDEX_BASE}/reports`, async ({ request }) => {
    const cabinet = accountOf(request);
    if (!cabinet) return fault({ error_code: 53, error_string: 'Ошибка авторизации' });

    const body = (await request.json()) as { params?: unknown };
    const p = asRecord(body.params);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    reportRequests.push({ params: p, headers });
    calls.push({ service: 'reports', method: String(p['ReportType'] ?? ''), params: p });

    const injected = takeFailure('reports', String(p['ReportType'] ?? ''), tokenOf(request));
    if (injected) return fault(injected, 400);

    // Заголовки режима — часть запроса, а не украшение: без processingMode
    // офлайн-отчёт не заказать, а без skipColumnHeader нечего разбирать.
    for (const required of ['processingmode', 'returnmoneyinmicros', 'skipcolumnheader']) {
      if (headers[required] === undefined) {
        return fault(
          { error_code: MISSING_PARAM, error_string: `Не задан заголовок ${required}` },
          400,
        );
      }
    }

    const reportType = String(p['ReportType'] ?? '') as ReportType;
    const fieldNames = asStrings(p['FieldNames']);
    const reportName = typeof p['ReportName'] === 'string' ? p['ReportName'] : '';
    const selection = asRecord(p['SelectionCriteria']);
    const from = String(selection['DateFrom'] ?? '');
    const to = String(selection['DateTo'] ?? '');

    if (!(reportType in DIMENSIONS) || fieldNames.length === 0 || reportName === '') {
      return fault(
        { error_code: MISSING_PARAM, error_string: 'Отсутствует обязательный параметр' },
        400,
      );
    }
    // DateFrom/DateTo обязательны ровно при CUSTOM_DATE и запрещены с остальными.
    if (p['DateRangeType'] === 'CUSTOM_DATE' && (from === '' || to === '')) {
      return fault(
        {
          error_code: MISSING_PARAM,
          error_string: 'Отсутствует обязательный параметр',
          error_detail: 'DateFrom/DateTo',
        },
        400,
      );
    }
    const unknownField = fieldNames.find(
      (f) => !DIMENSIONS[reportType].includes(f) && !METRICS.includes(f),
    );
    if (unknownField !== undefined) {
      return fault(
        {
          error_code: 8000,
          error_string: `Поле ${unknownField} недоступно в отчёте ${reportType}`,
        },
        400,
      );
    }

    // Офлайн-отчёт готовится не мгновенно: первый ответ — 201 «принят в очередь».
    if (headers['processingmode'] === 'offline') {
      const seen = offlinePolls.get(reportName) ?? 0;
      offlinePolls.set(reportName, seen + 1);
      if (seen === 0) {
        return new HttpResponse(null, {
          status: 201,
          headers: { ...HEADERS, retryIn: '1', reportsInQueue: '1' },
        });
      }
    }

    const source =
      reportType === 'SEARCH_QUERY_PERFORMANCE_REPORT' ? cabinet.queries : cabinet.facts;
    const tsv = buildReportTsv(source, reportType, fieldNames, from, to);
    return new HttpResponse(tsv, {
      status: 200,
      headers: { ...HEADERS, 'Content-Type': 'text/tab-separated-values; charset=utf-8' },
    });
  });

  return {
    // Порядок важен: msw берёт первый подошедший обработчик, а `:service`
    // поймал бы и `reports`.
    handlers: [reportHandler, jsonHandler],
    cabinetOf: (token) => {
      const found = byToken.get(token);
      if (!found) throw new Error(`в моке нет кабинета с токеном ${token}`);
      return found;
    },
    calls,
    reportRequests,
    fail: (rule) => failures.push({ ...rule }),
    clearFailures: () => failures.splice(0, failures.length),
    callsTo: (service) => calls.filter((c) => c.service === service),
  };
}
