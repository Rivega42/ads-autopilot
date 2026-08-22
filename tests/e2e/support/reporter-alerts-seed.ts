import type { Prisma, Provider } from '@prisma/client';

import { daysBetween, seedReportClient, type SeededReportClient } from './reporter-seed.js';

import { prisma } from '@/db/prisma.js';

/**
 * Фикстуры сценария тревог.
 *
 * Тревоги читают два источника: `ErrorLog` (всплеск, 401, units) и
 * `CampaignStat` (аномальный расход). Оба засеваются здесь напрямую, а не
 * прогоном загрузки: проверяется реакция на состояние базы, и путь, которым
 * это состояние возникло, к делу не относится.
 *
 * Момент прогона фиксирован и передаётся в `now` явно — окно всплеска
 * измеряется в минутах, и плавающее «сейчас» сделало бы границу окна
 * непроверяемой.
 */

/** 08:30 МСК 21.08.2026 — тик крона `alert-scan`. */
export const SCAN_AT = new Date('2026-08-21T05:30:00Z');

/** Момент, сдвинутый от тика на `minutes` минут. */
export function at(minutes: number): Date {
  return new Date(SCAN_AT.getTime() + minutes * 60_000);
}

export interface ErrorSeed {
  clientId?: string | null;
  provider?: Provider | null;
  scope?: string;
  code?: string | null;
  message?: string;
  /** Смещение от тика в минутах: отрицательное — раньше тика. */
  minutes: number;
  /** Сколько одинаковых строк положить; каждая на секунду позже предыдущей. */
  count?: number;
}

/**
 * Строки в `ErrorLog` с заданным временем.
 *
 * Секундный шаг внутри пачки — не косметика: порядок выборки задан по
 * `createdAt`, и при одинаковых значениях «первая ошибка» в тексте тревоги
 * оказалась бы случайной.
 */
export async function seedErrors(rows: readonly ErrorSeed[]): Promise<void> {
  const data: Prisma.ErrorLogCreateManyInput[] = [];
  for (const row of rows) {
    const count = row.count ?? 1;
    for (let i = 0; i < count; i += 1) {
      data.push({
        clientId: row.clientId ?? null,
        provider: row.provider ?? null,
        scope: row.scope ?? 'clients:yandex-direct',
        code: row.code ?? null,
        message: row.message ?? 'Кабинет ответил 500',
        createdAt: new Date(at(row.minutes).getTime() + i * 1_000),
      });
    }
  }
  await prisma.errorLog.createMany({ data });
}

export async function clearErrors(): Promise<void> {
  await prisma.errorLog.deleteMany({});
}

/** Кабинет, от имени которого приходят ошибки. Кампаний нет — расход тут ни при чём. */
export function seedCabinet(tgUserId: bigint, name: string): Promise<SeededReportClient> {
  return seedReportClient({ tgUserId, name, campaigns: [] });
}

const BASELINE = daysBetween('2026-08-13', '2026-08-19');

/**
 * Кабинет с всплеском расхода вчера и позавчера.
 *
 * Ровная история (σ = 0) выбрана намеренно: z-оценка на ней не определена, и
 * сработать обязан второй критерий — кратность среднему. Второй аномальный день
 * нужен, чтобы проверить, что назавтра тревога приходит снова: ключ подавления
 * содержит дату, и без этого повторная поломка осталась бы неизвестной.
 */
export function seedSpendSpike(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000021n,
    name: 'Кофейня «Зерно»',
    campaigns: [
      {
        alias: 'search',
        externalId: '9601',
        name: 'Поиск — кофе',
        days: [
          ...BASELINE.map((ymd) => ({
            ymd,
            impressions: 5_000,
            clicks: 200,
            spend: 2_000,
            conversions: 4,
          })),
          { ymd: '2026-08-20', impressions: 20_000, clicks: 900, spend: 9_000, conversions: 5 },
          { ymd: '2026-08-21', impressions: 21_000, clicks: 950, spend: 9_500, conversions: 5 },
        ],
      },
    ],
  });
}

/** Кабинет, у которого вчера расход почти остановился. */
export function seedSpendCollapse(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000022n,
    name: 'Барбершоп «Бритва»',
    campaigns: [
      {
        alias: 'search',
        externalId: '9701',
        name: 'Поиск — стрижка',
        days: [
          ...BASELINE.map((ymd) => ({
            ymd,
            impressions: 5_000,
            clicks: 200,
            spend: 2_000,
            conversions: 4,
          })),
          { ymd: '2026-08-20', impressions: 500, clicks: 20, spend: 200, conversions: 0 },
        ],
      },
    ],
  });
}

/** Контрольный кабинет: расход ровный, тревоги быть не должно. */
export function seedSpendSteady(): Promise<SeededReportClient> {
  return seedReportClient({
    tgUserId: 880000023n,
    name: 'Цветы «Пион»',
    campaigns: [
      {
        alias: 'search',
        externalId: '9801',
        name: 'Поиск — букеты',
        days: daysBetween('2026-08-13', '2026-08-20').map((ymd) => ({
          ymd,
          impressions: 5_000,
          clicks: 200,
          spend: 2_000,
          conversions: 4,
        })),
      },
    ],
  });
}
