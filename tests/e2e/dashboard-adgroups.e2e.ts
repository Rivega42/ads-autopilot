import { Provider } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NO_VALUE, formatBid } from '../../web/lib/format.js';
import { listAdGroupsView } from '../../web/lib/queries.js';

import { disconnectDashboardPrisma, expectRenderable } from './support/dashboard-checks.js';
import {
  VK_AD_GROUPS,
  VK_BID_MAX,
  VK_BID_MIN,
  VK_BID_SET,
  seedAdGroups,
  seedDashboard,
  type SeededDashboard,
} from './support/dashboard-seed.js';
import { resetDatabase } from './support/database.js';

import { prisma } from '@/db/prisma.js';

/**
 * Ставка группы объявлений на витрине.
 *
 * Было сломано: `AdGroup.bid` появилась две волны назад, её пишет загрузка и
 * применение решений, по ней работают правила — а не читала её ни одна страница.
 * Для VK это единственный рычаг управления ценой (ключевых слов у канала нет
 * вовсе), то есть главное число кампании не было видно нигде.
 *
 * Проверяется здесь ровно то, на чём витрина уже обжигалась: сводка обязана
 * считаться по всему набору, а не по обрезанному списку; `NULL` не обязан
 * читаться как ноль; и ни при каких данных наружу не должно уехать `NaN`.
 */

const ROW_LIMIT = 200;

let seeded: SeededDashboard;

beforeAll(async () => {
  await resetDatabase();
  seeded = await seedDashboard();
  await seedAdGroups(seeded.campaignIds.retarget, VK_AD_GROUPS);
});

afterAll(async () => {
  await disconnectDashboardPrisma();
});

describe('витрина: ставки групп объявлений', () => {
  it('ставка группы доезжает до страницы', async () => {
    const view = await listAdGroupsView(seeded.campaignIds.retarget);

    expect(view.rows).toHaveLength(VK_AD_GROUPS.length);
    const bids = new Map(view.rows.map((row) => [row.externalId, row.bid]));
    expect(bids.get('ext-vk-group-1')).toBe(12.34);
    expect(bids.get('ext-vk-group-4')).toBe(99.99);
    expectRenderable('adgroups', view);
  });

  it('ноль и «не задано» — разные состояния и на данных, и на экране', async () => {
    const view = await listAdGroupsView(seeded.campaignIds.retarget);
    const zero = view.rows.find((row) => row.externalId === 'ext-vk-group-2');
    const auto = view.rows.find((row) => row.externalId === 'ext-vk-group-3');

    expect(zero?.bid).toBe(0);
    expect(auto?.bid).toBeNull();
    expect(formatBid(zero?.bid ?? null)).not.toBe(formatBid(auto?.bid ?? null));
    // Ноль — это цена, а не отсутствие данных: прочерк на его месте был бы ложью.
    expect(formatBid(0)).not.toBe(NO_VALUE);
  });

  it('сводка считает все группы кампании, а не показанные', async () => {
    const view = await listAdGroupsView(seeded.campaignIds.retarget);

    expect(view.bids.groups).toBe(VK_AD_GROUPS.length);
    expect(view.bids.withBid).toBe(VK_BID_SET);
    expect(view.bids.min).toBe(VK_BID_MIN);
    expect(view.bids.max).toBe(VK_BID_MAX);
  });

  it('кампания без групп не даёт ни NaN, ни выдуманного нуля', async () => {
    const view = await listAdGroupsView(seeded.campaignIds.silentNoStats);

    expect(view.rows).toEqual([]);
    expect(view.bids.groups).toBe(0);
    expect(view.bids.withBid).toBe(0);
    expect(view.bids.min).toBeNull();
    expect(view.bids.max).toBeNull();
    expect(formatBid(view.bids.min)).not.toMatch(/NaN/);
    expectRenderable('adgroups-empty', view);
  });
});

/**
 * Кабинет, где групп больше потолка выборки.
 *
 * Свёртка обрезка — та же ошибка, что уже была на `/campaigns` с деньгами: самая
 * дорогая группа стоит за 200-й строкой, и сводка, посчитанная по показанному,
 * назвала бы максимальной ставкой рубль вместо пятисот.
 */
describe('витрина: групп больше потолка', () => {
  const GROUP_COUNT = 205;
  const CHEAP = 1;
  const EXPENSIVE = 500;
  let campaignId: string;

  beforeAll(async () => {
    const client = await prisma.client.create({
      data: { name: 'Кабинет с сотнями групп', tgUserId: 9_101n, status: 'ACTIVE' },
      select: { id: true },
    });
    const campaign = await prisma.campaign.create({
      data: {
        clientId: client.id,
        externalId: 'ext-many-groups',
        provider: Provider.VK_ADS,
        status: 'ACTIVE',
        name: 'Много групп',
        dailyBudget: '1000.00',
      },
      select: { id: true },
    });
    campaignId = campaign.id;

    // Имена сортируются по возрастанию, поэтому дорогая и «не заданная» группы
    // гарантированно оказываются за потолком выборки.
    await prisma.adGroup.createMany({
      data: Array.from({ length: GROUP_COUNT }, (_, index) => ({
        campaignId,
        externalId: `ext-many-${index}`,
        name: `Группа ${String(index).padStart(3, '0')}`,
        bid:
          index === GROUP_COUNT - 1
            ? EXPENSIVE.toFixed(2)
            : index === GROUP_COUNT - 2
              ? null
              : CHEAP.toFixed(2),
      })),
    });
  });

  it('список обрезан и говорит об этом', async () => {
    const view = await listAdGroupsView(campaignId);

    expect(view.rows).toHaveLength(ROW_LIMIT);
    expect(view.total).toBe(GROUP_COUNT);
    expect(view.truncated).toBe(true);
  });

  it('максимум ставки берётся из всего набора, а не из показанного', async () => {
    const view = await listAdGroupsView(campaignId);

    expect(view.rows.some((row) => row.bid === EXPENSIVE)).toBe(false);
    expect(view.bids.max).toBe(EXPENSIVE);
    expect(view.bids.min).toBe(CHEAP);
    expect(view.bids.groups).toBe(GROUP_COUNT);
    expect(view.bids.withBid).toBe(GROUP_COUNT - 1);
  });
});
