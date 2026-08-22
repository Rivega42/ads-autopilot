import type { Prisma } from '@prisma/client';

import type { VkCabinet } from './vk-api-mock.js';

import { prisma } from '@/db/prisma.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Реквизиты приложения VK: одни и те же в кабинете мока и в кредах клиента. */
export const VK_BID_APP = { clientId: 'vk-app-bids', clientSecret: 'vk-secret-bids' } as const;

/** Внешние id кабинета. Держим в одном месте — по ним же сверяется состояние мока. */
export const VK_BID_IDS = { plan: 800, group: 810 } as const;

/**
 * Нулевые сутки сценария — неделю с лишним назад, полдень UTC.
 *
 * Причина та же, что и у сценария дрейфа ставки по фразам: `ChangeLog.appliedAt`
 * штампуется настоящим временем, а окно прогона считается от подставленного `now`.
 * Уедь сценарий в будущее — история прогонов оказалась бы позже своего же окна, и
 * точка отсчёта не нашлась бы ни разу.
 */
export const VK_BID_DAY0 = new Date(utcMidnight(new Date()).getTime() - 8 * DAY_MS + 12 * HOUR_MS);

/** Момент прогона для суток `offset` сценария. */
export function vkBidRunAt(offset: number): Date {
  return new Date(VK_BID_DAY0.getTime() + offset * DAY_MS);
}

/** Сколько суток подряд ходит оптимизатор. */
export const VK_BID_DAYS = 3;

/** Сутки со статистикой: от «шести суток до первого прогона» до последнего прогона. */
const STAT_DAYS = Array.from({ length: VK_BID_DAYS + 6 }, (_unused, index) => index - 6);

/**
 * Единственные сутки с конверсией — они попадают во все окна сценария.
 *
 * Положи её на край истории, и она выпала бы из позднего окна: CPA скакнул бы
 * в бесконечность, а диагноз группы поменялся бы сам собой посреди прогона.
 */
const SHARED_DAY = 0;

export const VK_BID_TARGET_CPA_RUB = 1000;
export const VK_BID_START = 200;

/** Шаг правила «снизить ставку при высоком CPA» — TZ §3.5, 15% за раз. */
export const VK_BID_RULE_STEP = 0.15;

export interface VkBidFixture {
  clientId: string;
  campaignId: string;
  adGroupId: string;
}

/**
 * Кабинет VK из одной группы, каждые сутки просящей снижения ставки на 15%.
 *
 * Ключевых фраз у VK нет вовсе: показы покупаются аудиториями, цена задаётся на
 * группе (`max_price` → `AdGroup.bid`). Всё лишнее убрано намеренно — один план,
 * одна группа, ни одного баннера: проверяется ставка группы, и любая вторая
 * движущаяся сущность превратила бы падение теста в «сумма не сошлась».
 *
 * CPA группы держится на 2.1× цели: выше порога снижения ставки (1.5×). Расход
 * кампании — 75% дневного бюджета, поэтому правило повышения ставок (нужно меньше
 * 50%) не вооружено. Паузу группам правила не предлагают вовсе.
 */
export function createVkBidCabinet(): VkCabinet {
  return {
    adPlans: [
      {
        id: VK_BID_IDS.plan,
        name: 'Мамонты — ставка на группе',
        status: 'active',
        objective: 'siteconversions',
        budget_limit_day: '2000.00',
        budget_limit: null,
        autobidding_mode: null,
        max_price: null,
      },
    ],
    adGroups: [
      {
        id: VK_BID_IDS.group,
        ad_plan_id: VK_BID_IDS.plan,
        name: 'Москва — интересы',
        status: 'active',
        max_price: `${VK_BID_START}.00`,
        autobidding_mode: null,
        targetings: { geo: [1] },
      },
    ],
    banners: [],
    stats: { ad_plans: {}, ad_groups: {}, banners: {} },
  };
}

/**
 * Кабинет в нашей БД: строки заводятся напрямую, а не загрузкой.
 *
 * Загрузка проверена своим сценарием (`vk-channel.e2e.ts`); здесь важны ровно те
 * числа, по которым принимается решение, и лишний шаг только размыл бы диагноз.
 */
export async function seedVkBidAccount(): Promise<VkBidFixture> {
  const client = await prisma.client.create({
    data: {
      tgUserId: 770000800n,
      name: 'ООО «Мамонт-ставка»',
      status: 'ACTIVE',
      brief: {
        create: {
          status: 'COMPLETE',
          // Своей цели у импортированной кампании нет — она обязана доехать из брифа.
          data: { targetCpaRub: VK_BID_TARGET_CPA_RUB, geo: 'Москва' },
        },
      },
    },
  });

  await new CredentialRepository().save(client.id, 'VK_ADS', {
    clientId: VK_BID_APP.clientId,
    clientSecret: VK_BID_APP.clientSecret,
    scopes: ['read_ads', 'create_ads'],
  });

  const campaign = await prisma.campaign.create({
    data: {
      clientId: client.id,
      provider: 'VK_ADS',
      externalId: String(VK_BID_IDS.plan),
      name: 'Мамонты — ставка на группе',
      status: 'ACTIVE',
      dailyBudget: 2000,
      handoverMode: 'FULL',
      adGroups: {
        create: [
          {
            externalId: String(VK_BID_IDS.group),
            name: 'Москва — интересы',
            status: 'ACTIVE',
            bid: VK_BID_START,
          },
        ],
      },
    },
    include: { adGroups: true },
  });
  const adGroup = campaign.adGroups[0];
  if (!adGroup) throw new Error('группа кампании не создана');

  const rows: Prisma.CampaignStatCreateManyInput[] = STAT_DAYS.flatMap((offset) => [
    {
      entityType: 'CAMPAIGN' as const,
      entityId: campaign.id,
      date: utcMidnight(vkBidRunAt(offset)),
      impressions: 5000,
      clicks: 200,
      spend: 1500,
      conversions: 2,
    },
    {
      entityType: 'ADGROUP' as const,
      entityId: adGroup.id,
      date: utcMidnight(vkBidRunAt(offset)),
      impressions: 500,
      clicks: 25,
      spend: 300,
      conversions: offset === SHARED_DAY ? 1 : 0,
    },
  ]);
  await prisma.campaignStat.createMany({ data: rows });

  return { clientId: client.id, campaignId: campaign.id, adGroupId: adGroup.id };
}
