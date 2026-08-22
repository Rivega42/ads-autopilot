import {
  ClientStatus,
  ConversionSource,
  Provider,
  StatEntityType,
  type Prisma,
} from '@prisma/client';

import { prisma } from '@/db/prisma.js';

/**
 * Фикстуры сценариев отчётности.
 *
 * Даты здесь фиксированные, а не «сегодня минус сутки». Отчёт — это текст, где
 * каждая цифра сверяется посимвольно, и плавающий календарь означал бы, что
 * ожидания приходится считать той же арифметикой, что и проверяемый код.
 * Момент прогона всегда передаётся в `now` явно, поэтому настоящая дата машины
 * на сценарий не влияет вовсе.
 *
 * Формат чисел и снятие экранирования продублированы здесь намеренно, а не
 * взяты из `src/reporter/format.ts`: сценарий обязан знать, как отчёт должен
 * выглядеть, независимо от того, как он собирается. Плата — при осознанной
 * смене формата править придётся два места; это и есть сигнал, что формат
 * изменился для клиента.
 */

/** Сутки дневного отчёта. */
export const REPORT_DAY = '2026-08-20';
/** База сравнения дневного отчёта. */
export const PREVIOUS_DAY = '2026-08-19';
/** Последние семь полных суток на момент прогона. */
export const REPORT_WEEK = { from: '2026-08-14', to: '2026-08-20' } as const;
/** Неделя до неё: база сравнения недельного разбора. */
export const PREVIOUS_WEEK = { from: '2026-08-07', to: '2026-08-13' } as const;

/** 08:30 МСК 21.08.2026 — штатное время крона `daily-report`. */
export const MORNING_RUN = new Date('2026-08-21T05:30:00Z');
/**
 * 21:30 МСК тех же суток. Полоса, в которой жил двойной сдвиг из
 * `src/lib/dates.ts`: «вчера» превращалось в «сегодня», и отчёт по требованию
 * вечером показывал не тот день. Крон в 08:30 сюда не попадает — поэтому баг и
 * не проявлялся.
 */
export const EVENING_RUN = new Date('2026-08-21T18:30:00Z');
/** 00:30 МСК тех же суток: обратный край, где по UTC ещё предыдущие сутки. */
export const PAST_MIDNIGHT_RUN = new Date('2026-08-20T21:30:00Z');

/**
 * `yyyy-MM-dd` → значение колонки `@db.Date`.
 *
 * Своя копия, а не `ymdToDateColumn` из `src/ingestion/window.ts`: уедь сдвиг
 * там — засев и чтение уехали бы одинаково, и сценарий остался бы зелёным,
 * рассказывая про чужие сутки.
 */
export function dateColumn(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Все даты отрезка по возрастанию, обе границы включительно. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = dateColumn(from); cursor <= dateColumn(to);) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return days;
}

// ── Ожидаемое форматирование ─────────────────────────────────────────────────

/** `3500` → `3 500`. Разделитель — обычный пробел U+0020. */
export function int(value: number): string {
  const rounded = Math.round(value);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return rounded < 0 ? `−${digits}` : digits;
}

/** `3500` → `3 500 ₽`. */
export function rub(value: number): string {
  return `${int(value)} ₽`;
}

/** Доля `0.04375` → `4,38%`. */
export function ratio(value: number): string {
  return `${(value * 100).toFixed(2).replace('.', ',')}%`;
}

/** Изменение к базе: `+40%`, `−7%`, `0%`. Минус — типографский, как в отчёте. */
export function pctChange(current: number, previous: number): string {
  const rounded = Math.round(((current - previous) / previous) * 100);
  if (rounded === 0) return '0%';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

/**
 * Снимает экранирование MarkdownV2.
 *
 * Содержание отчёта проверяется по снятому тексту, а сам факт экранирования —
 * отдельной проверкой по сырому телу: иначе каждая строка ожидания превращается
 * в частокол обратных слэшей и перестаёт читаться.
 */
export function plain(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

// ── Засев ────────────────────────────────────────────────────────────────────

export interface DayStat {
  ymd: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}

export interface CampaignSeed {
  /** Ключ, по которому сценарий достаёт id строки. */
  alias: string;
  externalId: string;
  name: string;
  targetCpa?: number;
  days?: readonly DayStat[];
}

export interface ReportClientSeed {
  tgUserId: bigint;
  name: string;
  status?: ClientStatus;
  campaigns: readonly CampaignSeed[];
}

export interface SeededReportClient {
  clientId: string;
  name: string;
  chatId: string;
  /** alias → id строки `Campaign`. */
  campaignIds: Record<string, string>;
  /** Все кампании клиента: по ним считается ожидаемый итог. */
  allCampaignIds: string[];
}

/**
 * Клиент со своими кампаниями и статистикой.
 *
 * Каждый сценарий берёт своего клиента: прогон отчётов обходит всех активных
 * разом, и общий клиент означал бы, что сводка одного сценария складывается из
 * строк другого.
 */
export async function seedReportClient(seed: ReportClientSeed): Promise<SeededReportClient> {
  const client = await prisma.client.create({
    data: {
      tgUserId: seed.tgUserId,
      name: seed.name,
      status: seed.status ?? ClientStatus.ACTIVE,
    },
  });

  const campaignIds: Record<string, string> = {};
  const stats: Prisma.CampaignStatCreateManyInput[] = [];

  for (const seedCampaign of seed.campaigns) {
    const campaign = await prisma.campaign.create({
      data: {
        clientId: client.id,
        provider: Provider.YANDEX_DIRECT,
        externalId: seedCampaign.externalId,
        name: seedCampaign.name,
        status: 'ACTIVE',
        dailyBudget: 5000,
        ...(seedCampaign.targetCpa === undefined ? {} : { targetCpa: seedCampaign.targetCpa }),
      },
      select: { id: true },
    });
    campaignIds[seedCampaign.alias] = campaign.id;

    for (const day of seedCampaign.days ?? []) {
      stats.push({
        entityType: StatEntityType.CAMPAIGN,
        entityId: campaign.id,
        date: dateColumn(day.ymd),
        impressions: day.impressions,
        clicks: day.clicks,
        spend: day.spend,
        conversions: day.conversions,
        // Одна модель атрибуции на весь засев: смешение — отдельный сценарий
        // загрузки, здесь оно только зашумило бы подпись под цифрами.
        conversionSource: ConversionSource.PLATFORM,
      });
    }
  }

  if (stats.length > 0) await prisma.campaignStat.createMany({ data: stats });

  return {
    clientId: client.id,
    name: seed.name,
    chatId: client.tgUserId.toString(),
    campaignIds,
    allCampaignIds: Object.values(campaignIds),
  };
}

/** Добавляет строку статистики после того, как отчёт уже посчитан. */
export async function addStat(campaignId: string, day: DayStat): Promise<void> {
  await prisma.campaignStat.create({
    data: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: campaignId,
      date: dateColumn(day.ymd),
      impressions: day.impressions,
      clicks: day.clicks,
      spend: day.spend,
      conversions: day.conversions,
      conversionSource: ConversionSource.PLATFORM,
    },
  });
}

// ── Ожидания из базы ─────────────────────────────────────────────────────────

export interface DbTotals {
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
  /** `null`, если конверсий не было: делить не на что. */
  cpa: number | null;
  ctr: number | null;
}

/**
 * Итог по кампаниям за период — прямым запросом к базе.
 *
 * Смысл именно в этом: ожидания сценария считает Postgres, а не тот же код,
 * который собирает отчёт. Совпадение сумм тогда что-то доказывает.
 */
export async function totalsFromDb(
  campaignIds: readonly string[],
  period: { from: string; to: string },
): Promise<DbTotals> {
  const agg = await prisma.campaignStat.aggregate({
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: { in: [...campaignIds] },
      date: { gte: dateColumn(period.from), lte: dateColumn(period.to) },
    },
    _sum: { impressions: true, clicks: true, conversions: true, spend: true },
  });

  const impressions = agg._sum.impressions ?? 0;
  const clicks = agg._sum.clicks ?? 0;
  const conversions = agg._sum.conversions ?? 0;
  const spend = Number(agg._sum.spend ?? 0);

  return {
    impressions,
    clicks,
    conversions,
    spend,
    cpa: conversions > 0 ? spend / conversions : null,
    ctr: impressions > 0 ? clicks / impressions : null,
  };
}

/** Расход по дням из базы: с ним сверяется ряд графика. */
export async function spendByDayFromDb(
  campaignIds: readonly string[],
  period: { from: string; to: string },
): Promise<Map<string, number>> {
  const rows = await prisma.campaignStat.groupBy({
    by: ['date'],
    where: {
      entityType: StatEntityType.CAMPAIGN,
      entityId: { in: [...campaignIds] },
      date: { gte: dateColumn(period.from), lte: dateColumn(period.to) },
    },
    _sum: { spend: true },
  });
  return new Map(
    rows.map((row) => [row.date.toISOString().slice(0, 10), Number(row._sum.spend ?? 0)]),
  );
}

// ── Готовые кабинеты ─────────────────────────────────────────────────────────

/** Кампании пекарни: ключи для `campaignIds`. */
export const BAKERY = { search: 'search', network: 'network' } as const;

const BAKERY_WINDOW = daysBetween('2026-08-07', REPORT_DAY);

/**
 * Основной кабинет сценария: две недели ровного ряда и выделяющийся вчерашний день.
 *
 * Числа подобраны так, чтобы каждая проверяемая величина имела ровно одну
 * причину: расход поисковой кампании вырос ровно в полтора раза (порог всплеска
 * — 50%), а по клиенту целиком рост всего 40% — значит аномалия обязана быть
 * одна и именно по кампании. Название со скобками и тире взято нарочно: в
 * MarkdownV2 это спецсимволы, и неэкранированное имя роняет отправку целиком.
 */
export function seedBakery(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000001n,
    name: 'Пекарня «Хлеб и Соль»',
    campaigns: [
      {
        alias: BAKERY.search,
        externalId: '9101',
        name: 'Поиск — торты (Москва)',
        targetCpa: 1000,
        days: BAKERY_WINDOW.map((ymd) =>
          ymd === REPORT_DAY
            ? { ymd, impressions: 12_000, clicks: 600, spend: 3_000, conversions: 5 }
            : { ymd, impressions: 10_000, clicks: 500, spend: 2_000, conversions: 4 },
        ),
      },
      {
        alias: BAKERY.network,
        externalId: '9102',
        name: 'РСЯ — доставка',
        days: BAKERY_WINDOW.map((ymd) => ({
          ymd,
          impressions: 4_000,
          clicks: 100,
          spend: 500,
          conversions: 1,
        })),
      },
    ],
  });
}

/** Активный клиент с кампанией, по которой не загрузилось ни одной строки. */
export function seedSilent(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000002n,
    name: 'Автосервис «Гайка»',
    campaigns: [{ alias: 'idle', externalId: '9201', name: 'Поиск — развал-схождение' }],
  });
}

/** Активный клиент, у которого нет ещё ни одной кампании: онбординг не дошёл до запуска. */
export function seedWithoutCampaigns(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000003n,
    name: 'Студия «Начало»',
    campaigns: [],
  });
}

/** Остановленный клиент с полными данными: отчёт ему уходить не должен. */
export function seedPaused(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000004n,
    name: 'Химчистка «Пятно» (на паузе)',
    status: ClientStatus.PAUSED,
    campaigns: [
      {
        alias: 'search',
        externalId: '9301',
        name: 'Поиск — химчистка',
        days: daysBetween(PREVIOUS_DAY, REPORT_DAY).map((ymd) => ({
          ymd,
          impressions: 5_000,
          clicks: 200,
          spend: 1_000,
          conversions: 2,
        })),
      },
    ],
  });
}

/** Кабинет для сценария «Telegram отвалился»: свой, чтобы правка данных не задела остальных. */
export function seedFlaky(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000005n,
    name: 'Клиника «Ромашка»',
    campaigns: [
      {
        alias: 'search',
        externalId: '9401',
        name: 'Поиск — приём терапевта',
        days: daysBetween(PREVIOUS_DAY, REPORT_DAY).map((ymd) => ({
          ymd,
          impressions: 8_000,
          clicks: 300,
          spend: 1_500,
          conversions: 3,
        })),
      },
      { alias: 'late', externalId: '9402', name: 'РСЯ — приём терапевта' },
    ],
  });
}

/** Кабинет для проверки границ суток: данные ровно за два дня. */
export function seedTimezone(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000006n,
    name: 'Курсы «Часовой пояс»',
    campaigns: [
      {
        alias: 'search',
        externalId: '9501',
        name: 'Поиск — курсы',
        days: [
          { ymd: PREVIOUS_DAY, impressions: 1_000, clicks: 40, spend: 700, conversions: 1 },
          { ymd: REPORT_DAY, impressions: 2_000, clicks: 90, spend: 1_300, conversions: 2 },
        ],
      },
    ],
  });
}
