import type { Prisma } from '@prisma/client';

import { prisma } from '@/db/prisma.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Нулевые сутки сценария дрейфа — неделю с лишним назад, полдень UTC.
 *
 * Все семь прогонов обязаны лежать в прошлом: записи `ChangeLog` штампуются настоящим
 * временем (`appliedAt @default(now())`), а окно каждого прогона считается от
 * подставленного `now`. Уедь сценарий в будущее — история прогонов оказалась бы позже
 * своего же окна, и точка отсчёта не нашлась бы ни разу.
 */
export const DRIFT_DAY0 = new Date(utcMidnight(new Date()).getTime() - 8 * DAY_MS + 12 * HOUR_MS);

/** Момент прогона для суток `offset` сценария. */
export function driftRunAt(offset: number): Date {
  return new Date(DRIFT_DAY0.getTime() + offset * DAY_MS);
}

/** Сколько суток подряд ходит оптимизатор в сценарии. */
export const DRIFT_DAYS = 7;

/**
 * Сутки со статистикой: от «шести суток до первого прогона» до последнего прогона.
 *
 * Окно оптимизатора — семь суток, поэтому в каждый из семи прогонов попадает ровно
 * семь суток данных, и диагноз по фразе от прогона к прогону не меняется.
 */
const STAT_DAYS = Array.from({ length: DRIFT_DAYS + 6 }, (_unused, index) => index - 6);

/**
 * Единственные сутки, попадающие во все семь окон.
 *
 * Здесь лежит единственная конверсия фразы: положи её на край истории — и она выпала бы
 * из позднего окна, CPA скакнул бы в бесконечность и правило сменилось бы с «снизить
 * ставку» на «поставить на паузу» само собой.
 */
const SHARED_DAY = 0;

export const DRIFT_TARGET_CPA_RUB = 1000;
export const DRIFT_START_BID = 200;

/** Шаг правила «снизить ставку при высоком CPA» — TZ §3.5, 15% за раз. */
export const DRIFT_RULE_STEP = 0.15;

export interface DriftFixture {
  clientId: string;
  campaignId: string;
  campaignExternalId: number;
  keywordId: string;
  keywordExternalId: number;
}

/**
 * Кабинет из одной фразы, каждые сутки просящей снижения ставки на 15%.
 *
 * Всё лишнее убрано намеренно: одна кампания, одна группа, одна фраза, ни одного
 * поискового запроса. Проверяется накопление изменения ставки, и любая вторая
 * движущаяся сущность превратила бы падение теста в «сумма не сошлась».
 *
 * CPA фразы держится на 2.1× цели: выше порога снижения ставки (1.5×) и ниже порога
 * паузы (3×), а показов за окно 420 — больше минимума наблюдений (100) и меньше порога
 * паузы (500). Расход кампании — 75% дневного бюджета, поэтому правило повышения ставок
 * (нужно меньше 50%) не вооружено вовсе.
 */
export async function seedDriftAccount(): Promise<DriftFixture> {
  const client = await prisma.client.create({
    data: {
      tgUserId: 770000777n,
      name: 'ООО «Сползание»',
      status: 'ACTIVE',
      brief: {
        create: {
          status: 'COMPLETE',
          data: { targetCpaRub: DRIFT_TARGET_CPA_RUB, geo: 'Москва' },
        },
      },
    },
  });

  await new CredentialRepository().save(client.id, 'YANDEX_DIRECT', {
    accessToken: 'e2e-access-token',
    refreshToken: 'e2e-refresh-token',
  });

  const campaign = await prisma.campaign.create({
    data: {
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: '911',
      name: 'Поиск — сползающая ставка',
      status: 'ACTIVE',
      dailyBudget: 2000,
      handoverMode: 'FULL',
      adGroups: { create: [{ externalId: '921', name: 'Единственная группа' }] },
    },
    include: { adGroups: true },
  });
  const adGroup = campaign.adGroups[0];
  if (!adGroup) throw new Error('группа кампании не создана');

  const keyword = await prisma.keyword.create({
    data: {
      adGroupId: adGroup.id,
      externalId: '931',
      phrase: 'ремонт хобота срочно',
      bid: DRIFT_START_BID,
      status: 'ACTIVE',
    },
  });

  const rows: Prisma.CampaignStatCreateManyInput[] = STAT_DAYS.flatMap((offset) => [
    {
      entityType: 'CAMPAIGN' as const,
      entityId: campaign.id,
      date: utcMidnight(driftRunAt(offset)),
      impressions: 5000,
      clicks: 200,
      spend: 1500,
      conversions: 2,
    },
    {
      entityType: 'KEYWORD' as const,
      entityId: keyword.id,
      date: utcMidnight(driftRunAt(offset)),
      impressions: 60,
      clicks: 6,
      spend: 300,
      conversions: offset === SHARED_DAY ? 1 : 0,
    },
  ]);
  await prisma.campaignStat.createMany({ data: rows });

  return {
    clientId: client.id,
    campaignId: campaign.id,
    campaignExternalId: 911,
    keywordId: keyword.id,
    keywordExternalId: 931,
  };
}
