import { StatEntityType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { startIngestionMocks, type IngestionMocks } from './support/ingestion-mocks.js';
import {
  BEFORE_WINDOW,
  createCabinet,
  EXPECTED_WINDOW_DAYS,
  IDS,
  METRIKA,
  seedIngestionClient,
  TOKENS,
  WINDOW_DAYS,
  WINDOW_FROM,
  WINDOW_TO,
} from './support/ingestion-seed.js';
import type { Cabinet } from './support/ingestion-yandex-mock.js';

import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import {
  runIngestion,
  runSearchQueryIngestion,
  syncEntities,
  syncStats,
  STATS_WINDOW_DAYS,
} from '@/ingestion/index.js';

/**
 * Загрузка статистики и поисковых запросов через настоящий сервис Reports.
 *
 * Мок отдаёт TSV, а не готовые объекты: разбор кавычек, `--` вместо значения,
 * деньги строкой и очередь офлайн-отчёта проходят целиком. Это и есть та часть
 * пути, которую юнит-тесты загрузки не видят — они начинаются уже с `StatRow`.
 */

const DAYS = EXPECTED_WINDOW_DAYS;

let clientId: string;
let cabinet: Cabinet;
let mocks: IngestionMocks;

function statsOf(entityType: StatEntityType, entityId: string) {
  return prisma.campaignStat.findMany({
    where: { entityType, entityId },
    orderBy: { date: 'asc' },
  });
}

async function campaignId(externalId: number): Promise<string> {
  const row = await prisma.campaign.findFirstOrThrow({
    where: { externalId: String(externalId) },
    select: { id: true },
  });
  return row.id;
}

async function adGroupId(externalId: number): Promise<string> {
  const row = await prisma.adGroup.findFirstOrThrow({
    where: { externalId: String(externalId) },
    select: { id: true },
  });
  return row.id;
}

describe('загрузка: статистика и поисковые запросы', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    cabinet = createCabinet();
    mocks = startIngestionMocks({
      yandex: { accounts: [{ accessToken: TOKENS.secondary, cabinet }], pageSize: 2 },
      metrika: { oauthToken: TOKENS.secondary, counterId: METRIKA.counterId, rows: [] },
    });

    // Метрика у клиента не настроена — это штатный путь, а не отказ.
    clientId = await seedIngestionClient({
      name: 'ООО «Кофемолка» (без Метрики)',
      tgUserId: 880_000_102n,
      accessToken: TOKENS.secondary,
    });
    await syncEntities(clientId, 'YANDEX_DIRECT');
  });

  afterAll(async () => {
    mocks?.close();
    await prisma.$disconnect();
  });

  it('скользящее окно: запрошен ровно 21 день, и лишние сутки в базу не попали', async () => {
    const result = await syncStats(clientId, 'YANDEX_DIRECT');

    // Ширина окна — требование ТЗ §2.1, а не деталь реализации: сузив его,
    // мы навсегда оставим в базе первую, заниженную версию дня.
    expect(STATS_WINDOW_DAYS).toBe(DAYS);
    expect(result).toMatchObject({ from: WINDOW_FROM, to: WINDOW_TO });
    // Окно включает сегодняшний неполный день: отчёт «сколько потрачено сегодня»
    // нужен раньше, чем наступит завтра.
    expect(WINDOW_DAYS).toHaveLength(DAYS);

    const requested = mocks.yandex.reportRequests.map(
      (r) => (r.params['SelectionCriteria'] as Record<string, unknown>) ?? {},
    );
    expect(requested.every((s) => s['DateFrom'] === WINDOW_FROM && s['DateTo'] === WINDOW_TO)).toBe(
      true,
    );

    const dates = await prisma.campaignStat.findMany({
      distinct: ['date'],
      select: { date: true },
      orderBy: { date: 'asc' },
    });
    const ymd = dates.map((d) => d.date.toISOString().slice(0, 10));
    expect(ymd).toHaveLength(DAYS);
    expect(ymd[0]).toBe(WINDOW_FROM);
    expect(ymd[ymd.length - 1]).toBe(WINDOW_TO);
    // Сутки за краем окна кабинет знает, но отчёт их не отдал — значит их нет и у нас.
    expect(ymd).not.toContain(BEFORE_WINDOW);
  });

  it('строки разложены по уровням, а цифры доехали из TSV без потерь', async () => {
    const search = await campaignId(IDS.search);
    const rows = await statsOf(StatEntityType.CAMPAIGN, search);
    expect(rows).toHaveLength(DAYS);

    // Кампания собирается из трёх объявлений: отчёт агрегирует по запрошенному
    // разрезу, и в колонку обязана лечь сумма, а не последняя строка.
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ impressions: 241, clicks: 14, conversions: 1 });
    expect(Number(last?.spend)).toBe(504.75);
    expect(Number(last?.ctr)).toBe(0.0581);
    expect(Number(last?.cpa)).toBe(504.75);

    expect(await prisma.campaignStat.count({ where: { entityType: 'CAMPAIGN' } })).toBe(2 * DAYS);
    expect(await prisma.campaignStat.count({ where: { entityType: 'ADGROUP' } })).toBe(3 * DAYS);
    expect(await prisma.campaignStat.count({ where: { entityType: 'AD' } })).toBe(4 * DAYS);
    // Фраз три: строки РСЯ приходят без критерия и привязать их не к чему.
    expect(await prisma.campaignStat.count({ where: { entityType: 'KEYWORD' } })).toBe(3 * DAYS);
  });

  it('строки без адреса видны в результате уровня, а не растворяются', async () => {
    const result = await syncStats(clientId, 'YANDEX_DIRECT');

    expect(result.levels.campaign).toEqual({ fetched: 2 * DAYS, written: 2 * DAYS, unresolved: 0 });
    // Показы автотаргетинга РСЯ приходят с `CriterionId = --`: фразы за ними нет
    // в принципе, и каждый прогон честно отбрасывает 21 строку из 84.
    expect(result.levels.keyword).toEqual({
      fetched: 4 * DAYS,
      written: 3 * DAYS,
      unresolved: DAYS,
    });
  });

  it('перезаливка тех же суток обновляет строки, а не задваивает их', async () => {
    const search = await campaignId(IDS.search);
    const before = await prisma.campaignStat.count();

    // Кабинет досчитал вчерашний день — ровно то, ради чего окно перезаливается.
    for (const fact of cabinet.facts) {
      if (fact.date === WINDOW_TO && fact.adId === IDS.adCore) {
        fact.clicks = 30;
        fact.cost = 900.5;
        fact.conversions = 4;
      }
    }

    await syncStats(clientId, 'YANDEX_DIRECT');

    expect(await prisma.campaignStat.count()).toBe(before);
    const rows = await statsOf(StatEntityType.CAMPAIGN, search);
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ clicks: 35, conversions: 4 });
    expect(Number(last?.spend)).toBe(1089.75);
    // CPA пересчитан от новых цифр, а не остался вчерашним.
    expect(Number(last?.cpa)).toBe(272.4375);
  });

  it('поисковые запросы: адресуются по группе, а безадресные попадают в сводку', async () => {
    const summary = await runSearchQueryIngestion({ clientId });

    expect(summary).toMatchObject({
      from: WINDOW_FROM,
      to: WINDOW_TO,
      targets: 1,
      ok: 1,
      // Три дня × три адресуемых запроса; четвёртый висит на удалённой группе.
      written: 9,
      unattributed: 3,
      failures: [],
    });

    const core = await adGroupId(IDS.groupCore);
    const rows = await prisma.searchQueryStat.findMany({
      where: { adGroupId: core },
      orderBy: [{ date: 'asc' }, { query: 'asc' }],
    });
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.query))).toEqual(
      new Set(['купить кофемашину недорого', 'кофемашина обои на рабочий стол']),
    );
    expect(rows.every((r) => r.negated === false)).toBe(true);

    // Отчёт по запросам формируется только офлайн: первый ответ — 201 «в очереди».
    const searchQueryPolls = mocks.yandex.reportRequests.filter(
      (r) => r.params['ReportType'] === 'SEARCH_QUERY_PERFORMANCE_REPORT',
    );
    expect(searchQueryPolls.length).toBeGreaterThanOrEqual(2);
    expect(searchQueryPolls.every((r) => r.headers['processingmode'] === 'offline')).toBe(true);
  });

  it('повторная загрузка запросов не снимает пометку `negated`', async () => {
    const core = await adGroupId(IDS.groupCore);
    const junk = 'кофемашина обои на рабочий стол';
    await prisma.searchQueryStat.updateMany({
      where: { adGroupId: core, query: junk },
      data: { negated: true },
    });

    // Кабинет досчитал показы по тому же запросу.
    for (const row of cabinet.queries) {
      if (row.query === junk) row.impressions = 999;
    }

    const summary = await runSearchQueryIngestion({ clientId });
    expect(summary.written).toBe(9);

    const rows = await prisma.searchQueryStat.findMany({ where: { adGroupId: core, query: junk } });
    expect(rows).toHaveLength(3);
    // Метрики обновились, пометка осталась: иначе минус-слово вернулось бы в работу.
    expect(rows.every((r) => r.impressions === 999)).toBe(true);
    expect(rows.every((r) => r.negated)).toBe(true);
  });

  it('ДЕФЕКТ: «нет данных» о конверсиях записывается как измеренный ноль', async () => {
    // У РСЯ-кампании цели не назначены, и Директ присылает в колонке Conversions
    // `--` — свой способ сказать «значения нет». `reportNumber` превращает `--`
    // в 0 (это документировано в `reports.ts`), поэтому до `aggregate` доезжает
    // конечное число, и `platformConversionSource` видит измеренную величину.
    //
    // Ветка `ConversionSource.NONE` при этом существует ровно ради обратного:
    // «отсутствие значения и измеренный ноль — разные вещи» (attribution.ts).
    // Через путь Директа она недостижима: кабинет без целей выглядит как кабинет,
    // где заявок нет, и сверка источников об этом молчит.
    const network = await campaignId(IDS.network);
    const rows = await statsOf(StatEntityType.CAMPAIGN, network);

    expect(rows.every((r) => r.conversions === 0)).toBe(true);
    expect(rows.every((r) => r.conversionSource === 'PLATFORM')).toBe(true);
    // Ни одной строки «источника нет» во всей базе — при том, что половина
    // кабинета конверсии не измеряет вовсе.
    expect(await prisma.campaignStat.count({ where: { conversionSource: 'NONE' } })).toBe(0);
  });

  it('полный прогон крона проходит без отказов, но прячет отброшенные строки', async () => {
    const summary = await runIngestion({ clientId });

    expect(summary).toMatchObject({
      from: WINDOW_FROM,
      to: WINDOW_TO,
      targets: 1,
      ok: 1,
      failures: [],
      // Метрика у клиента не настроена — это не отказ, конверсии просто остаются
      // площадочными.
      conversionsWritten: 0,
    });
    expect(summary.entitiesUpserted).toBe(2 + 3 + 4 + 3);
    expect(summary.statsWritten).toBe(2 * DAYS + 3 * DAYS + 4 * DAYS + 3 * DAYS);

    // ДЕФЕКТ (не блокирующий сценарий): 21 строка отчёта за прогон не легла
    // никуда, и в сводке крона этого не видно — ни поля, ни отказа. Единственный
    // след — `log.warn` внутри `writeLevel`. То же и с `orphaned` у сущностей.
    // См. отчёт: `IngestionRunSummary` не переносит `unresolved`/`orphaned`.
    expect(Object.keys(summary)).not.toContain('unresolved');
    expect(Object.keys(summary)).not.toContain('orphaned');
  });
});
