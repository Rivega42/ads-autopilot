import { StatEntityType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { evaluateAdExperiment, type ExperimentStore } from './experiment.js';

interface AdRow {
  id: string;
  llmVariant: string | null;
}

interface StatRow {
  entityId: string;
  impressions: number;
  clicks: number;
}

function storeOf(ads: AdRow[], stats: StatRow[]): { db: ExperimentStore; statWhere: () => unknown } {
  let captured: unknown;
  const db = {
    ad: { findMany: vi.fn(() => Promise.resolve(ads)) },
    campaignStat: {
      findMany: vi.fn((args: { where: unknown }) => {
        captured = args.where;
        return Promise.resolve(stats);
      }),
    },
  } as unknown as ExperimentStore;
  return { db, statWhere: () => captured };
}

const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-08-08T00:00:00.000Z');

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

  it('объявление без llmVariant участвует как отдельный вариант', async () => {
    const { db } = storeOf(
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
    expect([...result.adsByVariant.keys()]).toEqual(['v-a', 'ad:ad-2']);
    expect(result.decision.winner).toBe('v-a');
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

  it('спрашивает статистику по нужному типу сущности и окну', async () => {
    const { db, statWhere } = storeOf([{ id: 'ad-1', llmVariant: 'v-a' }], []);
    await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(statWhere()).toMatchObject({
      entityType: StatEntityType.AD,
      entityId: { in: ['ad-1'] },
      date: { gte: FROM, lte: TO },
    });
  });

  it('в группе без объявлений в БД за статистикой не ходит', async () => {
    const { db } = storeOf([], []);
    const result = await evaluateAdExperiment('ag-1', { from: FROM, to: TO, db });

    expect(db.campaignStat.findMany).not.toHaveBeenCalled();
    expect(result.decision.reasonCode).toBe('NOT_ENOUGH_VARIANTS');
  });
});
