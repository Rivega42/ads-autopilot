import { Provider, StatEntityType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listCampaigns, listClients } from '../../web/lib/queries.js';

import { dashboardFilters, disconnectDashboardPrisma } from './support/dashboard-checks.js';
import { PERIOD_FROM, dateColumn } from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Потолок выборки `ROW_LIMIT` на живых данных.
 *
 * Кабинет с двумя-тремя сотнями кампаний — обычное дело для агентства, так что
 * это не край, а рабочий режим. Дашборд обрезает список молча, и плитка «Расход
 * за период» на `/campaigns` считается уже по обрезку.
 */

const CAMPAIGN_COUNT = 205;
const ROW_LIMIT = 200;
/** Расход у каждой кампании одинаковый — чтобы недостача читалась в рублях. */
const SPEND_PER_CAMPAIGN = 10;

let clientId: string;

beforeAll(async () => {
  await resetDatabase();

  const client = await prisma.client.create({
    data: { name: 'Агентство', tgUserId: 9_100n, status: 'ACTIVE' },
    select: { id: true },
  });
  clientId = client.id;

  const names = Array.from(
    { length: CAMPAIGN_COUNT },
    (_, index) => `Кампания ${String(index + 1).padStart(3, '0')}`,
  );

  await prisma.campaign.createMany({
    data: names.map((name, index) => ({
      clientId,
      externalId: `bulk-${index}`,
      provider: Provider.YANDEX_DIRECT,
      status: 'ACTIVE' as const,
      name,
      dailyBudget: '100.00',
    })),
  });

  const campaigns = await prisma.campaign.findMany({
    where: { clientId },
    select: { id: true },
  });

  await prisma.campaignStat.createMany({
    data: campaigns.map((campaign) => ({
      entityType: StatEntityType.CAMPAIGN,
      entityId: campaign.id,
      date: dateColumn(PERIOD_FROM),
      impressions: 100,
      clicks: 10,
      spend: SPEND_PER_CAMPAIGN.toFixed(2),
      conversions: 1,
    })),
  });
});

afterAll(async () => {
  await disconnectDashboardPrisma();
  await prisma.$disconnect();
});

describe('дашборд: потолок выборки', () => {
  it('ДЕФЕКТ: список кампаний обрезается на 200-й, и страница об этом не говорит', async () => {
    const rows = await listCampaigns(dashboardFilters());

    expect(rows).toHaveLength(ROW_LIMIT);
    // Пять кампаний с расходом просто отсутствуют в таблице.
    expect(rows.at(-1)?.name).toBe('Кампания 200');
    expect(rows.some((row) => row.name === 'Кампания 205')).toBe(false);
  });

  it('ДЕФЕКТ: плитка «Расход за период» считается по обрезку и занижает сумму', async () => {
    const rows = await listCampaigns(dashboardFilters());
    // Та же свёртка, что в `web/app/campaigns/page.tsx`.
    const shown = rows.reduce((sum, row) => sum + row.totals.spend, 0);

    const actual = await prisma.campaignStat.aggregate({
      where: { entityType: StatEntityType.CAMPAIGN, date: dateColumn(PERIOD_FROM) },
      _sum: { spend: true },
    });

    expect(shown).toBeCloseTo(ROW_LIMIT * SPEND_PER_CAMPAIGN, 4);
    expect(Number(String(actual._sum.spend))).toBeCloseTo(CAMPAIGN_COUNT * SPEND_PER_CAMPAIGN, 4);
    // Недостача в 50 ₽ подписана как итог за период — без звёздочки и оговорки.
    expect(shown).toBeLessThan(CAMPAIGN_COUNT * SPEND_PER_CAMPAIGN);
  });

  it('ДЕФЕКТ: «Клиенты» и «Кампании» за один период показывают разные деньги', async () => {
    const filters = dashboardFilters();
    const [clients, campaigns] = await Promise.all([listClients(filters), listCampaigns(filters)]);

    const onClientsPage = clients.find((row) => row.id === clientId);
    const onCampaignsPage = campaigns.reduce((sum, row) => sum + row.totals.spend, 0);

    // `listClients` тянет кампании клиента без потолка, `listCampaigns` — с ним.
    expect(onClientsPage?.campaignCount).toBe(CAMPAIGN_COUNT);
    expect(onClientsPage?.totals.spend).toBeCloseTo(CAMPAIGN_COUNT * SPEND_PER_CAMPAIGN, 4);
    expect(onCampaignsPage).toBeCloseTo(ROW_LIMIT * SPEND_PER_CAMPAIGN, 4);
    expect(onClientsPage?.totals.spend).not.toBeCloseTo(onCampaignsPage, 4);
  });
});
