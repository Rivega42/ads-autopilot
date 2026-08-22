import { StatEntityType } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import type { MetrikaGoalRow } from './support/ingestion-metrika-mock.js';
import { startIngestionMocks, type IngestionMocks } from './support/ingestion-mocks.js';
import {
  createCabinet,
  createSecondaryCabinet,
  IDS,
  METRIKA,
  SECONDARY_IDS,
  seedIngestionClient,
  TOKENS,
  WINDOW_DAYS,
  WINDOW_FROM,
  WINDOW_TO,
} from './support/ingestion-seed.js';

import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { runIngestion, syncMetrikaConversions } from '@/ingestion/index.js';

/**
 * Атрибуция: чьи конверсии лежат в колонке `conversions`.
 *
 * Колонка одна, а моделей две — своя у Директа и своя у Метрики, — поэтому
 * проверяется не только «цифра приехала», но и «источник у всего окна один».
 * Смешение здесь не «странность», а несопоставимый CPA у соседних кампаний:
 * именно по нему оптимизатор переносит бюджет.
 */

/** Метрика возвращает срез кампании человекочитаемым именем с номером внутри. */
const LABEL = (id: number): string => `Кофемашины — поиск (№${id})`;

/** Подменяется одним из случаев: имя кампании задаёт человек, а не мы. */
let label: (id: number) => string = LABEL;

/** Сутки, по которым Метрика что-то знает. Остальные — её молчание, то есть ноль. */
const REPORTED = WINDOW_DAYS.slice(-3);

let clientId: string;
let plainClientId: string;
let mocks: IngestionMocks;
let metrikaRows: MetrikaGoalRow[];

async function campaignId(externalId: number): Promise<string> {
  const row = await prisma.campaign.findFirstOrThrow({
    where: { externalId: String(externalId) },
    select: { id: true },
  });
  return row.id;
}

function statsOf(entityType: StatEntityType, entityId: string) {
  return prisma.campaignStat.findMany({
    where: { entityType, entityId },
    orderBy: { date: 'asc' },
  });
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('загрузка: атрибуция конверсий', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    metrikaRows = REPORTED.map((date, i) => ({
      date,
      campaignId: IDS.search,
      goalId: METRIKA.goalId,
      conversions: 5 + i,
      revenue: 12_000,
    }));
    // Кампания, которой в нашей базе нет: Метрика помнит её дольше, чем кабинет.
    metrikaRows.push({
      date: WINDOW_TO,
      campaignId: 87_650_000,
      goalId: METRIKA.goalId,
      conversions: 3,
    });
    // Достижения чужой цели: их не должно быть видно вовсе.
    metrikaRows.push({
      date: WINDOW_TO,
      campaignId: IDS.search,
      goalId: METRIKA.goalId + 1,
      conversions: 999,
    });

    mocks = startIngestionMocks({
      yandex: {
        accounts: [
          { accessToken: TOKENS.primary, cabinet: createCabinet() },
          { accessToken: TOKENS.secondary, cabinet: createSecondaryCabinet() },
        ],
        pageSize: 2,
      },
      metrika: {
        oauthToken: TOKENS.primary,
        counterId: METRIKA.counterId,
        rows: metrikaRows,
        campaignLabel: (id) => label(id),
      },
    });

    clientId = await seedIngestionClient({
      name: 'ООО «Кофемолка»',
      tgUserId: 880_000_103n,
      accessToken: TOKENS.primary,
      metrika: { ...METRIKA, attribution: 'LAST_YANDEX_DIRECT_CLICK' },
    });
    plainClientId = await seedIngestionClient({
      name: 'ООО «Чайники» (без Метрики)',
      tgUserId: 880_000_104n,
      accessToken: TOKENS.secondary,
    });
  });

  afterAll(async () => {
    mocks?.close();
    await prisma.$disconnect();
  });

  it('полный прогон: конверсии Метрики перекрывают площадочные на уровне кампании', async () => {
    const summary = await runIngestion();

    expect(summary).toMatchObject({ targets: 2, ok: 2, failures: [] });
    // Три отчитанных дня одной кампании; чужая цель и чужая кампания не в счёт.
    expect(summary.conversionsWritten).toBe(REPORTED.length);

    const request = mocks.metrika.requests.at(-1);
    expect(request).toMatchObject({
      ids: String(METRIKA.counterId),
      metrics: `ym:s:goal${METRIKA.goalId}reaches,ym:s:goal${METRIKA.goalId}revenue`,
      dimensions: 'ym:s:date,ym:s:lastsignDirectClickOrder',
      // Окно то же самое, что у статистики: конверсии доезжают до 21 дня.
      date1: WINDOW_FROM,
      date2: WINDOW_TO,
      attribution: 'LAST_YANDEX_DIRECT_CLICK',
      accuracy: 'full',
    });

    const search = await campaignId(IDS.search);
    const rows = await statsOf(StatEntityType.CAMPAIGN, search);
    const reported = rows.filter((r) => REPORTED.includes(ymd(r.date)));
    expect(reported).toHaveLength(REPORTED.length);
    // Директ по этим суткам насчитал одну конверсию, Метрика — свои 5/6/7.
    expect(reported.map((r) => r.conversions)).toEqual([5, 6, 7]);
    expect(reported.every((r) => r.conversionSource === 'METRIKA')).toBe(true);
    // CPA пересчитан от уже записанного расхода: своих денег Метрика не знает.
    // 504.75 ₽ за сутки на 5 конверсий — не 504.75 за одну, как считал Директ.
    expect(Number(reported[0]?.spend)).toBe(504.75);
    expect(Number(reported[0]?.cpa)).toBe(100.95);

    const silent = rows.filter((r) => !REPORTED.includes(ymd(r.date)));
    // Молчание Метрики про кампанию-день — это ноль по её модели, а не «нет данных»:
    // иначе в одной колонке остались бы обе модели сразу.
    expect(silent.every((r) => r.conversions === 0 && r.cpa === null)).toBe(true);
    expect(silent.every((r) => r.conversionSource === 'METRIKA')).toBe(true);
  });

  it('перезаписан только уровень кампании: у групп, объявлений и фраз конверсии свои', async () => {
    const levels = [StatEntityType.ADGROUP, StatEntityType.AD, StatEntityType.KEYWORD];
    for (const entityType of levels) {
      const rows = await prisma.campaignStat.findMany({ where: { entityType } });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.conversionSource === 'PLATFORM')).toBe(true);
    }
    // Объявление отчиталось Директу об одной конверсии в сутки — её никто не тронул.
    const ad = await prisma.ad.findFirstOrThrow({ where: { externalId: String(IDS.adCore) } });
    const adRows = await statsOf(StatEntityType.AD, ad.id);
    expect(adRows.every((r) => r.conversions === 1)).toBe(true);
  });

  it('сверка источников по окну видит одну модель и не кричит о смеси', async () => {
    const result = await syncMetrikaConversions(clientId);

    expect(result).toMatchObject({ configured: true, unresolved: 1 });
    expect(result.attribution).toMatchObject({ mixed: false, primary: 'METRIKA' });
    // Строка Метрики про кампанию, которой у нас нет, обязана быть посчитана,
    // а не приписана «какой-нибудь» соседней.
    expect(result.attribution.counts.METRIKA).toBe(2 * WINDOW_DAYS.length);
    expect(result.attribution.counts.PLATFORM).toBe(0);
  });

  it('пустой ответ Метрики не обнуляет окно', async () => {
    const search = await campaignId(IDS.search);
    const before = await statsOf(StatEntityType.CAMPAIGN, search);

    const saved = [...metrikaRows];
    metrikaRows.splice(0, metrikaRows.length);
    try {
      const result = await syncMetrikaConversions(clientId);
      // Пустой ответ — почти всегда сбой на той стороне, а не «за три недели ни
      // одной заявки»: обнуление здесь стёрло бы отчёт клиента в ноль.
      expect(result).toMatchObject({ configured: true, fetched: 0, written: 0, zeroed: 0 });
    } finally {
      metrikaRows.push(...saved);
    }

    const after = await statsOf(StatEntityType.CAMPAIGN, search);
    expect(after.map((r) => r.conversions)).toEqual(before.map((r) => r.conversions));
  });

  it('год в названии кампании больше не отменяет её конверсии', async () => {
    // Прежний разбор брал из имени первую группу цифр длиной 4+ — в имени
    // «Кофемашины 2024 — поиск (№87651001)» ею оказывался год. Строка уходила в
    // `unresolved`, а следом проход обнуления стирал конверсии всего окна как
    // «молчание Метрики»: CPA обнулялся, и оптимизатор видел расход без единой
    // конверсии — основание снять кампанию с показов.
    label = (id) => `Кофемашины 2024 — поиск (№${id})`;
    try {
      const result = await syncMetrikaConversions(clientId);

      // Номер кампании в имени есть — по нему строка и сопоставляется.
      expect(result).toMatchObject({ configured: true, written: REPORTED.length, unresolved: 1 });
      expect(result.zeroingSuspended).toBe(false);

      const search = await campaignId(IDS.search);
      const rows = await statsOf(StatEntityType.CAMPAIGN, search);
      const reported = rows.filter((r) => REPORTED.includes(ymd(r.date)));
      expect(reported.map((r) => r.conversions)).toEqual([5, 6, 7]);
    } finally {
      label = LABEL;
    }
  });

  it('имя без номера не обнуляет окно молча, а называет себя в результате', async () => {
    // Тот же случай, но безнадёжный: сопоставлять не с чем вовсе. Обнулять окно
    // по такому ответу нельзя — молчание Метрики про кампанию и наша неспособность
    // разобрать её имя это разные вещи, и стоят они по-разному.
    const search = await campaignId(IDS.search);
    const before = await statsOf(StatEntityType.CAMPAIGN, search);

    label = () => 'Кофемашины 2026 — поиск';
    try {
      const result = await syncMetrikaConversions(clientId);

      expect(result).toMatchObject({ configured: true, written: 0, zeroed: 0 });
      expect(result.unresolved).toBe(result.fetched);
      expect(result.zeroingSuspended).toBe(true);
      // Не «сколько-то строк не сопоставилось», а какие именно: без этого человек
      // не отличит переименованную кампанию от кампании, которой у нас нет.
      expect(result.unresolvedSamples).toContain('Кофемашины 2026 — поиск');
    } finally {
      label = LABEL;
    }

    const after = await statsOf(StatEntityType.CAMPAIGN, search);
    expect(after.map((r) => r.conversions)).toEqual(before.map((r) => r.conversions));
    expect(after.map((r) => r.cpa?.toString() ?? null)).toEqual(
      before.map((r) => r.cpa?.toString() ?? null),
    );
  });

  it('клиент без счётчика проходит шаг Метрики штатно, а не с ошибкой', async () => {
    const requestsBefore = mocks.metrika.requests.length;

    const result = await syncMetrikaConversions(plainClientId);

    expect(result).toMatchObject({ configured: false, fetched: 0, written: 0, zeroed: 0 });
    // Ни одного обращения к Метрике: спрашивать нечего и нечем.
    expect(mocks.metrika.requests).toHaveLength(requestsBefore);
    expect(await prisma.errorLog.count()).toBe(0);

    const other = await campaignId(SECONDARY_IDS.campaign);
    const rows = await statsOf(StatEntityType.CAMPAIGN, other);
    expect(rows.length).toBeGreaterThan(0);
    // Конверсии остаются площадочными — и сверка честно называет эту модель.
    expect(rows.every((r) => r.conversionSource === 'PLATFORM')).toBe(true);
    expect(result.attribution).toMatchObject({ mixed: false, primary: 'PLATFORM' });
  });
});
