import { Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAction } from '@/approval/types.js';

const h = vi.hoisted(() => ({
  prisma: {
    campaign: { updateMany: vi.fn() },
    adGroup: { updateMany: vi.fn() },
    ad: { updateMany: vi.fn() },
    keyword: { updateMany: vi.fn() },
  },
}));

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { syncLocalEntities } = await import('@/approval/local-state.js');

const base = { clientId: 'cl1', channel: Provider.YANDEX_DIRECT, reason: 'причина' };

/** Кампания клиента — единственный законный адрес обновления. */
const OWNER = { clientId: 'cl1', provider: Provider.YANDEX_DIRECT };

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(h.prisma)) {
    model.updateMany.mockResolvedValue({ count: 1 });
  }
});

describe('syncLocalEntities', () => {
  it('гасит фразы клиента и только их', async () => {
    h.prisma.keyword.updateMany.mockResolvedValue({ count: 2 });
    const action: ApprovalAction = {
      ...base,
      kind: 'pause_entities',
      level: 'keyword',
      externalIds: ['e1', 'e2'],
    };

    const result = await syncLocalEntities(action);

    expect(h.prisma.keyword.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ['e1', 'e2'] }, adGroup: { campaign: OWNER } },
      data: { status: 'PAUSED' },
    });
    expect(result).toEqual({ requested: 2, updated: 2 });
  });

  it('объявления гасит в своей таблице', async () => {
    await syncLocalEntities({
      ...base,
      kind: 'pause_entities',
      level: 'ad',
      externalIds: ['a1'],
    });

    expect(h.prisma.ad.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ['a1'] }, adGroup: { campaign: OWNER } },
      data: { status: 'PAUSED' },
    });
  });

  it('группу адресует через её кампанию', async () => {
    await syncLocalEntities({
      ...base,
      kind: 'pause_entities',
      level: 'adgroup',
      externalIds: ['g1'],
    });

    expect(h.prisma.adGroup.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ['g1'] }, campaign: OWNER },
      data: { status: 'PAUSED' },
    });
  });

  it('кампанию — по паре (клиент, площадка), а не по одному внешнему id', async () => {
    await syncLocalEntities({
      ...base,
      kind: 'pause_entities',
      level: 'campaign',
      externalIds: ['777'],
    });

    expect(h.prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ['777'] }, ...OWNER },
      data: { status: 'PAUSED' },
    });
  });

  it('возобновление возвращает строку в ACTIVE', async () => {
    await syncLocalEntities({
      ...base,
      kind: 'resume_entities',
      level: 'keyword',
      externalIds: ['e1'],
    });

    expect(h.prisma.keyword.updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'ACTIVE' },
    });
  });

  it('одинаковые ставки идут одним запросом, разные — разными', async () => {
    const action: ApprovalAction = {
      ...base,
      kind: 'bid_change',
      changes: [
        { keywordExternalId: 'e1', bid: 170 },
        { keywordExternalId: 'e2', bid: 170 },
        { keywordExternalId: 'e3', bid: 132 },
      ],
    };

    const result = await syncLocalEntities(action);

    const calls = h.prisma.keyword.updateMany.mock.calls.map(([args]) => args);
    expect(calls).toEqual([
      {
        where: { externalId: { in: ['e1', 'e2'] }, adGroup: { campaign: OWNER } },
        data: { bid: 170 },
      },
      { where: { externalId: { in: ['e3'] }, adGroup: { campaign: OWNER } }, data: { bid: 132 } },
    ]);
    expect(result.requested).toBe(3);
  });

  it('меняет дневной бюджет кампании', async () => {
    await syncLocalEntities({
      ...base,
      kind: 'budget_change',
      campaignExternalId: '777',
      campaignName: 'SEO услуги',
      before: 5000,
      after: 3000,
    });

    expect(h.prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ['777'] }, ...OWNER },
      data: { dailyBudget: 3000 },
    });
  });

  it('минус-слова не трогают строки сущностей: их отражает markNegatedQueries', async () => {
    const result = await syncLocalEntities({
      ...base,
      kind: 'add_negatives',
      campaignExternalId: '777',
      phrases: ['бесплатно'],
    });

    expect(result).toEqual({ requested: 0, updated: 0 });
    expect(h.prisma.campaign.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.keyword.updateMany).not.toHaveBeenCalled();
  });

  it('несопоставленные внешние id видны в результате, а не проглатываются', async () => {
    h.prisma.keyword.updateMany.mockResolvedValue({ count: 0 });

    const result = await syncLocalEntities({
      ...base,
      kind: 'pause_entities',
      level: 'keyword',
      externalIds: ['e1'],
    });

    expect(result).toEqual({ requested: 1, updated: 0 });
  });

  it('ошибку БД не глотает: что с ней делать, решает вызывающий', async () => {
    h.prisma.keyword.updateMany.mockRejectedValue(new Error('connection pool timeout'));

    await expect(
      syncLocalEntities({
        ...base,
        kind: 'pause_entities',
        level: 'keyword',
        externalIds: ['e1'],
      }),
    ).rejects.toThrow('connection pool timeout');
  });
});
