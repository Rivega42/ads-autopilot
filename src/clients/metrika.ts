import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';

import { METRIKA_BASE_URL } from '@/constants.js';
import { AppError, AuthError, RateLimitError } from '@/lib/errors.js';
import { withRetry } from '@/lib/retry.js';
import { scoped } from '@/logger.js';

const log = scoped('metrika');

/**
 * Клиент Reporting API Яндекс Метрики.
 *
 * Нужен ровно для одного: достать конверсии по целям, чтобы считать CPA.
 * Директ отдаёт конверсии и сам, но только по целям, привязанным к кампании,
 * и с собственной моделью атрибуции — для сверки нужен независимый источник.
 */

const metrikaResponseSchema = z.object({
  data: z.array(
    z.object({
      dimensions: z.array(z.object({ name: z.string().nullable() }).passthrough()),
      metrics: z.array(z.number().nullable()),
    }),
  ),
  total_rows: z.number().optional(),
  // Метрика периодически добавляет поля — не роняем разбор из-за этого.
});

export interface MetrikaGoalStat {
  /** yyyy-MM-dd */
  date: string;
  /** ID кампании Директа, если срез запрошен по нему. */
  campaignExternalId?: string;
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
   * Лимит базового аккаунта — 5000 запросов в сутки, поэтому запрашиваем
   * сразу весь период одним вызовом, а не по дню.
   */
  async getGoalConversions(params: {
    goalId: number;
    from: string;
    to: string;
    byCampaign?: boolean;
  }): Promise<MetrikaGoalStat[]> {
    const { goalId, from, to, byCampaign = true } = params;

    const dimensions = byCampaign ? 'ym:s:date,ym:s:lastsignDirectClickOrder' : 'ym:s:date';

    const query = {
      ids: String(this.counterId),
      metrics: `ym:s:goal${goalId}reaches,ym:s:goal${goalId}revenue`,
      dimensions,
      date1: from,
      date2: to,
      attribution: this.attribution,
      accuracy: 'full',
      limit: '10000',
    };

    const data = await withRetry(
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

    const rows = data.data.flatMap((row): MetrikaGoalStat[] => {
      const date = row.dimensions[0]?.name;
      // Строки без даты бессмысленны для дневной статистики — отбрасываем явно.
      if (!date) return [];

      const campaign = byCampaign ? row.dimensions[1]?.name : undefined;
      const stat: MetrikaGoalStat = {
        date,
        goalId,
        conversions: row.metrics[0] ?? 0,
        revenue: row.metrics[1] ?? 0,
      };
      if (campaign) stat.campaignExternalId = campaign;
      return [stat];
    });

    log.debug({ goalId, from, to, rows: rows.length }, 'fetched metrika goal conversions');
    return rows;
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
