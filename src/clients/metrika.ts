import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';

import { METRIKA_BASE_URL } from '@/constants.js';
import { AppError, AuthError, RateLimitError } from '@/lib/errors.js';
import { withRetry } from '@/lib/retry.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'metrika' });

/**
 * Клиент Reporting API Яндекс Метрики.
 *
 * Нужен ровно для одного: достать конверсии по целям, чтобы считать CPA.
 * Директ отдаёт конверсии и сам, но только по целям, привязанным к кампании,
 * и с собственной моделью атрибуции — для сверки нужен независимый источник.
 */

/**
 * Значение среза. Кроме печатного имени Метрика кладёт сюда `id` справочника —
 * для среза кампании Директа это её номер, и он не требует разбора строки.
 *
 * `id` объявлен необязательным, потому что у среза даты его нет вовсе, а у
 * остальных срезов его наличие на живом счётчике не проверено (см.
 * `@needs-live-token` ниже). Схема с `passthrough` его и раньше пропускала —
 * просто никто не читал.
 */
const dimensionSchema = z
  .object({
    name: z.string().nullable(),
    id: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const metrikaResponseSchema = z.object({
  data: z.array(
    z.object({
      dimensions: z.array(dimensionSchema),
      metrics: z.array(z.number().nullable()),
    }),
  ),
  total_rows: z.number().optional(),
  // Метрика периодически добавляет поля — не роняем разбор из-за этого.
});

export interface MetrikaGoalStat {
  /** yyyy-MM-dd */
  date: string;
  /**
   * Печатное значение среза кампании Директа: то ли голый номер, то ли имя
   * кампании с номером внутри, то ли имя без номера вовсе. Не идентификатор —
   * сопоставлять по нему в лоб нельзя.
   */
  campaignLabel?: string;
  /**
   * Номер кампании Директа из поля `id` того же среза, когда Метрика его прислала.
   *
   * @needs-live-token наличие поля на живом счётчике не проверено. Поэтому оно
   * не заменяет разбор имени, а дополняет его: сопоставление ниже по течению
   * принимает оба варианта и выбирает тот, что совпал с кампанией клиента.
   */
  campaignId?: string;
  goalId: number;
  conversions: number;
  revenue: number;
}

export interface MetrikaClientOptions {
  oauthToken: string;
  counterId: number;
  /** Модель атрибуции. LSC (last significant click) — то, что использует Директ. */
  attribution?: 'LAST' | 'FIRST' | 'LASTSIGN' | 'LAST_YANDEX_DIRECT_CLICK';
}

/** Строк за запрос. Больше Метрика и не отдаст — дальше только пагинация. */
export const METRIKA_PAGE_LIMIT = 10_000;

/**
 * Потолок числа страниц.
 *
 * Нужен не ради экономии: срез «дата × кампания» за 21 день переваливает за
 * страницу примерно с 480 кампаний, и раньше хвост просто терялся — молча,
 * без единой записи в лог. Молчаливо потерянные конверсии хуже отказа: по ним
 * оптимизатор двигает бюджеты. Поэтому дочитываем до конца, а если данных
 * столько, что даже пагинация не справляется, — падаем с явной ошибкой.
 */
export const METRIKA_MAX_PAGES = 50;

type MetrikaRow = z.infer<typeof metrikaResponseSchema>['data'][number];

/**
 * `id` среза, если это номер. Всё остальное — `undefined`: у части срезов там
 * лежит строковый ключ справочника, и выдавать его за номер кампании нельзя.
 */
function numericId(raw: string | number | null | undefined): string | undefined {
  if (typeof raw === 'number')
    return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return /^[1-9]\d*$/.test(trimmed) ? trimmed : undefined;
}

function toGoalStats(
  rows: readonly MetrikaRow[],
  goalId: number,
  byCampaign: boolean,
): MetrikaGoalStat[] {
  return rows.flatMap((row): MetrikaGoalStat[] => {
    const date = row.dimensions[0]?.name;
    // Строки без даты бессмысленны для дневной статистики — отбрасываем явно.
    if (!date) return [];

    const campaign = byCampaign ? row.dimensions[1] : undefined;
    const stat: MetrikaGoalStat = {
      date,
      goalId,
      conversions: row.metrics[0] ?? 0,
      revenue: row.metrics[1] ?? 0,
    };
    if (campaign?.name) stat.campaignLabel = campaign.name;
    const campaignId = numericId(campaign?.id);
    if (campaignId !== undefined) stat.campaignId = campaignId;
    return [stat];
  });
}

export class MetrikaClient {
  private readonly http: AxiosInstance;
  private readonly counterId: number;
  private readonly attribution: string;

  constructor(opts: MetrikaClientOptions) {
    this.counterId = opts.counterId;
    this.attribution = opts.attribution ?? 'LASTSIGN';
    this.http = axios.create({
      baseURL: METRIKA_BASE_URL,
      timeout: 30_000,
      headers: { Authorization: `OAuth ${opts.oauthToken}` },
      // Ошибки разбираем сами, чтобы отличить 401 от 429.
      validateStatus: () => true,
    });
  }

  /**
   * Конверсии по цели в разрезе дат и кампаний Директа.
   *
   * Лимит базового аккаунта — 5000 запросов в сутки, поэтому период
   * запрашивается целиком, а не по дню; страницы дочитываются по `total_rows`.
   */
  async getGoalConversions(params: {
    goalId: number;
    from: string;
    to: string;
    byCampaign?: boolean;
  }): Promise<MetrikaGoalStat[]> {
    const { goalId, from, to, byCampaign = true } = params;

    const rows: MetrikaGoalStat[] = [];
    let received = 0;
    let total: number | undefined;

    for (let page = 1; ; page += 1) {
      // Метрика считает смещение от единицы, а не от нуля.
      const data = await this.fetchPage({ goalId, from, to, byCampaign, offset: received + 1 });
      total = data.total_rows ?? total;
      received += data.data.length;
      rows.push(...toGoalStats(data.data, goalId, byCampaign));

      const full = data.data.length >= METRIKA_PAGE_LIMIT;
      if (!full || (total !== undefined && received >= total)) break;

      // Обрыв на середине хуже отказа: недостающие кампании-дни уедут в отчёт
      // и в оптимизатор как нули. Про заведомо неподъёмный срез узнаём сразу по
      // `total_rows`, не выкачивая полсотни страниц впустую.
      const budget = METRIKA_PAGE_LIMIT * METRIKA_MAX_PAGES;
      if (page >= METRIKA_MAX_PAGES || (total !== undefined && total > budget)) {
        throw new AppError('Metrika response does not fit into the page budget', {
          code: 'METRIKA_TOO_MANY_ROWS',
          context: { counterId: this.counterId, received, total, pages: page, budget },
        });
      }
    }

    log.debug(
      { goalId, from, to, rows: rows.length, received, total },
      'fetched metrika goal conversions',
    );
    return rows;
  }

  private async fetchPage(params: {
    goalId: number;
    from: string;
    to: string;
    byCampaign: boolean;
    offset: number;
  }): Promise<z.infer<typeof metrikaResponseSchema>> {
    const { goalId, from, to, byCampaign, offset } = params;
    const query = {
      ids: String(this.counterId),
      metrics: `ym:s:goal${goalId}reaches,ym:s:goal${goalId}revenue`,
      dimensions: byCampaign ? 'ym:s:date,ym:s:lastsignDirectClickOrder' : 'ym:s:date',
      date1: from,
      date2: to,
      attribution: this.attribution,
      accuracy: 'full',
      limit: String(METRIKA_PAGE_LIMIT),
      offset: String(offset),
    };

    return withRetry(
      async () => {
        const res = await this.http.get('', { params: query });

        if (res.status === 401 || res.status === 403) {
          throw new AuthError('YANDEX_DIRECT', 'Metrika rejected the OAuth token', {
            status: res.status,
            counterId: this.counterId,
          });
        }
        if (res.status === 429) {
          throw new RateLimitError('YANDEX_DIRECT', 60_000, { counterId: this.counterId });
        }
        if (res.status >= 500) {
          throw new AppError(`Metrika ${res.status}`, {
            code: 'METRIKA_5XX',
            retryable: true,
            context: { status: res.status },
          });
        }
        if (res.status !== 200) {
          throw new AppError(`Metrika request failed: ${res.status}`, {
            code: 'METRIKA_BAD_REQUEST',
            context: { status: res.status, body: res.data },
          });
        }

        const parsed = metrikaResponseSchema.safeParse(res.data);
        if (!parsed.success) {
          throw new AppError('Unexpected Metrika response shape', {
            code: 'METRIKA_SCHEMA',
            context: { issues: parsed.error.issues.slice(0, 5) },
          });
        }
        return parsed.data;
      },
      { label: 'metrika.getGoalConversions', attempts: 3, baseMs: 2000 },
    );
  }

  /** Список целей счётчика — используется на онбординге, чтобы человек выбрал целевую. */
  async listGoals(): Promise<Array<{ id: number; name: string }>> {
    const res = await this.http.get(
      `https://api-metrika.yandex.net/management/v1/counter/${this.counterId}/goals`,
      { baseURL: '' },
    );
    if (res.status === 401 || res.status === 403) {
      throw new AuthError('YANDEX_DIRECT', 'Metrika rejected the OAuth token', {
        status: res.status,
      });
    }
    if (res.status !== 200) {
      throw new AppError(`Metrika goals request failed: ${res.status}`, {
        code: 'METRIKA_BAD_REQUEST',
        context: { status: res.status },
      });
    }
    const schema = z.object({
      goals: z.array(z.object({ id: z.number(), name: z.string() }).passthrough()),
    });
    const parsed = schema.safeParse(res.data);
    if (!parsed.success) {
      throw new AppError('Unexpected Metrika goals response', { code: 'METRIKA_SCHEMA' });
    }
    return parsed.data.goals.map((g) => ({ id: g.id, name: g.name }));
  }
}
