import { ConversionSource, Provider, StatEntityType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getPrisma } from '../../web/lib/prisma.js';
import { STAT_ID_CHUNK, listCampaignsView, listClients } from '../../web/lib/queries.js';

import { dashboardFilters, disconnectDashboardPrisma } from './support/dashboard-checks.js';
import { PERIOD_FROM, dateColumn } from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Стена bind-параметров под агрегатом по набору кампаний.
 *
 * `CampaignStat` полиморфна и внешнего ключа на `Campaign` не имеет, поэтому
 * итог за период считается по списку id: `entityId: { in: [...] }`. Каждый id —
 * отдельный bind-параметр, и на 32 768-м Prisma отказывается отдавать запрос
 * драйверу с `P2029`. Это не «медленно», а 500 на витрине: до починки
 * `listCampaignsView` складывала в один `in` весь набор под фильтром без потолка.
 *
 * Замерено на живой базе (см. отчёт волны): 500 кампаний — 15 мс, 5 000 — 38 мс,
 * 20 000 — 106 мс, 32 000 — 142 мс, 33 000 — отказ. Кабинет агентства на 200
 * клиентов по 165 кампаний в это упирается, и упирается не деградацией, а
 * пустой страницей.
 */

const WALL = 32_768;
const CHUNK_SPILL = STAT_ID_CHUNK + 1;
const SPEND_PER_CAMPAIGN = 10;

let clientId: string;

function fakeIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `no-such-campaign-${index}`);
}

async function groupByIds(ids: readonly string[]): Promise<unknown> {
  return getPrisma().campaignStat.groupBy({
    by: ['conversionSource'],
    where: { entityType: StatEntityType.CAMPAIGN, entityId: { in: [...ids] } },
    _sum: { spend: true },
  });
}

beforeAll(async () => {
  await resetDatabase();

  const client = await prisma.client.create({
    data: { name: 'Агентство', tgUserId: 9_700n, status: 'ACTIVE' },
    select: { id: true },
  });
  clientId = client.id;

  const BATCH = 1_000;
  for (let start = 0; start < CHUNK_SPILL; start += BATCH) {
    const size = Math.min(BATCH, CHUNK_SPILL - start);
    await prisma.campaign.createMany({
      data: Array.from({ length: size }, (_, index) => ({
        clientId,
        externalId: `scale-${start + index}`,
        provider: Provider.YANDEX_DIRECT,
        status: 'ACTIVE' as const,
        name: `Кампания ${String(start + index).padStart(6, '0')}`,
        dailyBudget: '100.00',
      })),
    });
  }

  const campaigns = await prisma.campaign.findMany({ where: { clientId }, select: { id: true } });
  for (let start = 0; start < campaigns.length; start += BATCH) {
    await prisma.campaignStat.createMany({
      // Половина набора считает конверсии Метрикой, половина — площадкой:
      // счётчики источников обязаны складываться между чанками, а не начинаться
      // заново на каждом. Иначе смешение атрибуции пропадёт вместе с прочерком
      // вместо несопоставимого CPA.
      data: campaigns.slice(start, start + BATCH).map((campaign, index) => ({
        entityType: StatEntityType.CAMPAIGN,
        entityId: campaign.id,
        date: dateColumn(PERIOD_FROM),
        impressions: 100,
        clicks: 10,
        spend: SPEND_PER_CAMPAIGN.toFixed(2),
        conversions: 1,
        conversionSource:
          (start + index) % 2 === 0 ? ConversionSource.METRIKA : ConversionSource.PLATFORM,
      })),
    });
  }
});

afterAll(async () => {
  await disconnectDashboardPrisma();
  await prisma.$disconnect();
});

describe('дашборд: стена bind-параметров', () => {
  it('список id длиной со стену запрос не переживает', async () => {
    // Данных не нужно: отказ приходит до выполнения, на разборе параметров.
    await expect(groupByIds(fakeIds(WALL))).rejects.toMatchObject({ code: 'P2029' });
  });

  it('чанк выбран ниже стены — и это проверено запросом, а не арифметикой', async () => {
    expect(STAT_ID_CHUNK).toBeLessThan(WALL);
    await expect(groupByIds(fakeIds(STAT_ID_CHUNK))).resolves.toEqual([]);
  });
});

describe('дашборд: набор больше одного чанка', () => {
  it('итог за период складывает все чанки, а не первый', async () => {
    const view = await listCampaignsView(dashboardFilters({ clientId }));

    expect(view.total).toBe(CHUNK_SPILL);
    // Ровно то, что покажет потерянный хвост: 50 000 ₽ вместо 50 010 ₽.
    expect(view.totals.spend).toBeCloseTo(CHUNK_SPILL * SPEND_PER_CAMPAIGN, 4);
    expect(view.totals.clicks).toBe(CHUNK_SPILL * 10);
    expect(view.totals.conversions).toBe(CHUNK_SPILL);
  });

  it('смешение источников переживает границу чанка', async () => {
    const view = await listCampaignsView(dashboardFilters({ clientId }));

    expect(view.totals.attribution.mixed).toBe(true);
    expect(view.totals.attribution.counts.METRIKA).toBeGreaterThan(0);
    expect(view.totals.attribution.counts.PLATFORM).toBeGreaterThan(0);
    expect(view.totals.attribution.counts.METRIKA + view.totals.attribution.counts.PLATFORM).toBe(
      CHUNK_SPILL,
    );
  });

  it('строка клиента на `/clients` считает те же деньги', async () => {
    // `listClients` собирает кампании клиента без потолка и упирается в ту же
    // стену — чанки нужны обеим страницам, а не одной.
    const [row] = await listClients(dashboardFilters());

    expect(row?.campaignCount).toBe(CHUNK_SPILL);
    expect(row?.totals.spend).toBeCloseTo(CHUNK_SPILL * SPEND_PER_CAMPAIGN, 4);
  });
});
