import { ConversionSource } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addCounts,
  comparableCpa,
  emptyCounts,
  summarizeAttribution,
} from '../../web/lib/attribution.js';
import { parseFilters } from '../../web/lib/filters.js';
import { NO_VALUE, formatMoneyPrecise } from '../../web/lib/format.js';
import { cpa, ctr } from '../../web/lib/metrics.js';
import type { CampaignRow, ClientRow } from '../../web/lib/queries.js';
import {
  getCampaign,
  getCampaignDaily,
  listCampaigns,
  listClients,
} from '../../web/lib/queries.js';

import {
  dashboardFilters,
  disconnectDashboardPrisma,
  expectRenderable,
  renderTotals,
} from './support/dashboard-checks.js';
import {
  BIG_MONEY_CPA,
  BIG_MONEY_SPEND,
  CLIENT_NAMES,
  FLIGHT_TOTALS,
  KOPEIKI_CPA,
  KOPEIKI_SPEND,
  PARTIAL_CPA,
  PARTIAL_TOTALS,
  PERIOD_DAYS,
  PERIOD_FROM,
  PERIOD_TO,
  RETARGET_TOTALS,
  SEARCH_CPA,
  SEARCH_CTR,
  SEARCH_DAILY_BUDGET,
  SEARCH_DAYS,
  SEARCH_TARGET_CPA,
  SEARCH_TOTALS,
  seedDashboard,
  type SeededDashboard,
} from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Витрина против живого Postgres.
 *
 * Единственный модуль проекта, у которого не было ни одной проверки на настоящих
 * данных: 71 юнит-тест стоит на чистых функциях, а весь риск дашборда — в
 * `groupBy`, суммах `Decimal` и делении на ноль, то есть ровно там, куда чистые
 * функции не достают.
 */

let seeded: SeededDashboard;

function campaignByName(rows: readonly CampaignRow[], name: string): CampaignRow {
  const row = rows.find((candidate) => candidate.name === name);
  if (!row)
    throw new Error(`кампании «${name}» нет в выдаче: ${rows.map((r) => r.name).join(', ')}`);
  return row;
}

function clientByName(rows: readonly ClientRow[], name: string): ClientRow {
  const row = rows.find((candidate) => candidate.name === name);
  if (!row)
    throw new Error(`клиента «${name}» нет в выдаче: ${rows.map((r) => r.name).join(', ')}`);
  return row;
}

beforeAll(async () => {
  await resetDatabase();
  seeded = await seedDashboard();
});

afterAll(async () => {
  await disconnectDashboardPrisma();
  await prisma.$disconnect();
});

describe('дашборд: итоги за период', () => {
  it('заявленные суммы совпадают с рядами, которые легли в базу', () => {
    // Страховка от арифметической описки в самом сценарии: константы из
    // `dashboard-seed.ts` пересчитываются из тех же рядов, но целыми копейками.
    const impressions = SEARCH_DAYS.reduce((sum, day) => sum + day.impressions, 0);
    const clicks = SEARCH_DAYS.reduce((sum, day) => sum + day.clicks, 0);
    const conversions = SEARCH_DAYS.reduce((sum, day) => sum + day.conversions, 0);
    const spendKopecks = SEARCH_DAYS.reduce(
      (sum, day) => sum + Math.round(Number(day.spend) * 100),
      0,
    );

    expect(impressions).toBe(SEARCH_TOTALS.impressions);
    expect(clicks).toBe(SEARCH_TOTALS.clicks);
    expect(conversions).toBe(SEARCH_TOTALS.conversions);
    expect(spendKopecks).toBe(Math.round(SEARCH_TOTALS.spend * 100));
  });

  it('строка кампании: показы, клики, расход, конверсии, CTR и CPA сходятся с базой', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const search = campaignByName(rows, 'Поиск — доставка');

    expect(search.totals.impressions).toBe(SEARCH_TOTALS.impressions);
    expect(search.totals.clicks).toBe(SEARCH_TOTALS.clicks);
    expect(search.totals.conversions).toBe(SEARCH_TOTALS.conversions);
    expect(search.totals.spend).toBeCloseTo(SEARCH_TOTALS.spend, 4);
    expect(search.totals.cpa).toBeCloseTo(SEARCH_CPA, 6);
    expect(search.totals.ctr).toBeCloseTo(SEARCH_CTR, 12);

    // CPA и CTR не «какое-то число», а именно расход/конверсии и клики/показы.
    expect(search.totals.cpa).toBeCloseTo(SEARCH_TOTALS.spend / SEARCH_TOTALS.conversions, 6);
    expect(search.totals.ctr).toBeCloseTo(SEARCH_TOTALS.clicks / SEARCH_TOTALS.impressions, 12);

    expectRenderable('campaign:search', search);
  });

  it('дневной ряд карточки даёт те же итоги, что групповая сумма в списке', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const search = campaignByName(rows, 'Поиск — доставка');

    const daily = await getCampaignDaily(seeded.campaignIds.search, PERIOD_FROM, PERIOD_TO);
    const summed = daily.reduce(
      (accumulator, row) => ({
        impressions: accumulator.impressions + row.impressions,
        clicks: accumulator.clicks + row.clicks,
        spend: accumulator.spend + row.spend,
        conversions: accumulator.conversions + row.conversions,
      }),
      { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
    );

    expect(summed.impressions).toBe(search.totals.impressions);
    expect(summed.clicks).toBe(search.totals.clicks);
    expect(summed.conversions).toBe(search.totals.conversions);
    // Карточка складывает дни в JS, список — в Postgres. Расхождение допустимо
    // только ниже копейки: иначе две страницы покажут человеку разные деньги.
    expect(Math.abs(summed.spend - (search.totals.spend ?? 0))).toBeLessThan(0.005);
    expect(formatMoneyPrecise(summed.spend)).toBe(formatMoneyPrecise(search.totals.spend));
  });

  it('строки групп, объявлений и фраз с тем же entityId в сумму кампании не попадают', async () => {
    // В базе рядом с кампанийными лежат ADGROUP/AD/KEYWORD-строки с тем же
    // entityId и заведомо огромными числами (см. writePolymorphicNoise).
    const noise = await prisma.campaignStat.count({
      where: { entityId: seeded.campaignIds.search, entityType: { not: 'CAMPAIGN' } },
    });
    expect(noise).toBe(3);

    const rows = await listCampaigns(dashboardFilters());
    const search = campaignByName(rows, 'Поиск — доставка');

    expect(search.totals.impressions).toBe(SEARCH_TOTALS.impressions);
    // Шум помечен METRIKA — протечка сделала бы выборку ещё и «смешанной».
    expect(search.totals.attribution.mixed).toBe(false);
    expect(search.totals.attribution.primary).toBe(ConversionSource.PLATFORM);
  });

  it('строка клиента складывает его кампании и показывает подключённые каналы', async () => {
    const rows = await listClients(dashboardFilters());
    const flight = clientByName(rows, CLIENT_NAMES.flight);

    expect(flight.campaignCount).toBe(2);
    expect(flight.activeCampaignCount).toBe(1);
    expect(flight.tgUsername).toBe('flight_ads');
    // TIKTOK_ADS пришёл из Credential: кабинет подключён, кампаний в нём ещё нет.
    expect([...flight.channels].sort()).toEqual(['TIKTOK_ADS', 'VK_ADS', 'YANDEX_DIRECT']);

    expect(flight.totals.impressions).toBe(FLIGHT_TOTALS.impressions);
    expect(flight.totals.clicks).toBe(FLIGHT_TOTALS.clicks);
    expect(flight.totals.conversions).toBe(FLIGHT_TOTALS.conversions);
    expect(flight.totals.spend).toBeCloseTo(FLIGHT_TOTALS.spend, 4);
    expect(flight.totals.spend).toBeCloseTo(SEARCH_TOTALS.spend + RETARGET_TOTALS.spend, 4);

    expectRenderable('client:flight', flight);
  });

  it('фильтр по каналу оставляет клиенту только кампании этого канала', async () => {
    const rows = await listClients(dashboardFilters({ provider: 'VK_ADS' }));
    const flight = clientByName(rows, CLIENT_NAMES.flight);

    expect(flight.campaignCount).toBe(1);
    expect(flight.channels).toEqual(['VK_ADS']);
    expect(flight.totals.impressions).toBe(RETARGET_TOTALS.impressions);
    expect(flight.totals.spend).toBeCloseTo(RETARGET_TOTALS.spend, 4);
  });
});

describe('дашборд: смешанная атрибуция', () => {
  it('у клиента с Метрикой в одной кампании и площадкой в другой CPA не показывается', async () => {
    const rows = await listClients(dashboardFilters());
    const flight = clientByName(rows, CLIENT_NAMES.flight);

    expect(flight.totals.attribution.mixed).toBe(true);
    expect([...flight.totals.attribution.models].sort()).toEqual(['METRIKA', 'PLATFORM']);
    expect(flight.totals.attribution.primary).toBeNull();

    // Сырой CPA посчитан — но наружу через comparableCpa уходит прочерк.
    expect(flight.totals.cpa).toBeCloseTo(FLIGHT_TOTALS.spend / FLIGHT_TOTALS.conversions, 6);
    expect(comparableCpa(flight.totals.cpa, flight.totals.attribution)).toBeNull();
    expect(formatMoneyPrecise(comparableCpa(flight.totals.cpa, flight.totals.attribution))).toBe(
      NO_VALUE,
    );
  });

  it('однородный источник считается нормально', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const search = campaignByName(rows, 'Поиск — доставка');
    const retarget = campaignByName(rows, 'Ретаргет — VK');

    expect(search.totals.attribution.mixed).toBe(false);
    expect(search.totals.attribution.primary).toBe(ConversionSource.PLATFORM);
    expect(comparableCpa(search.totals.cpa, search.totals.attribution)).toBeCloseTo(SEARCH_CPA, 6);

    expect(retarget.totals.attribution.mixed).toBe(false);
    expect(retarget.totals.attribution.primary).toBe(ConversionSource.METRIKA);
  });

  it('дни без замера (NONE) третьей моделью не считаются', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const partial = campaignByName(rows, 'Частичный замер');

    expect(partial.totals.attribution.counts.PLATFORM).toBe(3);
    expect(partial.totals.attribution.counts.NONE).toBe(2);
    expect(partial.totals.attribution.mixed).toBe(false);
    expect(partial.totals.attribution.primary).toBe(ConversionSource.PLATFORM);

    expect(partial.totals.spend).toBeCloseTo(PARTIAL_TOTALS.spend, 4);
    expect(partial.totals.conversions).toBe(PARTIAL_TOTALS.conversions);
    expect(comparableCpa(partial.totals.cpa, partial.totals.attribution)).toBeCloseTo(
      PARTIAL_CPA,
      6,
    );
  });

  it('карточка кампании считает смешение по тем же правилам, что список', async () => {
    const daily = await getCampaignDaily(seeded.campaignIds.partialSource, PERIOD_FROM, PERIOD_TO);
    const withRows = daily.filter((row) => row.conversionSource !== null);

    expect(withRows).toHaveLength(5);
    expect(withRows.filter((row) => row.conversionSource === 'PLATFORM')).toHaveLength(3);
    expect(withRows.filter((row) => row.conversionSource === 'NONE')).toHaveLength(2);
    // Дни вне пятидневки строк не имеют — источник у них null, а не NONE.
    expect(daily.filter((row) => row.conversionSource === null)).toHaveLength(PERIOD_DAYS - 5);
  });
});

describe('дашборд: деление на ноль и пустые данные', () => {
  it('нулевые показы и нулевые конверсии дают прочерк, а не NaN и не бесконечность', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const silent = campaignByName(rows, 'Молчащая — есть строки, нет цифр');

    expect(silent.totals.impressions).toBe(0);
    expect(silent.totals.clicks).toBe(0);
    expect(silent.totals.spend).toBe(0);
    expect(silent.totals.conversions).toBe(0);
    expect(silent.totals.ctr).toBeNull();
    expect(silent.totals.cpa).toBeNull();

    const rendered = renderTotals(silent.totals);
    expect(rendered.cpa).toBe(NO_VALUE);
    expect(rendered.ctr).toBe(NO_VALUE);
    expect(rendered.spend).not.toBe(NO_VALUE);
    expectRenderable('campaign:silent', silent);
  });

  it('расход есть, конверсий ноль — CPA прочерк, а не бесконечность', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const retarget = campaignByName(rows, 'Ретаргет — VK');

    expect(retarget.totals.spend).toBeCloseTo(RETARGET_TOTALS.spend, 4);
    expect(retarget.totals.conversions).toBe(0);
    expect(retarget.totals.cpa).toBeNull();
    // Показы есть, кликов мало — CTR обязан посчитаться, а не занулиться заодно.
    expect(retarget.totals.ctr).toBeCloseTo(0.04, 12);
    expect(renderTotals(retarget.totals).cpa).toBe(NO_VALUE);
  });

  it('кампания без единой строки статистики отдаёт нули, а не пустоту', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const draft = campaignByName(rows, 'Черновик — статистики нет вовсе');

    expect(draft.totals).toMatchObject({
      impressions: 0,
      clicks: 0,
      spend: 0,
      conversions: 0,
      cpa: null,
      ctr: null,
    });
    expect(draft.totals.attribution.mixed).toBe(false);
    expect(draft.totals.attribution.primary).toBeNull();
    expect(draft.targetCpa).toBeNull();
    expectRenderable('campaign:draft', draft);
  });

  it('клиент без кампаний не роняет страницу', async () => {
    const rows = await listClients(dashboardFilters());
    const empty = clientByName(rows, CLIENT_NAMES.empty);

    expect(empty.campaignCount).toBe(0);
    expect(empty.activeCampaignCount).toBe(0);
    expect(empty.channels).toEqual([]);
    expect(empty.totals.spend).toBe(0);
    expect(empty.totals.cpa).toBeNull();
    expect(empty.totals.ctr).toBeNull();
    expectRenderable('client:empty', empty);
  });

  it('дневной ряд добивает пропуски нулями, но CPA за такой день оставляет пустым', async () => {
    const daily = await getCampaignDaily(seeded.campaignIds.partialSource, PERIOD_FROM, PERIOD_TO);

    expect(daily).toHaveLength(PERIOD_DAYS);
    expect(daily[0]?.date).toBe(PERIOD_FROM);
    expect(daily[PERIOD_DAYS - 1]?.date).toBe(PERIOD_TO);

    const missing = daily.find((row) => row.date === '2026-07-01');
    expect(missing).toMatchObject({ impressions: 0, clicks: 0, spend: 0, conversions: 0 });
    expect(missing?.cpa).toBeNull();
    expect(missing?.conversionSource).toBeNull();

    const withoutConversions = daily.find((row) => row.date === '2026-07-08');
    expect(withoutConversions?.spend).toBeCloseTo(15, 4);
    expect(withoutConversions?.conversions).toBe(0);
    expect(withoutConversions?.cpa).toBeNull();

    const measured = daily.find((row) => row.date === '2026-07-05');
    expect(measured?.cpa).toBeCloseTo(15, 6);

    expectRenderable('daily:partial', daily);
  });

  it('ни одно число во всей выдаче не оказывается NaN или Infinity', async () => {
    const filters = dashboardFilters();
    const [clients, campaigns] = await Promise.all([listClients(filters), listCampaigns(filters)]);

    expectRenderable('clients', clients);
    expectRenderable('campaigns', campaigns);

    for (const row of [...clients.map((c) => c.totals), ...campaigns.map((c) => c.totals)]) {
      const rendered = renderTotals(row);
      for (const [key, value] of Object.entries(rendered)) {
        expect(value, `${key} = ${value}`).not.toMatch(/NaN|Infinity|∞|не число/i);
      }
    }
  });
});

describe('дашборд: Decimal из Postgres', () => {
  it('сумма копеек точна: 0.1 + 0.2 + 0.3 — это 0.6, а не 0.6000000000000001', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const kopeiki = campaignByName(rows, 'Копейки');

    expect(typeof kopeiki.totals.spend).toBe('number');
    expect(kopeiki.totals.spend).toBe(KOPEIKI_SPEND);
    expect(kopeiki.totals.cpa).toBeCloseTo(KOPEIKI_CPA, 12);
    expect(formatMoneyPrecise(kopeiki.totals.spend)).toContain('0,60');
  });

  it('верхний край DECIMAL(14,4) не теряет ни четвёртого знака, ни миллионов', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const big = campaignByName(rows, 'Большие деньги');

    expect(big.totals.spend).toBe(BIG_MONEY_SPEND);
    expect(big.totals.conversions).toBe(4);
    expect(big.totals.cpa).toBe(BIG_MONEY_CPA);
    expectRenderable('campaign:big-money', big);
  });

  it('дневной бюджет и целевой CPA приезжают числами, а не объектами Decimal', async () => {
    const rows = await listCampaigns(dashboardFilters());
    const search = campaignByName(rows, 'Поиск — доставка');

    expect(typeof search.dailyBudget).toBe('number');
    expect(search.dailyBudget).toBe(Number(SEARCH_DAILY_BUDGET));
    expect(typeof search.targetCpa).toBe('number');
    expect(search.targetCpa).toBe(Number(SEARCH_TARGET_CPA));
    expect(String(search.dailyBudget)).toBe('1500.55');
  });

  it('карточка кампании отдаёт те же деньги, что список', async () => {
    const detail = await getCampaign(seeded.campaignIds.search);

    expect(detail).not.toBeNull();
    expect(detail?.dailyBudget).toBe(Number(SEARCH_DAILY_BUDGET));
    expect(detail?.targetCpa).toBe(Number(SEARCH_TARGET_CPA));
    expect(detail?.clientName).toBe(CLIENT_NAMES.flight);
    expect(detail?.adGroupCount).toBe(0);
    expectRenderable('campaign-detail', detail);
  });

  it('дневной расход тоже число, и копейки в нём на месте', async () => {
    const daily = await getCampaignDaily(seeded.campaignIds.kopeiki, PERIOD_FROM, PERIOD_TO);
    const values = daily.filter((row) => row.spend > 0).map((row) => row.spend);

    expect(values).toEqual([0.1, 0.2, 0.3]);
    for (const row of daily) expect(typeof row.spend).toBe('number');
  });
});

describe('дашборд: сводка страницы «Кампании»', () => {
  /** Ровно та свёртка, что делает `web/app/campaigns/page.tsx` над строками списка. */
  function summarize(rows: readonly CampaignRow[]) {
    const totals = rows.reduce(
      (accumulator, row) => ({
        spend: accumulator.spend + row.totals.spend,
        clicks: accumulator.clicks + row.totals.clicks,
        conversions: accumulator.conversions + row.totals.conversions,
        counts: addCounts(accumulator.counts, row.totals.attribution.counts),
      }),
      { spend: 0, clicks: 0, conversions: 0, counts: emptyCounts() },
    );
    return { ...totals, attribution: summarizeAttribution(totals.counts) };
  }

  it('итог по всем кампаниям сразу смешан — площадка и Метрика в одной таблице', async () => {
    const summary = summarize(await listCampaigns(dashboardFilters()));

    expect(summary.attribution.mixed).toBe(true);
    expect(comparableCpa(cpa(summary.spend, summary.conversions), summary.attribution)).toBeNull();
  });

  it('срез по клиенту с однородным источником показывает CPA числом', async () => {
    const rows = await listCampaigns(dashboardFilters({ clientId: seeded.clientIds.partial }));
    const summary = summarize(rows);

    expect(rows).toHaveLength(1);
    expect(summary.attribution.mixed).toBe(false);
    expect(summary.spend).toBeCloseTo(PARTIAL_TOTALS.spend, 4);
    expect(comparableCpa(cpa(summary.spend, summary.conversions), summary.attribution)).toBeCloseTo(
      PARTIAL_CPA,
      6,
    );
  });

  it('фильтры из адресной строки доезжают до запроса', async () => {
    const filters = parseFilters({
      from: PERIOD_FROM,
      to: PERIOD_TO,
      provider: 'VK_ADS',
      status: 'ACTIVE',
    });

    expect(filters).toMatchObject({ from: PERIOD_FROM, to: PERIOD_TO, provider: 'VK_ADS' });

    const rows = await listCampaigns(filters);
    expect(rows.map((row) => row.name)).toEqual(['Копейки']);
    expect(rows[0]?.totals.spend).toBe(KOPEIKI_SPEND);
  });

  it('мусор в адресной строке не роняет страницу и не открывает чужой период', async () => {
    const filters = parseFilters({
      from: 'вчера',
      to: '2026-13-45',
      provider: 'ЯНДЕКС',
      days: '0',
    });

    expect(filters.provider).toBeNull();
    // Окно по умолчанию — 30 дней по §9.5, а не «весь период с начала времён».
    expect(filters.from < filters.to).toBe(true);
    await expect(listCampaigns(filters)).resolves.toBeInstanceOf(Array);
  });
});

describe('дашборд: метрики как чистые функции над данными базы', () => {
  it('CPA и CTR из слоя запросов совпадают с прямым счётом по тем же суммам', async () => {
    const rows = await listCampaigns(dashboardFilters());

    for (const row of rows) {
      expect(row.totals.cpa).toEqual(cpa(row.totals.spend, row.totals.conversions));
      expect(row.totals.ctr).toEqual(ctr(row.totals.clicks, row.totals.impressions));
    }
  });
});
