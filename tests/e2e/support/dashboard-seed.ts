import { ChangeActor, ConversionSource, Provider, StatEntityType } from '@prisma/client';
import type { AdGroupStatus, CampaignStatus, ClientStatus } from '@prisma/client';

import { prisma } from '@/db/prisma.js';

/**
 * Данные дашборда: клиенты, кампании и статистика с заранее известными суммами.
 *
 * Числа заданы явными рядами, а не генератором «поближе к реальности»: сценарий
 * обязан сверять агрегаты с арифметикой, посчитанной руками, а не с тем же
 * кодом, который он проверяет.
 *
 * Деньги задаются строками. `spend` в базе — `DECIMAL(14,4)`, и передай мы сюда
 * JS-число, копейки потерялись бы ещё до вставки — проверять после этого было бы
 * нечего.
 */

/** Окно целиком в 2026 году: МСК с 2014-го — фиксированный UTC+3, без переходов. */
export const PERIOD_FROM = '2026-07-01';
export const PERIOD_TO = '2026-07-30';
export const PERIOD_DAYS = 30;

/** Соседние сутки за границами окна — на них лежат «ловушки». */
export const DAY_BEFORE_FROM = '2026-06-30';
export const DAY_AFTER_TO = '2026-07-31';

/**
 * Момент по МСК, выраженный явным смещением `+03:00`.
 *
 * Намеренно не через `web/lib/dates.ts`: сверять границы периода функцией,
 * которую сценарий и проверяет, — значит не проверять ничего.
 */
export function mskInstant(ymd: string, time: string): Date {
  return new Date(`${ymd}T${time}+03:00`);
}

/** Значение для колонки `@db.Date`: UTC-полночь — контракт хранения, см. `src/ingestion/window.ts`. */
export function dateColumn(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function addDays(ymd: string, days: number): string {
  const shifted = new Date(`${ymd}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function periodDays(): string[] {
  return Array.from({ length: PERIOD_DAYS }, (_, index) => addDays(PERIOD_FROM, index));
}

export interface DayStat {
  readonly ymd: string;
  readonly impressions: number;
  readonly clicks: number;
  /** Строкой — иначе копейки теряются ещё до вставки. */
  readonly spend: string;
  readonly conversions: number;
  readonly source: ConversionSource;
}

export interface ExpectedTotals {
  readonly impressions: number;
  readonly clicks: number;
  readonly spend: number;
  readonly conversions: number;
}

/** Внешние идентификаторы кампаний — по ним тест находит строки, не завися от cuid. */
export const EXTERNAL = {
  search: 'ext-search-1',
  retarget: 'ext-retarget-1',
  silentActive: 'ext-silent-1',
  silentNoStats: 'ext-silent-2',
  partialSource: 'ext-partial-1',
  kopeiki: 'ext-kopeiki-1',
  bigMoney: 'ext-big-1',
} as const;

export const CLIENT_NAMES = {
  flight: 'Полёт',
  silence: 'Тишина',
  empty: 'Пустой кабинет',
  partial: 'Частичный замер',
  money: 'Копейки',
} as const;

/**
 * Кампания «Поиск»: 30 дней, конверсии считает площадка.
 *
 * Ряды линейные, поэтому суммы берутся из формулы, а не из прогона:
 * показы 1000+10i → 30·1000 + 10·435 = 34 350;
 * клики 40+i → 30·40 + 435 = 1 635;
 * конверсии i mod 3 → десять периодов 0+1+2 = 30;
 * расход 10.01+0.01i коп. → (30·1001 + 435) коп. = 304,65 ₽.
 */
export const SEARCH_DAYS: readonly DayStat[] = periodDays().map((ymd, index) => ({
  ymd,
  impressions: 1000 + 10 * index,
  clicks: 40 + index,
  conversions: index % 3,
  spend: kopecks(1001 + index),
  source: ConversionSource.PLATFORM,
}));

export const SEARCH_TOTALS: ExpectedTotals = {
  impressions: 34_350,
  clicks: 1_635,
  spend: 304.65,
  conversions: 30,
};

/** CPA = 304,65 / 30. Целевой — 250,00, значит кампания дешевле цели. */
export const SEARCH_CPA = 10.155;
export const SEARCH_CTR = 1_635 / 34_350;
export const SEARCH_DAILY_BUDGET = '1500.55';
export const SEARCH_TARGET_CPA = '250.45';

/**
 * Соседние сутки за границей окна. Числа заведомо огромные: протечка границы
 * даст расхождение в разы, а не в третьем знаке, где её можно не заметить.
 */
export const SEARCH_OUTSIDE: readonly DayStat[] = [
  {
    ymd: DAY_BEFORE_FROM,
    impressions: 500_000,
    clicks: 400_000,
    conversions: 5_000,
    spend: '50000.00',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: DAY_AFTER_TO,
    impressions: 700_000,
    clicks: 600_000,
    conversions: 7_000,
    spend: '70000.00',
    source: ConversionSource.PLATFORM,
  },
];

/**
 * Кампания «Ретаргет»: конверсии считает Метрика, и их ноль при ненулевом
 * расходе — это и есть деление на ноль в чистом виде.
 */
export const RETARGET_DAYS: readonly DayStat[] = periodDays().map((ymd) => ({
  ymd,
  impressions: 500,
  clicks: 20,
  conversions: 0,
  spend: '5.00',
  source: ConversionSource.METRIKA,
}));

export const RETARGET_TOTALS: ExpectedTotals = {
  impressions: 15_000,
  clicks: 600,
  spend: 150,
  conversions: 0,
};

/** Клиент «Полёт» = «Поиск» + «Ретаргет»: PLATFORM и METRIKA в одной строке. */
export const FLIGHT_TOTALS: ExpectedTotals = {
  impressions: 49_350,
  clicks: 2_235,
  spend: 454.65,
  conversions: 30,
};

/** Тридцать суток нулей: строки статистики есть, а показов, кликов и денег нет. */
export const SILENT_DAYS: readonly DayStat[] = periodDays().map((ymd) => ({
  ymd,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  spend: '0.0000',
  source: ConversionSource.PLATFORM,
}));

/**
 * Три дня с замером и два без. `NONE` — не третья модель атрибуции, поэтому
 * выборка обязана считаться однородной, а CPA — показываться.
 */
export const PARTIAL_DAYS: readonly DayStat[] = [
  {
    ymd: '2026-07-05',
    impressions: 100,
    clicks: 10,
    conversions: 2,
    spend: '30.00',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: '2026-07-06',
    impressions: 100,
    clicks: 10,
    conversions: 2,
    spend: '30.00',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: '2026-07-07',
    impressions: 100,
    clicks: 10,
    conversions: 2,
    spend: '30.00',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: '2026-07-08',
    impressions: 100,
    clicks: 10,
    conversions: 0,
    spend: '15.00',
    source: ConversionSource.NONE,
  },
  {
    ymd: '2026-07-09',
    impressions: 100,
    clicks: 10,
    conversions: 0,
    spend: '15.00',
    source: ConversionSource.NONE,
  },
];

export const PARTIAL_TOTALS: ExpectedTotals = {
  impressions: 500,
  clicks: 50,
  spend: 120,
  conversions: 6,
};

/** 120,00 / 6 — ровно 20,00 ₽. */
export const PARTIAL_CPA = 20;

/**
 * Копейки: 0.1 + 0.2 + 0.3 в двоичном float даёт 0.6000000000000001.
 * В `numeric` — ровно 0.6, и сценарий требует именно этого.
 */
export const KOPEIKI_DAYS: readonly DayStat[] = [
  {
    ymd: '2026-07-11',
    impressions: 10,
    clicks: 1,
    conversions: 1,
    spend: '0.1000',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: '2026-07-12',
    impressions: 10,
    clicks: 1,
    conversions: 1,
    spend: '0.2000',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: '2026-07-13',
    impressions: 10,
    clicks: 1,
    conversions: 1,
    spend: '0.3000',
    source: ConversionSource.PLATFORM,
  },
];

export const KOPEIKI_SPEND = 0.6;
export const KOPEIKI_CPA = 0.2;

/** Верхний край `DECIMAL(14,4)`: сумма обязана остаться точной. */
export const BIG_MONEY_DAYS: readonly DayStat[] = [
  {
    ymd: '2026-07-11',
    impressions: 1,
    clicks: 1,
    conversions: 3,
    spend: '9999999.9999',
    source: ConversionSource.PLATFORM,
  },
  {
    ymd: '2026-07-12',
    impressions: 1,
    clicks: 1,
    conversions: 1,
    spend: '0.0001',
    source: ConversionSource.PLATFORM,
  },
];

export const BIG_MONEY_SPEND = 10_000_000;
export const BIG_MONEY_CPA = 2_500_000;

/** Telegram message id выше 2^53: в JS-числе он потерял бы последнюю цифру. */
export const HUGE_TG_MESSAGE_ID = 9_007_199_254_740_993n;

export const CHANGE_ACTIONS = {
  atPeriodStart: 'edge-at-period-start',
  atPeriodEnd: 'edge-at-period-end',
  justBefore: 'edge-just-before-period',
  justAfter: 'edge-just-after-period',
  midPeriod: 'mid-period-budget',
} as const;

/**
 * Пять апрувов ждут решения, четыре уже решены.
 *
 * Очередь (`PENDING`) периодом не режется: апрув, прождавший дольше окна, —
 * ровно тот, о котором забыли. Периодом режется история решений, поэтому
 * границы окна проверяются на `decided*`.
 */
export const APPROVAL_SUMMARIES = {
  atPeriodStart: 'edge-approval-at-period-start',
  atPeriodEnd: 'edge-approval-at-period-end',
  justBefore: 'edge-approval-just-before',
  justAfter: 'edge-approval-just-after',
  huge: 'approval-with-huge-message-id',
  decidedAtPeriodStart: 'decided-approval-at-period-start',
  decidedAtPeriodEnd: 'decided-approval-at-period-end',
  decidedJustBefore: 'decided-approval-just-before',
  decidedJustAfter: 'decided-approval-just-after',
} as const;

/** Сколько апрувов в сиде ждёт решения — столько же обязан показать счётчик в шапке. */
export const PENDING_APPROVAL_COUNT = 5;

function kopecks(total: number): string {
  const rubles = Math.trunc(total / 100);
  const rest = total % 100;
  return `${rubles}.${String(rest).padStart(2, '0')}`;
}

export interface SeededDashboard {
  readonly clientIds: Readonly<Record<keyof typeof CLIENT_NAMES, string>>;
  readonly campaignIds: Readonly<Record<keyof typeof EXTERNAL, string>>;
}

interface CampaignSeed {
  readonly key: keyof typeof EXTERNAL;
  readonly provider: Provider;
  readonly status: CampaignStatus;
  readonly name: string;
  readonly dailyBudget: string;
  readonly targetCpa: string | null;
  readonly days: readonly DayStat[];
}

async function createClient(
  name: string,
  tgUserId: bigint,
  status: ClientStatus,
  tgUsername: string | null,
): Promise<string> {
  const client = await prisma.client.create({
    data: { name, tgUserId, tgUsername, status },
    select: { id: true },
  });
  return client.id;
}

async function createCampaign(clientId: string, seed: CampaignSeed): Promise<string> {
  const campaign = await prisma.campaign.create({
    data: {
      clientId,
      externalId: EXTERNAL[seed.key],
      provider: seed.provider,
      status: seed.status,
      name: seed.name,
      dailyBudget: seed.dailyBudget,
      targetCpa: seed.targetCpa,
      strategy: 'MAXIMUM_CONVERSIONS',
    },
    select: { id: true },
  });

  await writeStats(campaign.id, seed.days);
  return campaign.id;
}

export async function writeStats(entityId: string, days: readonly DayStat[]): Promise<void> {
  if (days.length === 0) return;
  await prisma.campaignStat.createMany({
    data: days.map((day) => ({
      entityType: StatEntityType.CAMPAIGN,
      entityId,
      date: dateColumn(day.ymd),
      impressions: day.impressions,
      clicks: day.clicks,
      spend: day.spend,
      conversions: day.conversions,
      conversionSource: day.source,
    })),
  });
}

/**
 * Строки групп, объявлений и фраз с тем же `entityId`, что у кампании.
 *
 * `CampaignStat` полиморфна, а `entityId` — просто TEXT: без фильтра по
 * `entityType` эти строки формально сравнимы с кампанийными и попали бы в
 * сумму. В жизни cuid не совпадут, но защищает от этого именно фильтр, и
 * проверять надо его, а не удачу.
 */
async function writePolymorphicNoise(entityId: string): Promise<void> {
  const types = [StatEntityType.ADGROUP, StatEntityType.AD, StatEntityType.KEYWORD];
  await prisma.campaignStat.createMany({
    data: types.map((entityType, index) => ({
      entityType,
      entityId,
      date: dateColumn(addDays(PERIOD_FROM, index)),
      impressions: 900_000,
      clicks: 800_000,
      spend: '90000.0000',
      conversions: 9_000,
      conversionSource: ConversionSource.METRIKA,
    })),
  });
}

export async function seedDashboard(): Promise<SeededDashboard> {
  const flight = await createClient(CLIENT_NAMES.flight, 9_001n, 'ACTIVE', 'flight_ads');
  const silence = await createClient(CLIENT_NAMES.silence, 9_002n, 'PAUSED', null);
  const empty = await createClient(CLIENT_NAMES.empty, 9_003n, 'ACTIVE', null);
  const partial = await createClient(CLIENT_NAMES.partial, 9_004n, 'ACTIVE', null);
  const money = await createClient(CLIENT_NAMES.money, 9_005n, 'ACTIVE', null);

  // Канал, у которого кампаний ещё нет: строка клиента обязана показать его
  // из Credential, иначе подключённый кабинет исчезнет с витрины.
  await prisma.credential.createMany({
    data: [
      {
        clientId: flight,
        provider: Provider.YANDEX_DIRECT,
        encryptedPayload: Buffer.from([1, 2, 3]),
        iv: Buffer.from([4, 5, 6]),
        tag: Buffer.from([7, 8, 9]),
      },
      {
        clientId: flight,
        provider: Provider.TIKTOK_ADS,
        encryptedPayload: Buffer.from([1, 2, 3]),
        iv: Buffer.from([4, 5, 6]),
        tag: Buffer.from([7, 8, 9]),
      },
    ],
  });

  const search = await createCampaign(flight, {
    key: 'search',
    provider: Provider.YANDEX_DIRECT,
    status: 'ACTIVE',
    name: 'Поиск — доставка',
    dailyBudget: SEARCH_DAILY_BUDGET,
    targetCpa: SEARCH_TARGET_CPA,
    days: SEARCH_DAYS,
  });
  await writeStats(search, SEARCH_OUTSIDE);
  await writePolymorphicNoise(search);

  const retarget = await createCampaign(flight, {
    key: 'retarget',
    provider: Provider.VK_ADS,
    status: 'PAUSED',
    name: 'Ретаргет — VK',
    dailyBudget: '700.00',
    targetCpa: null,
    days: RETARGET_DAYS,
  });

  const silentActive = await createCampaign(silence, {
    key: 'silentActive',
    provider: Provider.YANDEX_DIRECT,
    status: 'ACTIVE',
    name: 'Молчащая — есть строки, нет цифр',
    dailyBudget: '100.00',
    targetCpa: '500.00',
    days: SILENT_DAYS,
  });

  const silentNoStats = await createCampaign(silence, {
    key: 'silentNoStats',
    provider: Provider.VK_ADS,
    status: 'DRAFT',
    name: 'Черновик — статистики нет вовсе',
    dailyBudget: '0.00',
    targetCpa: null,
    days: [],
  });

  const partialSource = await createCampaign(partial, {
    key: 'partialSource',
    provider: Provider.YANDEX_DIRECT,
    status: 'ACTIVE',
    name: 'Частичный замер',
    dailyBudget: '300.00',
    targetCpa: '18.00',
    days: PARTIAL_DAYS,
  });

  const kopeiki = await createCampaign(money, {
    key: 'kopeiki',
    provider: Provider.VK_ADS,
    status: 'ACTIVE',
    name: 'Копейки',
    dailyBudget: '0.01',
    targetCpa: '0.15',
    days: KOPEIKI_DAYS,
  });

  const bigMoney = await createCampaign(money, {
    key: 'bigMoney',
    provider: Provider.YANDEX_DIRECT,
    status: 'ACTIVE',
    name: 'Большие деньги',
    dailyBudget: '9999999.99',
    targetCpa: '2000000.00',
    days: BIG_MONEY_DAYS,
  });

  await seedChangeLog(search);
  await seedApprovals(flight);

  return {
    clientIds: { flight, silence, empty, partial, money },
    campaignIds: {
      search,
      retarget,
      silentActive,
      silentNoStats,
      partialSource,
      kopeiki,
      bigMoney,
    },
  };
}

/**
 * `ChangeLog.appliedAt` — timestamp, а не дата, поэтому границы окна берутся по
 * московской полуночи. Четыре строки стоят вплотную к краям: миллисекунда в
 * любую сторону меняет ответ.
 */
async function seedChangeLog(campaignId: string): Promise<void> {
  await prisma.changeLog.createMany({
    data: [
      {
        campaignId,
        entityType: 'CAMPAIGN',
        entityId: EXTERNAL.search,
        action: CHANGE_ACTIONS.atPeriodStart,
        actor: 'SYSTEM',
        provider: Provider.YANDEX_DIRECT,
        appliedAt: mskInstant(PERIOD_FROM, '00:00:00.000'),
      },
      {
        campaignId,
        entityType: 'CAMPAIGN',
        entityId: EXTERNAL.search,
        action: CHANGE_ACTIONS.atPeriodEnd,
        actor: 'SYSTEM',
        provider: Provider.YANDEX_DIRECT,
        appliedAt: mskInstant(PERIOD_TO, '23:59:59.999'),
      },
      {
        campaignId,
        entityType: 'CAMPAIGN',
        entityId: EXTERNAL.search,
        action: CHANGE_ACTIONS.justBefore,
        actor: 'SYSTEM',
        provider: Provider.YANDEX_DIRECT,
        appliedAt: mskInstant(DAY_BEFORE_FROM, '23:59:59.999'),
      },
      {
        campaignId,
        entityType: 'CAMPAIGN',
        entityId: EXTERNAL.search,
        action: CHANGE_ACTIONS.justAfter,
        actor: 'SYSTEM',
        provider: Provider.YANDEX_DIRECT,
        appliedAt: mskInstant(DAY_AFTER_TO, '00:00:00.000'),
      },
      {
        campaignId,
        entityType: 'CAMPAIGN',
        entityId: EXTERNAL.search,
        action: CHANGE_ACTIONS.midPeriod,
        actor: 'USER',
        approvedBy: 'roman',
        reason: 'CPA ниже цели третий день',
        provider: Provider.YANDEX_DIRECT,
        // Json-колонки: наружу они обязаны уехать без Decimal и BigInt внутри.
        prevValue: { dailyBudget: 1500.55, targetCpa: null },
        newValue: { dailyBudget: 1800.4, targetCpa: 250.45, nested: { flags: [true, null, 2] } },
        appliedAt: mskInstant('2026-07-15', '12:00:00.000'),
      },
    ],
  });
}

async function seedApprovals(clientId: string): Promise<void> {
  const base = {
    clientId,
    kind: 'BUDGET_CHANGE' as const,
    payload: { campaignExternalId: EXTERNAL.search, delta: 300.5 },
    expiresAt: mskInstant('2026-07-16', '12:00:00.000'),
  };

  await prisma.pendingApproval.createMany({
    data: [
      {
        ...base,
        summary: APPROVAL_SUMMARIES.atPeriodStart,
        createdAt: mskInstant(PERIOD_FROM, '00:00:00.000'),
      },
      {
        ...base,
        summary: APPROVAL_SUMMARIES.atPeriodEnd,
        createdAt: mskInstant(PERIOD_TO, '23:59:59.999'),
      },
      {
        ...base,
        summary: APPROVAL_SUMMARIES.justBefore,
        createdAt: mskInstant(DAY_BEFORE_FROM, '23:59:59.999'),
      },
      {
        ...base,
        summary: APPROVAL_SUMMARIES.justAfter,
        createdAt: mskInstant(DAY_AFTER_TO, '00:00:00.000'),
      },
      {
        ...base,
        summary: APPROVAL_SUMMARIES.huge,
        tgMessageId: HUGE_TG_MESSAGE_ID,
        createdAt: mskInstant('2026-07-15', '10:00:00.000'),
      },
    ],
  });

  const decided = {
    ...base,
    decision: 'APPROVED' as const,
    respondedBy: 'roman',
  };

  await prisma.pendingApproval.createMany({
    data: [
      {
        ...decided,
        summary: APPROVAL_SUMMARIES.decidedAtPeriodStart,
        createdAt: mskInstant(PERIOD_FROM, '00:00:00.000'),
        decidedAt: mskInstant(PERIOD_FROM, '09:00:00.000'),
      },
      {
        ...decided,
        summary: APPROVAL_SUMMARIES.decidedAtPeriodEnd,
        createdAt: mskInstant(PERIOD_TO, '23:59:59.999'),
        decidedAt: mskInstant(DAY_AFTER_TO, '09:00:00.000'),
      },
      {
        ...decided,
        summary: APPROVAL_SUMMARIES.decidedJustBefore,
        createdAt: mskInstant(DAY_BEFORE_FROM, '23:59:59.999'),
        decidedAt: mskInstant(PERIOD_FROM, '09:00:00.000'),
      },
      {
        ...decided,
        summary: APPROVAL_SUMMARIES.decidedJustAfter,
        createdAt: mskInstant(DAY_AFTER_TO, '00:00:00.000'),
        decidedAt: mskInstant(DAY_AFTER_TO, '09:00:00.000'),
      },
    ],
  });
}

/**
 * Группы объявлений со ставками.
 *
 * Ставка задаётся строкой по той же причине, что и деньги выше: `AdGroup.bid` —
 * `DECIMAL(12,2)`, и JS-число потеряло бы копейки ещё до вставки.
 *
 * `null` и `'0.00'` в одном наборе стоят намеренно: это два разных состояния —
 * «ручной ставки нет, цену назначает площадка» и «ставка ноль». Витрина обязана
 * различать их, а не показывать одинаковый прочерк или одинаковый ноль.
 */
export interface AdGroupSeed {
  readonly externalId: string;
  readonly name: string;
  readonly status?: AdGroupStatus;
  readonly bid: string | null;
}

export async function seedAdGroups(
  campaignId: string,
  groups: readonly AdGroupSeed[],
): Promise<void> {
  if (groups.length === 0) return;
  await prisma.adGroup.createMany({
    data: groups.map((group) => ({
      campaignId,
      externalId: group.externalId,
      name: group.name,
      status: group.status ?? 'ACTIVE',
      bid: group.bid,
    })),
  });
}

/**
 * Группы кампании VK: у канала нет ключевых слов вовсе, и ставка группы —
 * единственный рычаг управления ценой. Ряд подобран так, чтобы на нём было видно
 * и «ноль», и «не задано», и разброс между минимумом и максимумом.
 */
export const VK_AD_GROUPS: readonly AdGroupSeed[] = [
  { externalId: 'ext-vk-group-1', name: 'Аудитория — похожие', bid: '12.34' },
  { externalId: 'ext-vk-group-2', name: 'Аудитория — ретаргет', bid: '0.00' },
  { externalId: 'ext-vk-group-3', name: 'Аудитория — автостратегия', bid: null },
  { externalId: 'ext-vk-group-4', name: 'Аудитория — широкая', bid: '99.99', status: 'PAUSED' },
];

export const VK_BID_MIN = 0;
export const VK_BID_MAX = 99.99;
export const VK_BID_SET = 3;

/**
 * Пара строк журнала за одно изменение ставки, выпущенное человеком.
 *
 * Ровно то, что пишет `approval/apply.ts` вместе с `approval/bid-journal.ts`:
 * аудиторская строка про решение (внешний id площадки, `entityType` в нижнем
 * регистре, `approvedBy` только внутри `newValue`) и каноническая строка про
 * ставку (наш id, верхний регистр, заполненные колонки `approvedBy` и `provider`).
 * Формы скопированы с настоящих писателей — иначе сценарий проверял бы выдумку.
 */
export const BID_PAIR = {
  keywordExternalId: 'ext-kw-77',
  bidBefore: 30,
  bidAfter: 24,
  approvedBy: 'roman',
  reason: 'CPA выше цели третьи сутки',
  at: mskInstant('2026-07-16', '11:00:00.000'),
} as const;

export async function seedApprovedBidChange(
  campaignId: string,
  entityId: string,
  provider: Provider = Provider.YANDEX_DIRECT,
): Promise<void> {
  await prisma.changeLog.create({
    data: {
      // Аудиторская строка кампанию не проставляет: у `bid_change` нет внешнего
      // id кампании, по которому её можно было бы найти (см. `changeSnapshot`).
      campaignId: null,
      entityType: 'keyword',
      entityId: BID_PAIR.keywordExternalId,
      action: 'bid_change',
      prevValue: [{ keywordExternalId: BID_PAIR.keywordExternalId, bid: BID_PAIR.bidBefore }],
      newValue: {
        change: [{ keywordExternalId: BID_PAIR.keywordExternalId, bid: BID_PAIR.bidAfter }],
        dryRun: false,
        applied: true,
        plan: {},
        provider,
        approvedBy: BID_PAIR.approvedBy,
      },
      reason: BID_PAIR.reason,
      actor: ChangeActor.USER,
      appliedAt: BID_PAIR.at,
    },
  });

  await prisma.changeLog.create({
    data: {
      campaignId,
      entityType: 'KEYWORD',
      entityId,
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: BID_PAIR.bidBefore },
      newValue: { kind: 'bid', amount: BID_PAIR.bidAfter },
      reason: BID_PAIR.reason,
      actor: ChangeActor.USER,
      approvedBy: BID_PAIR.approvedBy,
      provider,
      appliedAt: new Date(BID_PAIR.at.getTime() + 1_000),
    },
  });
}

/** Та же ставка, но от ночного прогона: пары у неё нет и быть не может. */
export async function seedOptimizerBidChange(
  campaignId: string,
  entityId: string,
  provider: Provider = Provider.YANDEX_DIRECT,
): Promise<void> {
  await prisma.changeLog.create({
    data: {
      campaignId,
      entityType: 'KEYWORD',
      entityId,
      action: 'BID_INCREASE',
      prevValue: { kind: 'bid', amount: 10 },
      newValue: { kind: 'bid', amount: 12 },
      reason: 'CPA ниже цели',
      actor: ChangeActor.AI,
      provider,
      appliedAt: mskInstant('2026-07-17', '03:00:00.000'),
    },
  });
}
