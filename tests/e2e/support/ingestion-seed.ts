import { formatInTimeZone } from 'date-fns-tz';

import type { Cabinet, CabinetFact } from './ingestion-yandex-mock.js';

import { prisma } from '@/db/prisma.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

/**
 * Кабинет и клиент для сценариев загрузки.
 *
 * Свои, а не из `seed.ts`: тот собран под правила оптимизатора (у каждой фразы
 * подобран CPA), и любая цифра там подчинена другому смыслу. Здесь важно ровно
 * противоположное — что цифры из ответа площадки доедут до колонок неизменными.
 *
 * Идентификаторы — восьмизначные, как в настоящем Директе. Это не косметика:
 * `directCampaignId` вытаскивает номер кампании из человекочитаемого имени
 * регуляркой `\d{4,}`, и на трёхзначных id сценарий проверял бы не то, что прод.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MSK = 'Europe/Moscow';

/** `yyyy-MM-dd` по МСК со сдвигом на `offset` суток — та же арифметика, что в `window.ts`. */
export function mskDay(offset: number): string {
  const today = formatInTimeZone(new Date(), MSK, 'yyyy-MM-dd');
  const anchored = new Date(`${today}T00:00:00Z`).getTime();
  return formatInTimeZone(new Date(anchored + offset * DAY_MS), 'UTC', 'yyyy-MM-dd');
}

/**
 * Ширина окна — литерал, а не импорт `STATS_WINDOW_DAYS`.
 *
 * Требование ТЗ §2.1: конверсии Метрики доезжают 21 день, значит и перезаливать
 * надо 21 день. Взяв константу из кода, фикстура поехала бы вместе с ней, и
 * сценарий остался бы зелёным ровно в том случае, ради которого написан.
 */
export const EXPECTED_WINDOW_DAYS = 21;

/** Сутки скользящего окна, от самых старых к сегодняшним. */
export const WINDOW_DAYS: readonly string[] = Array.from({ length: EXPECTED_WINDOW_DAYS }, (_, i) =>
  mskDay(i - (EXPECTED_WINDOW_DAYS - 1)),
);

export const WINDOW_FROM = WINDOW_DAYS[0] as string;
export const WINDOW_TO = WINDOW_DAYS[WINDOW_DAYS.length - 1] as string;
/** Сутки, вывалившиеся из окна: их не должно быть в базе после прогона. */
export const BEFORE_WINDOW = mskDay(-EXPECTED_WINDOW_DAYS - 3);

export const IDS = {
  search: 87_651_001,
  network: 87_651_002,
  groupCore: 47_651_001,
  groupTail: 47_651_002,
  groupNetwork: 47_651_003,
  adCore: 98_761_001,
  adRejected: 98_761_002,
  adTail: 98_761_003,
  adNetwork: 98_761_004,
  keywordCore: 32_651_001,
  keywordPaused: 32_651_002,
  keywordTail: 32_651_003,
  /** Группы с таким номером в кабинете нет: строка отчёта без адреса. */
  strayGroup: 47_659_999,
} as const;

/**
 * Второй кабинет — со своими идентификаторами.
 *
 * Не копия первого: `Campaign` уникальна по `(provider, externalId)` на всю базу,
 * и два кабинета с одинаковыми номерами кампаний писали бы в одни и те же строки.
 */
export const SECONDARY_IDS = {
  campaign: 87_659_101,
  group: 47_659_101,
  ad: 98_769_101,
  keyword: 32_659_101,
} as const;

export const TOKENS = {
  /** Кабинет с настроенной Метрикой. */
  primary: 'e2e-ingestion-token-primary',
  /** Кабинет без Метрики — штатный путь, а не отказ. */
  secondary: 'e2e-ingestion-token-secondary',
} as const;

export const METRIKA = { counterId: 44_112_233, goalId: 5_566_778 } as const;

/**
 * Кабинет: поисковая кампания с двумя группами и РСЯ-кампания на паузе.
 *
 * Возвращается новым объектом на каждый вызов — сценарии его меняют.
 */
export function createCabinet(): Cabinet {
  return {
    campaigns: [
      {
        id: IDS.search,
        name: 'Поиск — Кофемашины',
        type: 'TEXT_CAMPAIGN',
        state: 'ON',
        status: 'ACCEPTED',
        dailyBudgetRub: 5000,
        strategyType: 'WB_MAXIMUM_CONVERSION_RATE',
        negativeKeywords: ['бесплатно'],
      },
      {
        // Дневного лимита нет вовсе: кабинет промолчит, а колонка NOT NULL.
        id: IDS.network,
        name: 'РСЯ — Кофемашины',
        type: 'UNIFIED_CAMPAIGN',
        state: 'SUSPENDED',
        status: 'ACCEPTED',
        dailyBudgetRub: null,
        strategyType: 'AUTOBUDGET',
        negativeKeywords: [],
      },
    ],
    adGroups: [
      {
        id: IDS.groupCore,
        campaignId: IDS.search,
        name: 'Кофемашины — общее',
        status: 'ACCEPTED',
        type: 'TEXT_AD_GROUP',
        regionIds: [213],
      },
      {
        id: IDS.groupTail,
        campaignId: IDS.search,
        name: 'Кофемашины — бренды',
        status: 'ACCEPTED',
        type: 'TEXT_AD_GROUP',
        regionIds: [213, 1],
      },
      {
        id: IDS.groupNetwork,
        campaignId: IDS.network,
        name: 'РСЯ — автотаргетинг',
        status: 'ACCEPTED',
        type: 'TEXT_AD_GROUP',
        regionIds: [225],
      },
    ],
    ads: [
      {
        id: IDS.adCore,
        campaignId: IDS.search,
        adGroupId: IDS.groupCore,
        state: 'ON',
        status: 'ACCEPTED',
        title: 'Кофемашины с доставкой',
        title2: 'Гарантия 3 года',
        text: 'Более 200 моделей в наличии',
        href: 'https://example.test/coffee',
      },
      {
        id: IDS.adRejected,
        campaignId: IDS.search,
        adGroupId: IDS.groupCore,
        state: 'OFF',
        status: 'REJECTED',
        statusClarification: 'Превосходная степень без подтверждения',
        // Второго заголовка у объявления нет: площадка его просто не пришлёт.
        title: 'Лучшие кофемашины мира',
        text: 'Самый лучший выбор',
      },
      {
        id: IDS.adTail,
        campaignId: IDS.search,
        adGroupId: IDS.groupTail,
        state: 'ON',
        status: 'MODERATION',
        title: 'Кофемашины DeLonghi',
        text: 'Официальный дилер',
      },
      {
        id: IDS.adNetwork,
        campaignId: IDS.network,
        adGroupId: IDS.groupNetwork,
        state: 'SUSPENDED',
        status: 'ACCEPTED',
        title: 'Кофе дома',
        text: 'Как в кофейне',
      },
    ],
    keywords: [
      {
        id: IDS.keywordCore,
        campaignId: IDS.search,
        adGroupId: IDS.groupCore,
        keyword: 'кофемашина купить',
        state: 'ON',
        status: 'ACCEPTED',
        bidRub: 45.5,
      },
      {
        id: IDS.keywordPaused,
        campaignId: IDS.search,
        adGroupId: IDS.groupCore,
        keyword: 'ремонт кофемашины',
        state: 'SUSPENDED',
        status: 'ACCEPTED',
        bidRub: null,
      },
      {
        id: IDS.keywordTail,
        campaignId: IDS.search,
        adGroupId: IDS.groupTail,
        keyword: 'кофемашина delonghi',
        state: 'ON',
        status: 'ACCEPTED',
        bidRub: 30,
      },
    ],
    facts: buildFacts(),
    queries: buildQueries(),
  };
}

/**
 * Открутка за окно плюс одни сутки за его краем.
 *
 * У РСЯ-кампании фразы нет вовсе (автотаргетинг): в отчёте такая строка приходит
 * с `CriterionId = --`, привязать её не к чему, и она обязана попасть в
 * `unresolved`, а не раствориться.
 */
function buildFacts(): CabinetFact[] {
  const rows: CabinetFact[] = [];
  const days = [BEFORE_WINDOW, ...WINDOW_DAYS];

  for (const [index, date] of days.entries()) {
    rows.push({
      date,
      campaignId: IDS.search,
      adGroupId: IDS.groupCore,
      adId: IDS.adCore,
      criterionId: IDS.keywordCore,
      impressions: 120 + index,
      clicks: 9,
      cost: 315.5,
      conversions: 1,
      revenue: 4200,
    });
    rows.push({
      date,
      campaignId: IDS.search,
      adGroupId: IDS.groupCore,
      adId: IDS.adRejected,
      criterionId: IDS.keywordPaused,
      impressions: 40,
      clicks: 2,
      cost: 88.25,
      // Цели на эту фразу не назначены: Директ пришлёт `--`.
      conversions: null,
      revenue: null,
    });
    rows.push({
      date,
      campaignId: IDS.search,
      adGroupId: IDS.groupTail,
      adId: IDS.adTail,
      criterionId: IDS.keywordTail,
      impressions: 60,
      clicks: 3,
      cost: 101,
      conversions: 0,
      revenue: 0,
    });
    rows.push({
      date,
      campaignId: IDS.network,
      adGroupId: IDS.groupNetwork,
      adId: IDS.adNetwork,
      criterionId: null,
      impressions: 900,
      clicks: 12,
      cost: 74.4,
      conversions: null,
      revenue: null,
    });
  }
  return rows;
}

/** Поисковые запросы: два адресуемых и один из группы, которой у нас нет. */
function buildQueries(): CabinetFact[] {
  const rows: CabinetFact[] = [];
  for (const date of WINDOW_DAYS.slice(-3)) {
    rows.push({
      date,
      campaignId: IDS.search,
      adGroupId: IDS.groupCore,
      query: 'купить кофемашину недорого',
      impressions: 120,
      clicks: 7,
      cost: 210.4,
      conversions: 1,
    });
    rows.push({
      date,
      campaignId: IDS.search,
      adGroupId: IDS.groupCore,
      query: 'кофемашина обои на рабочий стол',
      impressions: 300,
      clicks: 1,
      cost: 3.2,
      conversions: 0,
    });
    rows.push({
      date,
      campaignId: IDS.search,
      adGroupId: IDS.groupTail,
      query: 'delonghi отзывы',
      impressions: 80,
      clicks: 4,
      cost: 60,
      conversions: 0,
    });
    rows.push({
      // Группа удалена из кабинета вчера, а отчёт помнит её ещё три недели.
      date,
      campaignId: IDS.search,
      adGroupId: IDS.strayGroup,
      query: 'кофемашина в аренду',
      impressions: 50,
      clicks: 2,
      cost: 30,
      conversions: 0,
    });
  }
  return rows;
}

export interface SeedClientOptions {
  name: string;
  tgUserId: bigint;
  accessToken: string;
  /** Без счётчика клиент проходит шаг Метрики штатно, а не с ошибкой. */
  metrika?: { counterId: number; goalId: number; attribution?: string };
}

export async function seedIngestionClient(options: SeedClientOptions): Promise<string> {
  const client = await prisma.client.create({
    data: {
      tgUserId: options.tgUserId,
      name: options.name,
      status: 'ACTIVE',
      metrikaCounterId: options.metrika?.counterId ?? null,
      metrikaGoalId: options.metrika?.goalId ?? null,
      metrikaAttribution: options.metrika?.attribution ?? null,
    },
  });

  await new CredentialRepository().save(client.id, 'YANDEX_DIRECT', {
    accessToken: options.accessToken,
    refreshToken: `${options.accessToken}-refresh`,
  });

  return client.id;
}

/** Маленький кабинет второго клиента: у него Метрика не настроена. */
export function createSecondaryCabinet(): Cabinet {
  const facts: CabinetFact[] = WINDOW_DAYS.map((date) => ({
    date,
    campaignId: SECONDARY_IDS.campaign,
    adGroupId: SECONDARY_IDS.group,
    adId: SECONDARY_IDS.ad,
    criterionId: SECONDARY_IDS.keyword,
    impressions: 200,
    clicks: 10,
    cost: 150,
    conversions: 2,
    revenue: 3000,
  }));

  return {
    campaigns: [
      {
        id: SECONDARY_IDS.campaign,
        name: 'Поиск — Чайники',
        type: 'TEXT_CAMPAIGN',
        state: 'ON',
        status: 'ACCEPTED',
        dailyBudgetRub: 1200,
        strategyType: 'HIGHEST_POSITION',
        negativeKeywords: [],
      },
    ],
    adGroups: [
      {
        id: SECONDARY_IDS.group,
        campaignId: SECONDARY_IDS.campaign,
        name: 'Чайники — общее',
        status: 'ACCEPTED',
        type: 'TEXT_AD_GROUP',
        regionIds: [213],
      },
    ],
    ads: [
      {
        id: SECONDARY_IDS.ad,
        campaignId: SECONDARY_IDS.campaign,
        adGroupId: SECONDARY_IDS.group,
        state: 'ON',
        status: 'ACCEPTED',
        title: 'Чайники с доставкой',
        text: 'Завтра у вас дома',
      },
    ],
    keywords: [
      {
        id: SECONDARY_IDS.keyword,
        campaignId: SECONDARY_IDS.campaign,
        adGroupId: SECONDARY_IDS.group,
        keyword: 'купить чайник',
        state: 'ON',
        status: 'ACCEPTED',
        bidRub: 12,
      },
    ],
    facts,
    queries: [],
  };
}
