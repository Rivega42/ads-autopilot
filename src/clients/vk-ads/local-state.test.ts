import { Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { adGroup: { updateMany: vi.fn() } },
}));

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { keepsBidOnAdGroup, syncVkAdGroupBids } = await import('@/clients/vk-ads/local-state.js');

/** Единственный законный адрес обновления: группы кампаний этого клиента в VK. */
const OWNER = { clientId: 'cl1', provider: Provider.VK_ADS };

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.adGroup.updateMany.mockResolvedValue({ count: 1 });
});

describe('keepsBidOnAdGroup', () => {
  it('верно только для VK: у Директа торг идёт по фразам', () => {
    expect(keepsBidOnAdGroup(Provider.VK_ADS)).toBe(true);
    expect(keepsBidOnAdGroup(Provider.YANDEX_DIRECT)).toBe(false);
  });
});

describe('syncVkAdGroupBids', () => {
  it('пишет ставку в группы клиента и только в них', async () => {
    h.prisma.adGroup.updateMany.mockResolvedValue({ count: 1 });

    const result = await syncVkAdGroupBids('cl1', [{ adGroupExternalId: '200', bid: 150 }]);

    expect(h.prisma.adGroup.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ['200'] }, campaign: OWNER },
      data: { bid: 150 },
    });
    expect(result).toEqual({ requested: 1, updated: 1 });
  });

  it('группирует по значению: updateMany пишет всем адресатам одно число', async () => {
    const result = await syncVkAdGroupBids('cl1', [
      { adGroupExternalId: '200', bid: 170 },
      { adGroupExternalId: '201', bid: 170 },
      { adGroupExternalId: '202', bid: 132 },
      // Повтор того же адреса не должен превратиться во второй адресат.
      { adGroupExternalId: '200', bid: 170 },
    ]);

    const calls = h.prisma.adGroup.updateMany.mock.calls.map(([args]) => args);
    expect(calls).toEqual([
      { where: { externalId: { in: ['200', '201'] }, campaign: OWNER }, data: { bid: 170 } },
      { where: { externalId: { in: ['202'] }, campaign: OWNER }, data: { bid: 132 } },
    ]);
    expect(result.requested).toBe(3);
  });

  it('ненайденная строка считается непроставленной, а не молча успешной', async () => {
    // Ноль обновлённых — изменение в кабинете есть, а у нас его нет: вызывающий
    // обязан сказать об этом человеку, иначе карточка вернётся завтра.
    h.prisma.adGroup.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      syncVkAdGroupBids('cl1', [{ adGroupExternalId: '999', bid: 150 }]),
    ).resolves.toEqual({ requested: 1, updated: 0 });
  });

  it('пустой список не ходит в базу', async () => {
    await expect(syncVkAdGroupBids('cl1', [])).resolves.toEqual({ requested: 0, updated: 0 });
    expect(h.prisma.adGroup.updateMany).not.toHaveBeenCalled();
  });
});
