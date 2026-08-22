import { ConversionSource, StatEntityType, type PrismaClient } from '@prisma/client';

import type { DateRange } from '@/channels/types.js';
import type { MetrikaClientOptions, MetrikaGoalStat } from '@/clients/metrika.js';
import { MetrikaClient } from '@/clients/metrika.js';
import { env } from '@/env.js';
import {
  auditConversionSources,
  emptyAttribution,
  type AttributionSummary,
} from '@/ingestion/attribution.js';
import type { IngestionDeps } from '@/ingestion/deps.js';
import { resolveDeps } from '@/ingestion/deps.js';
import { ratioOrNull, SPEND_SCALE } from '@/ingestion/mapping.js';
import { STATS_WINDOW_DAYS, trailingWindowMsk, ymdToDateColumn } from '@/ingestion/window.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion:metrika' });

/** Метрика считает клики Директа, поэтому конверсии привязываются к его кампаниям. */
const PROVIDER = 'YANDEX_DIRECT' as const;

/** Тот же перечень, что принимает `MetrikaClient`: `satisfies` не даст ему разойтись. */
const ATTRIBUTIONS = [
  'LAST',
  'FIRST',
  'LASTSIGN',
  'LAST_YANDEX_DIRECT_CLICK',
] as const satisfies readonly NonNullable<MetrikaClientOptions['attribution']>[];

export interface MetrikaSettings {
  counterId: number;
  goalId: number;
  token: string;
  attribution?: MetrikaClientOptions['attribution'];
}

/** Колонки `Client`, в которых живёт настройка счётчика. */
export interface MetrikaClientConfig {
  metrikaCounterId: number | null;
  metrikaGoalId: number | null;
  metrikaAttribution: string | null;
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
  /** Кампаний-дней, приведённых к ответу Метрики: обнулённых или перемеченных. */
  zeroed: number;
  /** Строк, чью кампанию не удалось сопоставить с нашей БД. */
  unresolved: number;
  /**
   * Значения среза несопоставленных строк — до `UNRESOLVED_SAMPLE_LIMIT` штук.
   *
   * Счётчика мало: по одному числу нельзя отличить «Метрика помнит кампанию,
   * которой у нас нет» от «мы не разобрали имя собственной кампании», а
   * последствия у этих случаев разные. Значение среза называет случай прямо.
   */
  unresolvedSamples: string[];
  /**
   * Кампаний, выведенных из-под обнуления, потому что несопоставленная строка
   * могла принадлежать им.
   *
   * Ненулевое означает, что окно приведено к ответу Метрики не целиком, — и это
   * лучше, чем обнулить работающую кампанию за то, что мы не разобрали имя.
   */
  shielded: number;
  /**
   * Обнуление окна отменено, потому что ответ Метрики не лёг ни на одну кампанию.
   *
   * Обнуление по молчанию Метрики — задуманное поведение (см. докблок
   * `syncMetrikaConversions`), обнуление по неразобранному ответу — нет.
   */
  zeroingSuspended: boolean;
  /** Что реально лежит в колонке `conversions` у этого клиента за окно. */
  attribution: AttributionSummary;
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
 * Настройка счётчика читается из карточки клиента, токен — из секретов кабинета.
 *
 * Номер счётчика, цель и модель атрибуции секретом не являются: их называет
 * клиент на онбординге (`ai/onboarding/metrika-config.ts`), и лежать они должны
 * там, где их видно и можно поправить, — в `Client`.
 *
 * Токен остаётся в `Credential`: Метрика принимает тот же OAuth-токен Яндекса,
 * если приложению выдан доступ к статистике. Общий сервисный токен из окружения
 * — запасной вариант для кабинетов, где отдельного доступа нет.
 */
export function readMetrikaSettings(
  config: MetrikaClientConfig,
  credentials: Record<string, unknown>,
): MetrikaSettings | null {
  const counterId = num(config.metrikaCounterId);
  const goalId = num(config.metrikaGoalId);
  const token =
    str(credentials['metrikaToken']) ?? env.YANDEX_METRIKA_TOKEN ?? str(credentials['accessToken']);

  if (counterId === undefined || goalId === undefined || token === undefined) return null;

  const settings: MetrikaSettings = { counterId, goalId, token };
  const attribution = str(config.metrikaAttribution);
  if (attribution === undefined) return settings;

  if ((ATTRIBUTIONS as readonly string[]).includes(attribution)) {
    settings.attribution = attribution as MetrikaClientOptions['attribution'];
    return settings;
  }

  // Молчать нельзя: запрос уедет с умолчанием клиента (LASTSIGN), конверсии
  // приедут по другой модели, чем просил человек, и расхождение спишут на Метрику.
  log.warn(
    { counterId, goalId, attribution, known: ATTRIBUTIONS },
    'unknown value in Client.metrikaAttribution, falling back to the LASTSIGN default',
  );
  return settings;
}

/**
 * Ключи настройки счётчика в зашифрованном payload. Наш код их туда не пишет и
 * никогда не писал: схемы payload (`schemas/credentials.ts`, `yandexCredentialsSchema`)
 * выбрасывают всё постороннее, а продление токена перезаписывает payload целиком.
 * Проверка нужна для кабинета, куда счётчик вписали руками: молча игнорировать
 * такую настройку — значит оставить клиента без конверсий Метрики без единой
 * строчки в логе.
 */
const LEGACY_CONFIG_KEYS = [
  'metrikaCounterId',
  'metrika_counter_id',
  'metrikaGoalId',
  'metrika_goal_id',
] as const;

function hasLegacyConfig(credentials: Record<string, unknown>): boolean {
  return LEGACY_CONFIG_KEYS.some((key) => credentials[key] !== undefined);
}

/** Все группы цифр значения среза. Год в имени — такая же группа, как номер. */
const DIGIT_GROUPS = /\d+/gu;

/** Сколько несопоставленных значений показать человеку. Больше — это уже лог, а не сигнал. */
const UNRESOLVED_SAMPLE_LIMIT = 5;

export type DirectCampaignMatch =
  /** Ровно одна кампания клиента: строку можно записывать. */
  | { status: 'matched'; externalId: string }
  /** Кандидатов несколько, и все они наши: какой из них номер кампании — неизвестно. */
  | { status: 'ambiguous'; candidates: string[] }
  /** Ни один кандидат не совпал с кампанией клиента. */
  | { status: 'unmatched'; candidates: string[] };

/**
 * Кампания Директа для строки Метрики.
 *
 * Раньше номер выцарапывался из значения среза первой же группой цифр длиной
 * 4+, и на имени вида «Поиск — торты 2026 (Москва)» ею оказывался год. Строка
 * либо не сопоставлялась ни с чем, либо — хуже — сопоставлялась с чужой
 * кампанией, если у клиента нашлась кампания с таким номером.
 *
 * Поэтому решает не разбор строки, а сверка с кабинетом: из значения среза
 * берутся ВСЕ кандидаты — поле `id` (если Метрика его прислала) и каждая группа
 * цифр в имени, — и остаются те, что совпали с `externalId` уже загруженных
 * кампаний этого клиента. Год кампанией клиента не является и отсеивается сам,
 * гадать про формат значения не приходится, а неоднозначность («наших» совпало
 * несколько) честно называется неоднозначностью, а не берётся первой попавшейся.
 *
 * @needs-live-token формат значения на живом счётчике по-прежнему не проверен —
 * именно поэтому принимаются оба источника кандидатов сразу.
 */
export function directCampaignId(
  row: Pick<MetrikaGoalStat, 'campaignId' | 'campaignLabel'>,
  known: ReadonlySet<string>,
): DirectCampaignMatch {
  const candidates = campaignCandidates(row);
  const ours = candidates.filter((candidate) => known.has(candidate));
  const [first, second] = ours;

  if (first !== undefined && second === undefined) return { status: 'matched', externalId: first };
  if (second !== undefined) return { status: 'ambiguous', candidates: ours };
  return { status: 'unmatched', candidates };
}

function campaignCandidates(row: Pick<MetrikaGoalStat, 'campaignId' | 'campaignLabel'>): string[] {
  const candidates: string[] = [];
  const id = row.campaignId?.trim();
  if (id) candidates.push(id);
  const label = row.campaignLabel?.trim();
  if (label) candidates.push(...(label.match(DIGIT_GROUPS) ?? []));
  return [...new Set(candidates)];
}

/** Что показать в логе и в результате, когда строка не легла ни на одну кампанию. */
function unresolvedLabel(row: Pick<MetrikaGoalStat, 'campaignId' | 'campaignLabel'>): string {
  return row.campaignLabel ?? (row.campaignId !== undefined ? `#${row.campaignId}` : '(пусто)');
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
 *
 * У обнуления ровно одно основание — молчание Метрики про кампанию-день. Строка,
 * которую мы получили, но не смогли адресовать, таким основанием НЕ является:
 * раньше эти два случая были неразличимы, и достаточно было года в названии
 * кампании, чтобы её конверсии за всё окно уехали в ноль, CPA — в `null`, а
 * оптимизатор увидел «расход есть, конверсий нет» и снял кампанию с показов.
 * Поэтому несопоставленные строки считаются, попадают в лог и в результат, а
 * если не сопоставилась ни одна — обнуление за прогон отменяется целиком.
 *
 * Каждый прогон заканчивается сверкой источников по окну — в том числе когда
 * счётчик не настроен: единственность модели не должна держаться на том, что
 * шаги идут в правильном порядке и ни один из них не упал.
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
    unresolvedSamples: [],
    shielded: 0,
    zeroingSuspended: false,
    attribution: emptyAttribution(),
  };

  const campaigns = await deps.db.campaign.findMany({
    where: { clientId, provider: PROVIDER },
    select: { id: true, externalId: true },
  });
  const campaignIds = campaigns.map((c) => c.id);
  const audit = async (): Promise<AttributionSummary> =>
    reportMixedAttribution(clientId, await auditConversionSources(deps.db, campaignIds, range));

  const ctx = await deps.contextFor(clientId, PROVIDER);
  const config = await readClientConfig(deps.db, clientId);
  const settings = readMetrikaSettings(config, ctx.credentials);
  if (!settings) {
    if (hasLegacyConfig(ctx.credentials)) {
      log.warn(
        { clientId },
        'metrika counter/goal still lives in the encrypted credential payload: ' +
          'copy it to Client.metrikaCounterId/metrikaGoalId, conversions are not being updated',
      );
    } else {
      log.debug({ clientId }, 'metrika counter/goal is not configured for this client');
    }
    // Проверка нужна и здесь: клиент, у которого Метрику выключили, оставляет в
    // окне строки обеих моделей, и молчать об этом нельзя.
    return { ...base, configured: false, attribution: await audit() };
  }

  const source = (metrikaFor ?? defaultMetrikaSource)(settings);
  const rows = await source.getGoalConversions({
    goalId: settings.goalId,
    from: range.from,
    to: range.to,
    byCampaign: true,
  });

  const byExternalId = new Map(campaigns.map((c) => [c.externalId, c.id]));

  // Пустой ответ — почти всегда сбой на той стороне, а не «за три недели не
  // было ни одной конверсии». Обнулять по нему всё окно нельзя: это стёрло бы
  // конверсии Директа и обвалило бы отчёт клиента в ноль.
  if (rows.length === 0) {
    log.warn({ clientId, ...range }, 'metrika returned no rows at all, keeping stored conversions');
    return { ...base, configured: true, attribution: await audit() };
  }

  const { totals, unresolved, unresolvedSamples, shielded, blind } = groupByCampaignDate(
    rows,
    byExternalId,
  );
  const seen = { fetched: rows.length, unresolved, unresolvedSamples, shielded: shielded.size };

  if (unresolved > 0) {
    // Раньше несопоставленная строка не оставляла в логе ничего: счётчик уезжал
    // в результат прогона, а прогон в кроне никто не читает. Между тем именно
    // здесь видно и «кампанию переименовали», и «Метрика знает кампанию, которой
    // у нас нет», — и различить их можно только по самому значению среза.
    log.warn(
      { clientId, ...range, ...seen },
      'metrika rows were not matched to a campaign of this client',
    );
  }

  // Ни одна строка не легла на кампании клиента — та же ситуация, что и пустой
  // ответ: сопоставление сломано, и обнулять по нему окно нельзя. Разница только
  // в том, что здесь конверсии Метрика прислала, а адресовать их некуда.
  if (totals.length === 0 || blind) {
    log.warn(
      { clientId, ...range, ...seen },
      blind
        ? 'a metrika row named no campaign at all, keeping stored conversions'
        : 'no metrika row matched a campaign of this client, keeping stored conversions',
    );
    return {
      ...base,
      ...seen,
      configured: true,
      zeroingSuspended: true,
      attribution: await audit(),
    };
  }

  const written = await applyConversions(deps.db, totals);
  const zeroed = await zeroUnreported(
    deps.db,
    campaignIds.filter((id) => !shielded.has(id)),
    range,
    new Set(totals.map((t) => `${t.entityId} ${t.date}`)),
  );

  log.info(
    { clientId, ...range, written, zeroed, unresolved, shielded: shielded.size },
    'metrika conversions applied',
  );
  return {
    ...base,
    ...seen,
    configured: true,
    written,
    zeroed,
    attribution: await audit(),
  };
}

async function readClientConfig(db: PrismaClient, clientId: string): Promise<MetrikaClientConfig> {
  const row = await db.client.findUnique({
    where: { id: clientId },
    select: { metrikaCounterId: true, metrikaGoalId: true, metrikaAttribution: true },
  });
  return {
    metrikaCounterId: row?.metrikaCounterId ?? null,
    metrikaGoalId: row?.metrikaGoalId ?? null,
    metrikaAttribution: row?.metrikaAttribution ?? null,
  };
}

/**
 * Смешанная атрибуция — это не «странно», это неверные цифры в отчёте и в
 * оптимизаторе, поэтому она попадает и в лог, и в результат прогона.
 */
function reportMixedAttribution(clientId: string, summary: AttributionSummary): AttributionSummary {
  if (summary.mixed) {
    log.warn(
      { clientId, counts: summary.counts },
      'campaign stats mix attribution models: CPA of these campaigns is not comparable',
    );
  }
  return summary;
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

interface Grouped {
  totals: ConversionTotal[];
  unresolved: number;
  unresolvedSamples: string[];
  /**
   * Кампании, которые нельзя обнулять: несопоставленная строка называла их номер,
   * значит могла принадлежать любой из них.
   */
  shielded: Set<string>;
  /**
   * Хотя бы одна строка не дала ни номера, ни цифр в имени. Кому она принадлежит,
   * неизвестно вообще, поэтому вывести из-под обнуления некого — и обнулять окно
   * нельзя целиком.
   */
  blind: boolean;
}

/**
 * Разложить ответ Метрики по кампаниям-дням и понять, чего мы про него не знаем.
 *
 * Несопоставленные строки бывают трёх разных сортов, и путать их дорого:
 *
 * - строка назвала номера, и несколько из них — кампании этого клиента
 *   (`ambiguous`): адресовать нельзя, но круг подозреваемых известен, и каждый
 *   из них выводится из-под обнуления;
 * - строка назвала номера, и ни один не наш: это чужое или давно удалённое —
 *   штатное поведение Метрики, помнящей кампанию дольше кабинета. На обнуление
 *   остальных не влияет;
 * - строка не назвала ничего (`blind`): принадлежать она могла любой кампании
 *   клиента, вывести из-под обнуления некого — значит не обнуляем ничего.
 */
function groupByCampaignDate(
  rows: readonly MetrikaGoalStat[],
  byExternalId: Map<string, string>,
): Grouped {
  const byKey = new Map<string, ConversionTotal>();
  const known = new Set(byExternalId.keys());
  const samples = new Set<string>();
  const shielded = new Set<string>();
  let unresolved = 0;
  let blind = false;

  for (const row of rows) {
    const match = directCampaignId(row, known);
    const entityId = match.status === 'matched' ? byExternalId.get(match.externalId) : undefined;
    if (entityId === undefined) {
      unresolved += 1;
      if (samples.size < UNRESOLVED_SAMPLE_LIMIT) samples.add(unresolvedLabel(row));
      if (match.status === 'ambiguous') {
        for (const candidate of match.candidates) {
          const ours = byExternalId.get(candidate);
          if (ours !== undefined) shielded.add(ours);
        }
      } else if (match.status === 'unmatched' && match.candidates.length === 0) {
        blind = true;
      }
      continue;
    }
    const key = `${entityId} ${row.date}`;
    const total = byKey.get(key) ?? { entityId, date: row.date, conversions: 0 };
    total.conversions += row.conversions;
    byKey.set(key, total);
  }

  return {
    totals: [...byKey.values()],
    unresolved,
    unresolvedSamples: [...samples],
    shielded,
    blind,
  };
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
      conversionSource: ConversionSource.METRIKA,
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
 *
 * Источник у обнулённой строки — `METRIKA`, а не «источника нет»: ноль здесь
 * посчитан по модели Метрики ровно так же, как и любая её ненулевая цифра.
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
    },
    select: { entityId: true, date: true, conversions: true, conversionSource: true },
  });

  let zeroed = 0;
  for (const row of stale) {
    if (reported.has(`${row.entityId} ${row.date.toISOString().slice(0, 10)}`)) continue;
    // Уже приведена к ответу Метрики. Отбор по одному лишь `conversions != 0`
    // оставил бы нулевые строки Директа с площадочной пометкой — то самое
    // смешение моделей, ради устранения которого этот проход и написан.
    const consistent = row.conversions === 0 && row.conversionSource === ConversionSource.METRIKA;
    if (consistent) continue;
    await db.campaignStat.update({
      where: {
        entityType_entityId_date: {
          entityType: StatEntityType.CAMPAIGN,
          entityId: row.entityId,
          date: row.date,
        },
      },
      data: { conversions: 0, cpa: null, conversionSource: ConversionSource.METRIKA },
      select: { entityId: true },
    });
    zeroed += 1;
  }
  return zeroed;
}
