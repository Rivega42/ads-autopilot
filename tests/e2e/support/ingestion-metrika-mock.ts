import { http, HttpResponse, type HttpHandler } from 'msw';

/** Совпадает с `METRIKA_BASE_URL` (`src/constants.ts`). */
export const METRIKA_URL = 'https://api-metrika.yandex.net/stat/v1/data';

/**
 * Мок Reporting API Метрики, ведущий себя как протокол.
 *
 * Правила, ради которых он написан:
 *  • токен обязателен и приходит в виде `Authorization: OAuth <token>`;
 *    чужой — 403 в той форме, которую разбирает `MetrikaClient`;
 *  • `ids`, `metrics`, `dimensions`, `date1`, `date2` обязательны: без любого из
 *    них ответ 400, а не пустой массив;
 *  • метрика запрашивается по конкретной цели (`ym:s:goal<N>reaches`), и мок
 *    отдаёт достижения ИМЕННО этой цели: подстановка чужого goalId обязана
 *    приводить к нулям, а не к «каким-нибудь» конверсиям;
 *  • период соблюдается: строки вне `date1..date2` не возвращаются;
 *  • Метрика присылает только те кампании-дни, где цель достигалась. Её молчание
 *    про кампанию — это ноль, и именно на этом стоит перезапись конверсий;
 *  • срез по кампании Директа приходит человекочитаемым именем, внутри которого
 *    зашит номер, — см. `directCampaignId`.
 */

export interface MetrikaGoalRow {
  date: string;
  /** Идентификатор кампании Директа. */
  campaignId: number;
  goalId: number;
  conversions: number;
  revenue?: number;
}

export interface MetrikaMockOptions {
  oauthToken: string;
  counterId: number;
  rows: MetrikaGoalRow[];
  /** Как Метрика печатает срез `ym:s:lastsignDirectClickOrder`. */
  campaignLabel?: (campaignId: number) => string;
}

export interface MetrikaMock {
  handlers: HttpHandler[];
  rows: MetrikaGoalRow[];
  /** Параметры каждого запроса — по ним видно окно, цель и модель атрибуции. */
  requests: Array<Record<string, string>>;
  /** Ответить ошибкой на следующие `times` запросов. */
  fail(status: number, times?: number): void;
}

const REQUIRED = ['ids', 'metrics', 'dimensions', 'date1', 'date2'] as const;

/** `ym:s:goal4242reaches,ym:s:goal4242revenue` → 4242. */
function goalIdOf(metrics: string): number | null {
  const match = /^ym:s:goal(\d+)reaches$/.exec(metrics.split(',')[0] ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function createMetrikaMock(options: MetrikaMockOptions): MetrikaMock {
  const { oauthToken, counterId, rows } = options;
  const label = options.campaignLabel ?? ((id: number) => `Кампания №${id}`);
  const requests: Array<Record<string, string>> = [];
  let failStatus: number | null = null;
  let failTimes = 0;

  const handler = http.get(METRIKA_URL, ({ request }) => {
    const url = new URL(request.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    requests.push(query);

    if (request.headers.get('Authorization') !== `OAuth ${oauthToken}`) {
      return HttpResponse.json(
        { errors: [{ error_type: 'invalid_token', message: 'Invalid oauth_token' }], code: 403 },
        { status: 403 },
      );
    }

    if (failStatus !== null && failTimes > 0) {
      failTimes -= 1;
      const status = failStatus;
      if (failTimes === 0) failStatus = null;
      return HttpResponse.json(
        { errors: [{ error_type: 'backend_error', message: 'Metrika is unavailable' }] },
        { status },
      );
    }

    const missing = REQUIRED.find((key) => query[key] === undefined || query[key] === '');
    if (missing !== undefined) {
      return HttpResponse.json(
        {
          errors: [{ error_type: 'missing_parameter', message: `Parameter '${missing}' required` }],
          code: 400,
          message: `Parameter '${missing}' required`,
        },
        { status: 400 },
      );
    }
    if (query['ids'] !== String(counterId)) {
      return HttpResponse.json(
        {
          errors: [{ error_type: 'access_denied', message: 'No access to the counter' }],
          code: 403,
        },
        { status: 403 },
      );
    }

    const goalId = goalIdOf(query['metrics'] ?? '');
    const byCampaign = (query['dimensions'] ?? '').includes('lastsignDirectClickOrder');
    const from = query['date1'] ?? '';
    const to = query['date2'] ?? '';

    const matching = rows.filter(
      (row) => row.goalId === goalId && row.date >= from && row.date <= to,
    );

    const limit = Number(query['limit'] ?? 10_000) || 10_000;
    // Метрика считает смещение от единицы, а не от нуля.
    const offset = Math.max(Number(query['offset'] ?? 1) || 1, 1) - 1;
    const page = matching.slice(offset, offset + limit);

    return HttpResponse.json({
      query,
      data: page.map((row) => ({
        dimensions: byCampaign
          ? [{ name: row.date }, { name: label(row.campaignId) }]
          : [{ name: row.date }],
        metrics: [row.conversions, row.revenue ?? 0],
      })),
      total_rows: matching.length,
      total_rows_rounded: false,
      sampled: false,
    });
  });

  return {
    handlers: [handler],
    rows,
    requests,
    fail: (status, times = 1) => {
      failStatus = status;
      failTimes = times;
    },
  };
}
