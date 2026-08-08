import { StatEntityType, type PrismaClient } from '@prisma/client';

import type { DateRange } from '@/channels/types.js';
import type { MetrikaClientOptions, MetrikaGoalStat } from '@/clients/metrika.js';
import { MetrikaClient } from '@/clients/metrika.js';
import { env } from '@/env.js';
import type { IngestionDeps } from '@/ingestion/deps.js';
import { resolveDeps } from '@/ingestion/deps.js';
import { ratioOrNull, SPEND_SCALE } from '@/ingestion/mapping.js';
import { STATS_WINDOW_DAYS, trailingWindowMsk, ymdToDateColumn } from '@/ingestion/window.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:metrika' });

/** Метрика считает клики Директа, поэтому конверсии привязываются к его кампаниям. */
const PROVIDER = 'YANDEX_DIRECT' as const;

const ATTRIBUTIONS = ['LAST', 'FIRST', 'LASTSIGN', 'LAST_YANDEX_DIRECT_CLICK'] as const;

export interface MetrikaSettings {
  counterId: number;
  goalId: number;
  token: string;
  attribution?: MetrikaClientOptions['attribution'];
}

export interface MetrikaSource {
  getGoalConversions(params: {
    goalId: number;
    from: string;
    to: string;
    byCampaign?: boolean;
  }): Promise<MetrikaGoalStat[]>;
}

export interface MetrikaSyncResult {
  clientId: string;
  from: string;
  to: string;
  /** У клиента настроены счётчик и цель. */
  configured: boolean;
  fetched: number;
  written: number;
  /** Кампаний-дней, обнулённых из-за отсутствия в ответе Метрики. */
  zeroed: number;
  /** Строк, чью кампанию не удалось сопоставить с нашей БД. */
  unresolved: number;
}

export interface SyncMetrikaOptions extends Partial<IngestionDeps> {
  range?: DateRange;
  metrikaFor?: (settings: MetrikaSettings) => MetrikaSource;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Настройки Метрики лежат в секретах кабинета Директа: отдельного провайдера
 * под счётчик в схеме нет, а OAuth-токен у них общий — Метрика принимает тот же
 * токен Яндекса, если у приложения выдан доступ к статистике.
 */
export function readMetrikaSettings(credentials: Record<string, unknown>): MetrikaSettings | null {
  const counterId = num(credentials['metrikaCounterId'] ?? credentials['metrika_counter_id']);
  const goalId = num(credentials['metrikaGoalId'] ?? credentials['metrika_goal_id']);
  const token =
    str(credentials['metrikaToken']) ?? env.YANDEX_METRIKA_TOKEN ?? str(credentials['accessToken']);

  if (counterId === undefined || goalId === undefined || token === undefined) return null;

  const settings: MetrikaSettings = { counterId, goalId, token };
  const attribution = str(credentials['metrikaAttribution']);
  if (attribution && (ATTRIBUTIONS as readonly string[]).includes(attribution)) {
    settings.attribution = attribution as MetrikaClientOptions['attribution'];
  }
  return settings;
}

/**
 * Идентификатор кампании Директа из значения среза `ym:s:lastsignDirectClickOrder`.
 *
 * @needs-live-token формат значения не проверен на живом счётчике: Метрика
 * отдаёт то чистый номер, то номер внутри человекочитаемого имени. Разбираем
 * оба варианта; всё остальное честно считаем несопоставленным, а не гадаем.
 */
export function directCampaignId(dimension: string | undefined): string | undefined {
  if (!dimension) return undefined;
  const trimmed = dimension.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return /(\d{4,})/.exec(trimmed)?.[1];
}

/**
 * Проставляет конверсии из Метрики в `CampaignStat`.
 *
 * Запускается ПОСЛЕ `syncStats` и перекрывает конверсии, посчитанные самим
 * Директом: у площадки своя модель атрибуции и свой набор целей, а считать CPA
 * нужно по той цели, которую клиент назвал целевой. Колонка `conversions` одна,
 * поэтому источник должен быть один — и это Метрика, когда она настроена.
 *
 * «Один источник» означает и обратное: кампании-дни, которых нет в ответе
 * Метрики, обнуляются. Метрика возвращает только строки с достижениями цели,
 * поэтому её молчание про кампанию — это ноль по её модели, а не «нет данных».
 * Раньше в таких строках оставалась цифра Директа: в одной колонке жили две
 * модели атрибуции, отчёт складывал их в CPA, которого не существует ни в
 * одной из них, а оптимизатор перекладывал бюджет на кампанию просто за то,
 * что её не оказалось в ответе Метрики.
 */
export async function syncMetrikaConversions(
  clientId: string,
  options: SyncMetrikaOptions = {},
): Promise<MetrikaSyncResult> {
  const { range: explicitRange, metrikaFor, ...depsPatch } = options;
  const deps = resolveDeps(depsPatch);
  const range = explicitRange ?? trailingWindowMsk(STATS_WINDOW_DAYS, deps.now());
  const base = {
    clientId,
    from: range.from,
    to: range.to,
    fetched: 0,
    written: 0,
    zeroed: 0,
    unresolved: 0,
  };

  const ctx = await deps.contextFor(clientId, PROVIDER);
  const settings = readMetrikaSettings(ctx.credentials);
  if (!settings) {
    log.debug({ clientId }, 'metrika counter/goal is not configured for this client');
    return { ...base, configured: false };
  }

  const source = (metrikaFor ?? defaultMetrikaSource)(settings);
  const rows = await source.getGoalConversions({
    goalId: settings.goalId,
    from: range.from,
    to: range.to,
    byCampaign: true,
  });

  const campaigns = await deps.db.campaign.findMany({
    where: { clientId, provider: PROVIDER },
    select: { id: true, externalId: true },
  });
  const byExternalId = new Map(campaigns.map((c) => [c.externalId, c.id]));

  // Пустой ответ — почти всегда сбой на той стороне, а не «за три недели не
  // было ни одной конверсии». Обнулять по нему всё окно нельзя: это стёрло бы
  // конверсии Директа и обвалило бы отчёт клиента в ноль.
  if (rows.length === 0) {
    log.warn({ clientId, ...range }, 'metrika returned no rows at all, keeping stored conversions');
    return { ...base, configured: true };
  }

  const { totals, unresolved } = groupByCampaignDate(rows, byExternalId);
  const written = await applyConversions(deps.db, totals);
  const zeroed = await zeroUnreported(
    deps.db,
    campaigns.map((c) => c.id),
    range,
    new Set(totals.map((t) => `${t.entityId} ${t.date}`)),
  );

  log.info({ clientId, ...range, written, zeroed, unresolved }, 'metrika conversions applied');
  return { ...base, configured: true, fetched: rows.length, written, zeroed, unresolved };
}

function defaultMetrikaSource(settings: MetrikaSettings): MetrikaSource {
  const opts: MetrikaClientOptions = {
    oauthToken: settings.token,
    counterId: settings.counterId,
  };
  if (settings.attribution) opts.attribution = settings.attribution;
  return new MetrikaClient(opts);
}

interface ConversionTotal {
  entityId: string;
  date: string;
  conversions: number;
}

function groupByCampaignDate(
  rows: readonly MetrikaGoalStat[],
  byExternalId: Map<string, string>,
): { totals: ConversionTotal[]; unresolved: number } {
  const byKey = new Map<string, ConversionTotal>();
  let unresolved = 0;

  for (const row of rows) {
    const externalId = directCampaignId(row.campaignExternalId);
    const entityId = externalId ? byExternalId.get(externalId) : undefined;
    if (!entityId) {
      unresolved += 1;
      continue;
    }
    const key = `${entityId} ${row.date}`;
    const total = byKey.get(key) ?? { entityId, date: row.date, conversions: 0 };
    total.conversions += row.conversions;
    byKey.set(key, total);
  }

  return { totals: [...byKey.values()], unresolved };
}

/**
 * CPA пересчитывается от уже записанного расхода: сама Метрика денег Директа не
 * знает, а оставить старое значение рядом с новыми конверсиями — значит
 * показать оптимизатору CPA, которого не существует.
 */
async function applyConversions(db: PrismaClient, totals: ConversionTotal[]): Promise<number> {
  if (totals.length === 0) return 0;

  const existing = await db.campaignStat.findMany({
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: { in: [...new Set(totals.map((t) => t.entityId))] },
      date: { in: [...new Set(totals.map((t) => t.date))].map(ymdToDateColumn) },
    },
    select: { entityId: true, date: true, spend: true },
  });
  const spendByKey = new Map(
    existing.map((row) => [
      `${row.entityId} ${row.date.toISOString().slice(0, 10)}`,
      Number(row.spend),
    ]),
  );

  let written = 0;
  for (const total of totals) {
    const conversions = Math.round(total.conversions);
    const spend = spendByKey.get(`${total.entityId} ${total.date}`) ?? 0;
    const data = {
      conversions,
      cpa: spend > 0 ? ratioOrNull(spend, conversions, SPEND_SCALE) : null,
    };
    await db.campaignStat.upsert({
      where: {
        entityType_entityId_date: {
          entityType: StatEntityType.CAMPAIGN,
          entityId: total.entityId,
          date: ymdToDateColumn(total.date),
        },
      },
      create: {
        entityType: StatEntityType.CAMPAIGN,
        entityId: total.entityId,
        date: ymdToDateColumn(total.date),
        ...data,
      },
      update: data,
      select: { entityId: true },
    });
    written += 1;
  }
  return written;
}

/**
 * Обнуляет конверсии там, где Метрика промолчала.
 *
 * Без этого прохода колонка `conversions` остаётся смесью двух моделей
 * атрибуции: у кампаний из ответа — Метрика, у остальных — Директ. Сравнивать
 * такие CPA между собой нельзя, а именно это и делают отчёт и оптимизатор.
 * CPA обнуляемой строки сбрасывается в `null`: делить расход не на что.
 */
async function zeroUnreported(
  db: PrismaClient,
  campaignIds: readonly string[],
  range: DateRange,
  reported: ReadonlySet<string>,
): Promise<number> {
  if (campaignIds.length === 0) return 0;

  const stale = await db.campaignStat.findMany({
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: { in: [...campaignIds] },
      date: { gte: ymdToDateColumn(range.from), lte: ymdToDateColumn(range.to) },
      conversions: { not: 0 },
    },
    select: { entityId: true, date: true },
  });

  let zeroed = 0;
  for (const row of stale) {
    if (reported.has(`${row.entityId} ${row.date.toISOString().slice(0, 10)}`)) continue;
    await db.campaignStat.update({
      where: {
        entityType_entityId_date: {
          entityType: StatEntityType.CAMPAIGN,
          entityId: row.entityId,
          date: row.date,
        },
      },
      data: { conversions: 0, cpa: null },
      select: { entityId: true },
    });
    zeroed += 1;
  }
  return zeroed;
}
