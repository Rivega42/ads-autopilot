import type { Prisma, StatEntityType } from '@prisma/client';

import { prisma } from '@/db/prisma.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Нулевой день сценария — позавчера, полдень UTC.
 *
 * Привязка к настоящему календарю, а не к фиксированной дате, нужна последнему
 * шагу: прогон через очередь идёт с настоящим `now`, и статистика обязана попасть
 * в его окно. Третьи сутки цикла приходятся на сегодня — там окна совпадают.
 */
export const DAY0 = new Date(utcMidnight(new Date()).getTime() - 2 * DAY_MS + 12 * HOUR_MS);

/** Момент прогона для суток `offset` сценария. */
export function runAt(offset: number): Date {
  return new Date(DAY0.getTime() + offset * DAY_MS);
}

function statDate(offset: number): Date {
  return utcMidnight(runAt(offset));
}

/** Все сутки, за которые есть статистика: окно оптимизатора — семь дней. */
const STAT_DAYS = [-6, -5, -4, -3, -2, -1, 0, 1, 2];

/**
 * День, попадающий во все три окна сценария (сутки 0, 1 и 2).
 *
 * Редкие конверсии кладём именно сюда: конверсия на краю истории выпала бы из
 * позднего окна, CPA скакнул бы в бесконечность и правило сменилось бы само собой.
 */
const SHARED_DAY = -2;

export const TARGET_CPA_RUB = 1000;

interface Daily {
  impressions: number;
  clicks: number;
  spend: number;
  /** Конверсий в сутки. */
  conversions?: number;
  /** Ещё одна конверсия в `SHARED_DAY` — так CPA одинаков во всех окнах. */
  sharedConversion?: boolean;
  /** По каким суткам разложить. По умолчанию — все. */
  days?: readonly number[];
}

function statRows(
  entityType: StatEntityType,
  entityId: string,
  daily: Daily,
): Prisma.CampaignStatCreateManyInput[] {
  const days = daily.days ?? STAT_DAYS;
  return days.map((offset) => ({
    entityType,
    entityId,
    date: statDate(offset),
    impressions: daily.impressions,
    clicks: daily.clicks,
    spend: daily.spend,
    conversions:
      (daily.conversions ?? 0) + (daily.sharedConversion && offset === SHARED_DAY ? 1 : 0),
  }));
}

export interface Fixture {
  clientId: string;
  chatId: string;
  /** Собственная кампания, режим FULL: решения применяются без человека. */
  search: {
    campaignId: string;
    externalId: string;
    adGroupId: string;
    /** CPA втрое выше цели → пауза. */
    losingKeywordId: string;
    losingKeywordExternalId: string;
    /** CPA выше цели в 2.1 раза → снижение ставки на 15%. */
    expensiveKeywordId: string;
    expensiveKeywordExternalId: string;
    /** Данные всего за сутки → предохранитель MIN_OBSERVATIONS. */
    freshKeywordId: string;
    freshKeywordExternalId: string;
    /** CPA сильно ниже цели при недоизрасходованном бюджете → повышение на 10%. */
    winningKeywordId: string;
    winningKeywordExternalId: string;
    losingAdId: string;
    losingAdExternalId: string;
    /** Мусорный запрос: CTR 0.33% при 7 кликах → минус-слово. */
    junkQuery: string;
    /** Мусорный, но всего за двое суток → предохранитель MIN_OBSERVATIONS. */
    tooFreshQuery: string;
  };
  /** Импортированная кампания, режим OBSERVER: всё уходит человеку на апрув. */
  imported: {
    campaignId: string;
    externalId: string;
    adGroupId: string;
    losingKeywordId: string;
    losingKeywordExternalId: string;
    /** Второе изменение в кампании из трёх сущностей → предохранитель по доле. */
    expensiveKeywordExternalId: string;
    junkQuery: string;
  };
}

/**
 * Кабинет, на котором срабатывают все четыре правила MVP и три предохранителя.
 *
 * Числа подобраны так, чтобы каждое решение принималось по одной понятной причине,
 * а соседние сущности оставались нейтральными: тогда провал теста показывает, какое
 * именно правило поехало, а не «сумма не сошлась».
 */
export async function seedAccount(): Promise<Fixture> {
  const client = await prisma.client.create({
    data: {
      tgUserId: 770000001n,
      name: 'ООО «Слонопотам»',
      status: 'ACTIVE',
      brief: {
        create: {
          status: 'COMPLETE',
          // Своего targetCpa у кампаний нет: у импортированных его не проставляет
          // никто, и цель обязана доехать из брифа — иначе три правила молчат.
          data: { targetCpaRub: TARGET_CPA_RUB, geo: 'Москва' },
        },
      },
    },
  });

  await new CredentialRepository().save(client.id, 'YANDEX_DIRECT', {
    accessToken: 'e2e-access-token',
    refreshToken: 'e2e-refresh-token',
  });

  const search = await prisma.campaign.create({
    data: {
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: '111',
      name: 'Поиск — Слоны',
      status: 'ACTIVE',
      dailyBudget: 8000,
      handoverMode: 'FULL',
      adGroups: {
        create: [
          { externalId: '211', name: 'Слоны — общее' },
          { externalId: '212', name: 'Слоны — длинный хвост' },
        ],
      },
    },
    include: { adGroups: { orderBy: { externalId: 'asc' } } },
  });
  const [mainGroup, tailGroup] = search.adGroups;
  if (!mainGroup || !tailGroup) throw new Error('группы кампании не созданы');

  const imported = await prisma.campaign.create({
    data: {
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      externalId: '112',
      name: 'РСЯ — импорт из кабинета',
      status: 'ACTIVE',
      dailyBudget: 3000,
      handoverMode: 'OBSERVER',
      importedAt: runAt(-30),
      importSource: 'yandex-direct',
      adGroups: { create: [{ externalId: '221', name: 'РСЯ — все' }] },
    },
    include: { adGroups: true },
  });
  const importedGroup = imported.adGroups[0];
  if (!importedGroup) throw new Error('группа импортированной кампании не создана');

  const keyword = (
    adGroupId: string,
    externalId: string,
    phrase: string,
    bid: number,
  ): Prisma.KeywordCreateInput => ({
    adGroup: { connect: { id: adGroupId } },
    externalId,
    phrase,
    bid,
    status: 'ACTIVE',
  });

  const losing = await prisma.keyword.create({
    data: keyword(mainGroup.id, '311', 'слон в посудной лавке купить', 100),
  });
  const expensive = await prisma.keyword.create({
    data: keyword(mainGroup.id, '312', 'ремонт хобота срочно', 200),
  });
  const fresh = await prisma.keyword.create({
    data: keyword(mainGroup.id, '313', 'слоны оптом со склада', 150),
  });
  const winning = await prisma.keyword.create({
    data: keyword(mainGroup.id, '314', 'купить слона', 120),
  });

  // Нейтральный хвост. Он нужен не для красоты: предохранитель по доле изменённых
  // сущностей (30% за прогон) считает от популяции, и без хвоста лимит был бы 1.
  const tailKeywords = await Promise.all(
    Array.from({ length: 14 }, (_, i) =>
      prisma.keyword.create({
        data: keyword(tailGroup.id, String(340 + i), `слон характеристика ${i + 1}`, 90),
      }),
    ),
  );

  const losingAd = await prisma.ad.create({
    data: {
      adGroupId: mainGroup.id,
      externalId: '411',
      format: 'TEXT',
      title: 'Слоны с доставкой',
      body: 'Доставим слона за сутки',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
    },
  });
  const okAd = await prisma.ad.create({
    data: {
      adGroupId: mainGroup.id,
      externalId: '412',
      format: 'TEXT',
      title: 'Слоны официально',
      body: 'Сертифицированные слоны',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
    },
  });

  const importedLosing = await prisma.keyword.create({
    data: keyword(importedGroup.id, '331', 'слон розовый', 80),
  });
  const importedExpensive = await prisma.keyword.create({
    data: keyword(importedGroup.id, '332', 'слон синий', 400),
  });
  const importedNeutral = await prisma.keyword.create({
    data: keyword(importedGroup.id, '333', 'слон зелёный', 90),
  });

  const stats: Prisma.CampaignStatCreateManyInput[] = [
    // Кампания тратит 2800 из 8000 в сутки — меньше половины бюджета, значит
    // правило повышения ставок вооружено.
    ...statRows('CAMPAIGN', search.id, {
      impressions: 20_000,
      clicks: 900,
      spend: 2800,
      conversions: 5,
    }),
    ...statRows('CAMPAIGN', imported.id, {
      impressions: 5000,
      clicks: 250,
      spend: 700,
      conversions: 1,
    }),

    // 770 показов за окно, ни одной конверсии на 420 ₽ → CPA хуже любой цели.
    ...statRows('KEYWORD', losing.id, { impressions: 110, clicks: 8, spend: 60 }),
    // 315 показов (> 200, но ≤ 500 — паузы не будет), CPA 2100 = 2.1× цели.
    ...statRows('KEYWORD', expensive.id, {
      impressions: 45,
      clicks: 6,
      spend: 300,
      sharedConversion: true,
    }),
    // Тот же диагноз, но данные за одни сутки: предохранитель обязан отклонить.
    ...statRows('KEYWORD', fresh.id, {
      impressions: 620,
      clicks: 40,
      spend: 900,
      days: [0],
    }),
    // CPA 66 ₽ при цели 1000 → повышение ставки.
    ...statRows('KEYWORD', winning.id, {
      impressions: 300,
      clicks: 30,
      spend: 200,
      conversions: 3,
    }),
    // CPA 1050 — между 0.7× и 1.5× цели, решений быть не должно.
    ...tailKeywords.flatMap((k) =>
      statRows('KEYWORD', k.id, {
        impressions: 200,
        clicks: 10,
        spend: 150,
        sharedConversion: true,
      }),
    ),
    // 700 показов и ноль конверсий → пауза объявления.
    ...statRows('AD', losingAd.id, { impressions: 100, clicks: 5, spend: 300 }),
    ...statRows('AD', okAd.id, { impressions: 500, clicks: 25, spend: 200, conversions: 2 }),

    ...statRows('KEYWORD', importedLosing.id, { impressions: 110, clicks: 7, spend: 90 }),
    ...statRows('KEYWORD', importedExpensive.id, {
      impressions: 50,
      clicks: 5,
      spend: 400,
      sharedConversion: true,
    }),
    ...statRows('KEYWORD', importedNeutral.id, {
      impressions: 200,
      clicks: 10,
      spend: 150,
      sharedConversion: true,
    }),
  ];
  await prisma.campaignStat.createMany({ data: stats });

  const junkQuery = 'слон бесплатно скачать обои';
  const tooFreshQuery = 'зоопарк слоны видео смотреть';
  const importedJunkQuery = 'слон бесплатно';

  const queryRows = (
    adGroupId: string,
    query: string,
    daily: { impressions: number; clicks: number; spend: number },
    days: readonly number[] = STAT_DAYS,
  ): Prisma.SearchQueryStatCreateManyInput[] =>
    days.map((offset) => ({
      adGroupId,
      date: statDate(offset),
      query,
      impressions: daily.impressions,
      clicks: daily.clicks,
      spend: daily.spend,
      conversions: 0,
    }));

  await prisma.searchQueryStat.createMany({
    data: [
      // CTR 0.33% при 7 кликах — оба порога правила перейдены.
      ...queryRows(mainGroup.id, junkQuery, { impressions: 300, clicks: 1, spend: 3 }),
      // Такой же мусор, но история короче трёх суток.
      ...queryRows(
        mainGroup.id,
        tooFreshQuery,
        { impressions: 2500, clicks: 5, spend: 40 },
        [-1, 0],
      ),
      // Контроль: хороший CTR.
      ...queryRows(mainGroup.id, 'купить слона недорого', {
        impressions: 500,
        clicks: 50,
        spend: 400,
      }),
      // Контроль: CTR нулевой, но кликов меньше порога — трогать нельзя.
      ...queryRows(mainGroup.id, 'слон картинки', { impressions: 400, clicks: 0, spend: 0 }),
      ...queryRows(importedGroup.id, importedJunkQuery, {
        impressions: 300,
        clicks: 1,
        spend: 2,
      }),
    ],
  });

  return {
    clientId: client.id,
    chatId: String(client.tgUserId),
    search: {
      campaignId: search.id,
      externalId: search.externalId,
      adGroupId: mainGroup.id,
      losingKeywordId: losing.id,
      losingKeywordExternalId: '311',
      expensiveKeywordId: expensive.id,
      expensiveKeywordExternalId: '312',
      freshKeywordId: fresh.id,
      freshKeywordExternalId: '313',
      winningKeywordId: winning.id,
      winningKeywordExternalId: '314',
      losingAdId: losingAd.id,
      losingAdExternalId: '411',
      junkQuery,
      tooFreshQuery,
    },
    imported: {
      campaignId: imported.id,
      externalId: imported.externalId,
      adGroupId: importedGroup.id,
      losingKeywordId: importedLosing.id,
      losingKeywordExternalId: '331',
      expensiveKeywordExternalId: '332',
      junkQuery: importedJunkQuery,
    },
  };
}
