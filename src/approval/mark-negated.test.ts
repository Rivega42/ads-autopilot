import { Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  campaignFindUnique: vi.fn(),
  statUpdateMany: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/db/prisma.js', () => ({
  prisma: {
    campaign: { findUnique: h.campaignFindUnique },
    searchQueryStat: { updateMany: h.statUpdateMany },
  },
}));
vi.mock('@/logger.js', () => ({
  logger: { child: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

const { markNegatedQueries } = await import('@/approval/mark-negated.js');

const input = {
  clientId: 'cl1',
  provider: Provider.YANDEX_DIRECT,
  campaignExternalId: '777',
  phrases: ['бесплатно', 'скачать'],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.campaignFindUnique.mockResolvedValue({ id: 'camp-internal-1', clientId: 'cl1' });
  h.statUpdateMany.mockResolvedValue({ count: 3 });
});

describe('markNegatedQueries', () => {
  it('помечает фразы во всех группах кампании, найденной по паре (площадка, внешний id)', async () => {
    const marked = await markNegatedQueries(input);

    expect(h.campaignFindUnique).toHaveBeenCalledWith({
      where: { provider_externalId: { provider: Provider.YANDEX_DIRECT, externalId: '777' } },
      select: { id: true, clientId: true },
    });
    expect(h.statUpdateMany).toHaveBeenCalledWith({
      where: {
        adGroup: { campaignId: 'camp-internal-1' },
        query: { in: ['бесплатно', 'скачать'] },
        negated: false,
      },
      data: { negated: true },
    });
    expect(marked).toBe(3);
  });

  it('повторы фраз в одну выборку не превращаются в дубли условия', async () => {
    await markNegatedQueries({ ...input, phrases: ['бесплатно', 'бесплатно', 'скачать'] });

    expect(h.statUpdateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { query: { in: ['бесплатно', 'скачать'] } },
    });
  });

  it('пустой список фраз не ходит в БД', async () => {
    expect(await markNegatedQueries({ ...input, phrases: [] })).toBe(0);
    expect(h.campaignFindUnique).not.toHaveBeenCalled();
    expect(h.statUpdateMany).not.toHaveBeenCalled();
  });

  it('ненайденная кампания — warn, а не исключение', async () => {
    h.campaignFindUnique.mockResolvedValue(null);

    expect(await markNegatedQueries(input)).toBe(0);
    expect(h.statUpdateMany).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('кампания чужого клиента не помечается', async () => {
    h.campaignFindUnique.mockResolvedValue({ id: 'camp-internal-1', clientId: 'cl-other' });

    expect(await markNegatedQueries(input)).toBe(0);
    expect(h.statUpdateMany).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('ошибку БД не глотает: решение, что с ней делать, принимает вызывающий', async () => {
    h.statUpdateMany.mockRejectedValue(new Error('connection pool timeout'));

    await expect(markNegatedQueries(input)).rejects.toThrow('connection pool timeout');
  });
});
