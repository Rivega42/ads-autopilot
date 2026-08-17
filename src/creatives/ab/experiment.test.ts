import { StatEntityType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { evaluateAdExperiment, TEXT_REWRITE_ACTIONS, type ExperimentStore } from './experiment.js';
import { DEFAULT_AB_TEST } from './select.js';

import { REWRITE_ACTION } from '@/moderation/repair.js';

interface AdRow {
  id: string;
  llmVariant: string | null;
  title?: string;
  createdAt?: Date;
}

interface StatRow {
  entityId: string;
  impressions: number;
  clicks: number;
  date?: Date;
}

interface ChangeRow {
  entityId: string;
  action: string;
  appliedAt: Date;
}

interface Where {
  llmVariant?: unknown;
  action?: { in: string[] };
  appliedAt?: { gte: Date };
  entityId?: { in: string[] };
}

function storeOf(
  ads: AdRow[],
  stats: StatRow[],
  changes: ChangeRow[] = [],
): { db: ExperimentStore; statWhere: () => Where | undefined; adWhere: () => Where | undefined } {
  let capturedStat: Where | undefined;
  let capturedAd: Where | undefined;
  const db = {
    ad: {
      findMany: vi.fn((args: { where: Where }) => {
        capturedAd = args.where;
        // Фильтр «только наши варианты» обязан работать в БД, но мок обязан
        // вести себя так же, иначе тест проверял бы не то, что уедет в Postgres.
        const rows = args.where.llmVariant ? ads.filter((ad) => ad.llmVariant !== null) : ads;
        return Promise.resolve(rows);
      }),
    },
    campaignStat: {
      findMany: vi.fn((args: { where: Where }) => {
        capturedStat = args.where;
        const ids = args.where.entityId?.in ?? [];
        return Promise.resolve(stats.filter((row) => ids.includes(row.entityId)));
      }),
    },
    changeLog: {
      findMany: vi.fn((args: { where: Where }) => {
        const ids = args.where.entityId?.in ?? [];
        const actions = args.where.action?.in ?? [];
        const since = args.where.appliedAt?.gte;
        return Promise.resolve(
          changes.filter(
            (row) =>
              ids.includes(row.entityId) &&
              actions.includes(row.action) &&
              (since === undefined || row.appliedAt >= since),
          ),
        );
      }),
    },
  } as unknown as ExperimentStore;
  return { db, statWhere: () => capturedStat, adWhere: () => capturedAd };
}

const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-08-08T00:00:00.000Z');

function day(offset: number): Date {
  return new Date(TO.getTime() - offset * 24 * 60 * 60 * 1000);
}

describe('evaluateAdExperiment', () => {
  it('складывает статистику нескольких объявлений одного варианта', async () => {
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: 'v-a' },
        { id: 'ad-3', llmVariant: 'v-b' },
      ],
      [
        { entityId: 'ad-1', impressions: 600, clicks: 30 },
        { entityId: 'ad-2', impressions: 600, clicks: 30 },
        { entityId: 'ad-3', impressions: 1200, clicks: 12 },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.decision.status).toBe('winner');
    expect(result.decision.winner).toBe('v-a');
    expect(result.adsByVariant.get('v-a')).toEqual(['ad-1', 'ad-2']);
    const leader = result.decision.variants.find((v) => v.variantId === 'v-a');
    expect(leader?.impressions).toBe(1200);
    expect(leader?.clicks).toBe(60);
  });

  it('объявление без llmVariant вариантом не считает: этот текст писали не мы', async () => {
    const { db, adWhere } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: null },
      ],
      [
        { entityId: 'ad-1', impressions: 1000, clicks: 50 },
        { entityId: 'ad-2', impressions: 1000, clicks: 10 },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(adWhere()).toMatchObject({ llmVariant: { not: null } });
    expect([...result.adsByVariant.keys()]).toEqual(['v-a']);
    expect(result.decision.reasonCode).toBe('NOT_ENOUGH_VARIANTS');
  });

  it('объявления без статистики за окно перечислены отдельно, а не выброшены', async () => {
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: 'v-b' },
      ],
      [{ entityId: 'ad-1', impressions: 600, clicks: 30 }],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });
    expect(result.adsWithoutStats).toEqual(['ad-2']);
    // У «v-b» ноль показов — до порога не добрали, победителя нет.
    expect(result.decision.status).toBe('collecting');
  });

  it('разные тексты — разные варианты: их статистику нельзя складывать', async () => {
    // Тот самый случай, ради которого llmVariant хранит отпечаток текста, а не метку:
    // переписанное модерацией объявление с CTR 10% и слабое с CTR 1%.
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 't-aaaaaaaaaaaa' },
        { id: 'ad-2', llmVariant: 't-bbbbbbbbbbbb' },
      ],
      [
        { entityId: 'ad-1', impressions: 1000, clicks: 100 },
        { entityId: 'ad-2', impressions: 1000, clicks: 10 },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.decision.variants).toHaveLength(2);
    expect(result.decision.winner).toBe('t-aaaaaaaaaaaa');
    expect(result.decision.reasonCode).not.toBe('NOT_ENOUGH_VARIANTS');
  });

  it('вариант называется заголовком объявления, а не отпечатком текста', async () => {
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 't-aaaaaaaaaaaa', title: 'Ремонт под ключ' },
        { id: 'ad-2', llmVariant: 't-bbbbbbbbbbbb', title: 'Ремонт недорого' },
      ],
      [
        { entityId: 'ad-1', impressions: 1000, clicks: 100 },
        { entityId: 'ad-2', impressions: 1000, clicks: 10 },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.decision.variants.map((v) => v.label)).toEqual([
      'Ремонт под ключ',
      'Ремонт недорого',
    ]);
    expect(result.decision.reason).toContain('Ремонт под ключ');
    expect(result.decision.reason).not.toContain('t-aaaaaaaaaaaa');
  });
});

describe('возраст эксперимента', () => {
  it('считается от первого показа участников, а не от даты создания группы', async () => {
    // Группа живёт год, два варианта добавлены на этой неделе. По возрасту строки Ad
    // эксперимент «просрочен» с рождения и не получает своих 14 дней.
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a', createdAt: new Date('2025-08-01T00:00:00.000Z') },
        { id: 'ad-2', llmVariant: 'v-b', createdAt: new Date('2025-08-01T00:00:00.000Z') },
      ],
      [
        { entityId: 'ad-1', impressions: 600, clicks: 30, date: day(2) },
        { entityId: 'ad-2', impressions: 100, clicks: 4, date: day(2) },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.experimentAgeDays).toBe(2);
    expect(result.decision.status).toBe('collecting');
  });

  it('срок сбора отсчитывается от того, кто начал откручиваться последним', async () => {
    // «v-a» крутится всё окно, «v-b» подключили два дня назад: сравнение стало
    // возможным два дня назад, значит и тест идёт два дня.
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: 'v-b' },
      ],
      [
        { entityId: 'ad-1', impressions: 600, clicks: 30, date: FROM },
        { entityId: 'ad-1', impressions: 600, clicks: 30, date: day(1) },
        { entityId: 'ad-2', impressions: 50, clicks: 2, date: day(2) },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.experimentAgeDays).toBe(2);
    expect(result.decision.status).toBe('collecting');
    expect(result.decision.reasonCode).toBe('MIN_IMPRESSIONS');
  });

  it('давно идущий тест без данных всё-таки просрочивается', async () => {
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: 'v-b' },
      ],
      [
        { entityId: 'ad-1', impressions: 600, clicks: 30, date: FROM },
        { entityId: 'ad-2', impressions: 12, clicks: 0, date: FROM },
      ],
      [],
    );

    const result = await evaluateAdExperiment('ag-1', {
      from: FROM,
      to: TO,
      db,
      config: { ...DEFAULT_AB_TEST, maxCollectingDays: 5 },
    });

    expect(result.decision.reasonCode).toBe('COLLECTION_TIMEOUT');
  });
});

describe('переписанные объявления', () => {
  it('объявление, переписанное внутри окна, в сравнение не идёт', async () => {
    // Статистика лежит по Ad.id и не знает, что текст сменился: старые показы
    // старого текста иначе объявили бы проигравшим новый.
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: 'v-new' },
      ],
      [
        { entityId: 'ad-1', impressions: 1000, clicks: 50, date: FROM },
        { entityId: 'ad-2', impressions: 15_000, clicks: 75, date: FROM },
      ],
      [{ entityId: 'ad-2', action: REWRITE_ACTION, appliedAt: day(1) }],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.rewrittenAds).toEqual(['ad-2']);
    expect([...result.adsByVariant.keys()]).toEqual(['v-a']);
    expect(result.decision.reasonCode).toBe('NOT_ENOUGH_VARIANTS');
  });

  it('переписанное до окна объявление участвует: его показы уже от нового текста', async () => {
    const { db } = storeOf(
      [
        { id: 'ad-1', llmVariant: 'v-a' },
        { id: 'ad-2', llmVariant: 'v-b' },
      ],
      [
        { entityId: 'ad-1', impressions: 1000, clicks: 50, date: FROM },
        { entityId: 'ad-2', impressions: 1000, clicks: 10, date: FROM },
      ],
      [
        {
          entityId: 'ad-2',
          action: REWRITE_ACTION,
          appliedAt: new Date(FROM.getTime() - 24 * 60 * 60 * 1000),
        },
      ],
    );

    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(result.rewrittenAds).toEqual([]);
    expect(result.decision.winner).toBe('v-a');
  });

  it('список действий, меняющих текст, совпадает с модерацией', () => {
    expect(TEXT_REWRITE_ACTIONS).toContain(REWRITE_ACTION);
  });
});

describe('запросы к БД', () => {
  it('спрашивает статистику по нужному типу сущности и окну', async () => {
    const { db, statWhere } = storeOf([{ id: 'ad-1', llmVariant: 'v-a' }], []);
    await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(statWhere()).toMatchObject({
      entityType: StatEntityType.AD,
      entityId: { in: ['ad-1'] },
      date: { gte: FROM, lte: TO },
    });
  });

  it('в группе без наших объявлений за статистикой не ходит', async () => {
    const { db } = storeOf([], []);
    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(db.campaignStat.findMany).not.toHaveBeenCalled();
    expect(db.changeLog.findMany).not.toHaveBeenCalled();
    expect(result.decision.reasonCode).toBe('NOT_ENOUGH_VARIANTS');
  });
});
