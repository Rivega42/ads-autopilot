import { ChangeActor, Provider, StatEntityType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  listCampaigns,
  listCampaignsView,
  listChangesView,
  listClientsView,
} from '../../web/lib/queries.js';

import { dashboardFilters, disconnectDashboardPrisma } from './support/dashboard-checks.js';
import { PERIOD_FROM, dateColumn } from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Потолок выборки `ROW_LIMIT` на живых данных.
 *
 * Кабинет с двумя-тремя сотнями кампаний — обычное дело для агентства, так что
 * это не край, а рабочий режим.
 *
 * Было сломано: `listCampaigns` обрезал список на 200-й строке молча, а плитка
 * «Расход за период» на `/campaigns` считалась свёрткой этого обрезка и была
 * подписана как итог за период. На 205 кампаниях по 10 ₽ витрина показывала
 * 2000 ₽ против 2050 ₽ на `/clients` — две страницы за один период показывали
 * разные деньги, и ни одна не говорила, что чего-то не хватает.
 */

const CAMPAIGN_COUNT = 205;
const ROW_LIMIT = 200;
/** Всего клиентов в базе, вместе с двумя ниже: список клиентов тоже за потолком. */
const CLIENT_COUNT = 205;
/** Расход у каждой кампании одинаковый — чтобы недостача читалась в рублях. */
const SPEND_PER_CAMPAIGN = 10;
const TOTAL_SPEND = CAMPAIGN_COUNT * SPEND_PER_CAMPAIGN;

let clientId: string;
/** Клиент ровно с потолком кампаний: обрезки нет, и говорить о ней не о чем. */
let exactLimitClientId: string;

async function createClient(name: string, tgUserId: bigint): Promise<string> {
  const client = await prisma.client.create({
    data: { name, tgUserId, status: 'ACTIVE' },
    select: { id: true },
  });
  return client.id;
}

async function createCampaigns(
  owner: string,
  count: number,
  prefix: string,
): Promise<{ readonly id: string }[]> {
  await prisma.campaign.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      clientId: owner,
      externalId: `${prefix}-${index}`,
      provider: Provider.YANDEX_DIRECT,
      status: 'ACTIVE' as const,
      name: `Кампания ${String(index + 1).padStart(3, '0')}`,
      dailyBudget: '100.00',
    })),
  });

  return prisma.campaign.findMany({ where: { clientId: owner }, select: { id: true } });
}

beforeAll(async () => {
  await resetDatabase();

  clientId = await createClient('Агентство', 9_100n);
  const campaigns = await createCampaigns(clientId, CAMPAIGN_COUNT, 'bulk');

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

  exactLimitClientId = await createClient('Ровно двести', 9_200n);
  await createCampaigns(exactLimitClientId, ROW_LIMIT, 'exact');

  // Клиентов тоже больше потолка: обрезка списка клиентов обязана быть видна
  // так же, как обрезка списка кампаний.
  await prisma.client.createMany({
    data: Array.from({ length: CLIENT_COUNT - 2 }, (_, index) => ({
      name: `Клиент ${String(index + 1).padStart(3, '0')}`,
      tgUserId: BigInt(20_000 + index),
      status: 'ACTIVE' as const,
    })),
  });
});

afterAll(async () => {
  await disconnectDashboardPrisma();
  await prisma.$disconnect();
});

describe('дашборд: потолок выборки', () => {
  it('список кампаний обрезается на 200-й, и страница знает, сколько строк не показано', async () => {
    const view = await listCampaignsView(dashboardFilters({ clientId }));

    expect(view.rows).toHaveLength(ROW_LIMIT);
    expect(view.limit).toBe(ROW_LIMIT);
    // Именно этого раньше не было: снаружи обрезок не отличался от полного
    // набора ровно в двести строк.
    expect(view.total).toBe(CAMPAIGN_COUNT);
    expect(view.truncated).toBe(true);

    expect(view.rows.at(-1)?.name).toBe('Кампания 200');
    expect(view.rows.some((row) => row.name === 'Кампания 205')).toBe(false);
  });

  it('набор ровно по потолку обрезанным не считается', async () => {
    const view = await listCampaignsView(dashboardFilters({ clientId: exactLimitClientId }));

    expect(view.rows).toHaveLength(ROW_LIMIT);
    expect(view.total).toBe(ROW_LIMIT);
    expect(view.truncated).toBe(false);
  });

  it('плитка «Расход за период» считается по всему набору, а не по показанным строкам', async () => {
    const view = await listCampaignsView(dashboardFilters({ clientId }));
    // Та свёртка, что раньше стояла в `web/app/campaigns/page.tsx`.
    const foldedRows = view.rows.reduce((sum, row) => sum + row.totals.spend, 0);

    const actual = await prisma.campaignStat.aggregate({
      where: { entityType: StatEntityType.CAMPAIGN, date: dateColumn(PERIOD_FROM) },
      _sum: { spend: true },
    });

    expect(Number(String(actual._sum.spend))).toBeCloseTo(TOTAL_SPEND, 4);
    expect(view.totals.spend).toBeCloseTo(TOTAL_SPEND, 4);
    // Плитка обязана расходиться со свёрткой обрезка — иначе она снова считает
    // первые двести строк и подписывает результат итогом за период.
    expect(foldedRows).toBeCloseTo(ROW_LIMIT * SPEND_PER_CAMPAIGN, 4);
    expect(view.totals.spend).toBeGreaterThan(foldedRows);

    // Остальные плитки — из того же агрегата, а не из обрезка.
    expect(view.totals.clicks).toBe(CAMPAIGN_COUNT * 10);
    expect(view.totals.impressions).toBe(CAMPAIGN_COUNT * 100);
    expect(view.totals.conversions).toBe(CAMPAIGN_COUNT);
    expect(view.totals.cpa).toBeCloseTo(TOTAL_SPEND / CAMPAIGN_COUNT, 4);
  });

  it('«Клиенты» и «Кампании» за один период показывают одни и те же деньги', async () => {
    const filters = dashboardFilters();
    const [clients, allCampaigns, clientCampaigns] = await Promise.all([
      listClientsView(filters),
      listCampaignsView(filters),
      listCampaignsView(dashboardFilters({ clientId })),
    ]);

    const onClientsPage = clients.rows.find((row) => row.id === clientId);

    expect(onClientsPage?.campaignCount).toBe(CAMPAIGN_COUNT);
    expect(onClientsPage?.totals.spend).toBeCloseTo(TOTAL_SPEND, 4);
    // И переход «клиент → его кампании», и общая витрина кампаний дают ту же сумму.
    expect(clientCampaigns.totals.spend).toBeCloseTo(onClientsPage?.totals.spend ?? Number.NaN, 4);
    expect(allCampaigns.totals.spend).toBeCloseTo(TOTAL_SPEND, 4);
  });

  it('список клиентов обрезается так же и так же об этом говорит', async () => {
    const view = await listClientsView(dashboardFilters());

    expect(view.rows).toHaveLength(ROW_LIMIT);
    expect(view.total).toBe(CLIENT_COUNT);
    expect(view.truncated).toBe(true);
    expect(view.rows.at(0)?.id).toBe(clientId);
  });

  it('сам список остаётся обрезанным: чинилась подпись и итог, а не потолок', async () => {
    const rows = await listCampaigns(dashboardFilters({ clientId }));

    expect(rows).toHaveLength(ROW_LIMIT);
    expect(rows.reduce((sum, row) => sum + row.totals.spend, 0)).toBeLessThan(TOTAL_SPEND);
  });
});

/**
 * История изменений обрезается тем же потолком, что и списки, и до сих пор
 * молчала об этом. `/changes` — то место, куда человек идёт разбираться, что
 * система сделала с кабинетом; список, у которого не видно хвоста, отвечает на
 * этот вопрос неполно и не говорит, что неполно.
 */
describe('дашборд: потолок истории изменений', () => {
  const CHANGE_COUNT = 205;

  beforeAll(async () => {
    const campaign = await prisma.campaign.findFirstOrThrow({
      where: { clientId },
      select: { id: true },
    });
    await prisma.changeLog.createMany({
      data: Array.from({ length: CHANGE_COUNT }, (_, index) => ({
        campaignId: campaign.id,
        entityType: 'KEYWORD',
        entityId: `kw-${index}`,
        action: 'bid_change',
        prevValue: { bid: 100 },
        newValue: { bid: 110 },
        reason: `Правка ${index}`,
        actor: ChangeActor.AI,
        provider: Provider.YANDEX_DIRECT,
        appliedAt: new Date(`${PERIOD_FROM}T09:00:00.000Z`),
      })),
    });
  });

  it('обрезка видна: страница знает размер набора, а не только показанное', async () => {
    const view = await listChangesView(dashboardFilters());

    expect(view.rows).toHaveLength(ROW_LIMIT);
    expect(view.total).toBe(CHANGE_COUNT);
    expect(view.truncated).toBe(true);
  });

  it('набор ровно по потолку обрезанным не считается', async () => {
    const view = await listChangesView(dashboardFilters(), { limit: CHANGE_COUNT });

    expect(view.rows).toHaveLength(CHANGE_COUNT);
    expect(view.truncated).toBe(false);
  });

  it('размер набора считается по тому же фильтру, что и строки', async () => {
    // Иначе «показаны первые 200 из 205» становится другой ложью: число из одной
    // выборки, подписанное как размер другой.
    const view = await listChangesView(dashboardFilters({ provider: Provider.VK_ADS }));

    expect(view.rows).toEqual([]);
    expect(view.total).toBe(0);
    expect(view.truncated).toBe(false);
  });
});
