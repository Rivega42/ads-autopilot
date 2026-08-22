import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Decision } from './types.js';

const h = vi.hoisted(() => ({
  prisma: {
    campaign: { updateMany: vi.fn() },
    adGroup: { updateMany: vi.fn() },
    ad: { updateMany: vi.fn() },
    keyword: { updateMany: vi.fn() },
  },
}));

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { syncAppliedDecisions } = await import('./local-state.js');

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'BID_DECREASE',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    prevValue: { kind: 'bid', amount: 200 },
    nextValue: { kind: 'bid', amount: 170 },
    reason: 'CPA 900 при цели 500',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'decrease-bid-high-cpa',
    approvalKind: null,
    ...overrides,
  };
}

function pause(entityId: string, entityType: Decision['entityType'] = 'KEYWORD'): Decision {
  return decision({
    action: 'PAUSE',
    entityType,
    entityId,
    prevValue: { kind: 'status', status: 'ACTIVE' },
    nextValue: { kind: 'status', status: 'PAUSED' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(h.prisma)) {
    model.updateMany.mockResolvedValue({ count: 1 });
  }
});

describe('syncAppliedDecisions', () => {
  it('переводит ключевую фразу в PAUSED — иначе следующий прогон снова её погасит', async () => {
    const result = await syncAppliedDecisions([pause('kw-1')]);

    expect(h.prisma.keyword.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['kw-1'] } },
      data: { status: 'PAUSED' },
    });
    expect(result).toEqual({ updated: 1, skipped: 0 });
  });

  it('записывает новую ставку в ту же колонку, из которой считалось решение', async () => {
    await syncAppliedDecisions([decision()]);

    expect(h.prisma.keyword.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['kw-1'] } },
      data: { bid: 170 },
    });
  });

  it('гасит объявление в своей таблице, а не в таблице фраз', async () => {
    await syncAppliedDecisions([pause('ad-1', 'AD')]);

    expect(h.prisma.ad.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ad-1'] } },
      data: { status: 'PAUSED' },
    });
    expect(h.prisma.keyword.updateMany).not.toHaveBeenCalled();
  });

  it('обновляет дневной бюджет кампании', async () => {
    await syncAppliedDecisions([
      decision({
        action: 'BUDGET_CHANGE',
        entityType: 'CAMPAIGN',
        entityId: 'c-1',
        prevValue: { kind: 'budget', amount: 5000 },
        nextValue: { kind: 'budget', amount: 4000 },
      }),
    ]);

    expect(h.prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c-1'] } },
      data: { dailyBudget: 4000 },
    });
  });

  it('складывает одинаковые изменения в один запрос, а разные ставки — в разные', async () => {
    h.prisma.keyword.updateMany.mockResolvedValue({ count: 2 });

    const result = await syncAppliedDecisions([
      pause('kw-1'),
      pause('kw-2'),
      decision({ entityId: 'kw-3' }),
      decision({ entityId: 'kw-4', nextValue: { kind: 'bid', amount: 132 } }),
    ]);

    const calls = h.prisma.keyword.updateMany.mock.calls.map(([args]) => args);
    expect(calls).toEqual([
      { where: { id: { in: ['kw-1', 'kw-2'] } }, data: { status: 'PAUSED' } },
      { where: { id: { in: ['kw-3'] } }, data: { bid: 170 } },
      { where: { id: { in: ['kw-4'] } }, data: { bid: 132 } },
    ]);
    expect(result.updated).toBe(6);
  });

  it('минус-слово не считается пропущенным: его отражает SearchQueryStat.negated', async () => {
    const result = await syncAppliedDecisions([
      decision({
        action: 'ADD_NEGATIVE_KEYWORD',
        entityType: 'ADGROUP',
        entityId: 'ag-1',
        prevValue: { kind: 'absent' },
        nextValue: { kind: 'negativeKeyword', phrase: 'бесплатно' },
      }),
    ]);

    expect(result).toEqual({ updated: 0, skipped: 0 });
    expect(h.prisma.adGroup.updateMany).not.toHaveBeenCalled();
  });

  it('решение без своей колонки видно в счётчике, а не молча теряется', async () => {
    const result = await syncAppliedDecisions([
      decision({
        action: 'STRATEGY_CHANGE',
        entityType: 'CAMPAIGN',
        entityId: 'c-1',
        prevValue: { kind: 'strategy', strategy: 'MANUAL' },
        nextValue: { kind: 'strategy', strategy: 'AVERAGE_CPA' },
      }),
    ]);

    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect(h.prisma.campaign.updateMany).not.toHaveBeenCalled();
  });

  it('ставка группы пишется в колонку группы, а не в колонку фраз', async () => {
    // У VK ключевых фраз нет вовсе: цена живёт на группе. Пока эта ветка считалась
    // пропуском, применённая ставка оставалась только в кабинете, и следующий прогон
    // предлагал ровно то же изменение заново.
    const result = await syncAppliedDecisions([
      decision({ entityType: 'ADGROUP', entityId: 'ag-1' }),
    ]);

    expect(h.prisma.adGroup.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['ag-1'] } },
      data: { bid: 170 },
    });
    expect(h.prisma.keyword.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ updated: 1, skipped: 0 });
  });

  it('ставка на уровне, у которого колонки нет, видна в счётчике', async () => {
    const result = await syncAppliedDecisions([decision({ entityType: 'AD', entityId: 'ad-1' })]);

    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect(h.prisma.ad.updateMany).not.toHaveBeenCalled();
  });

  it('пустой список в базу не ходит', async () => {
    expect(await syncAppliedDecisions([])).toEqual({ updated: 0, skipped: 0 });
    expect(h.prisma.keyword.updateMany).not.toHaveBeenCalled();
  });

  it('ошибку БД не глотает: что с ней делать, решает вызывающий', async () => {
    h.prisma.keyword.updateMany.mockRejectedValue(new Error('connection pool timeout'));

    await expect(syncAppliedDecisions([pause('kw-1')])).rejects.toThrow('connection pool timeout');
  });
});
