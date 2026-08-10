import { ModerationStatus, Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb } from '@/moderation/__tests__/fake-db.js';
import { channelContext, fakeAdapter, remoteAd } from '@/moderation/__tests__/fakes.js';
import { pollAdModeration } from '@/moderation/poll.js';

const TARGET = { clientId: 'cl1', provider: Provider.YANDEX_DIRECT };

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.seedClient({ id: 'cl1' });
  db.seedCampaign({ id: 'c1', clientId: 'cl1', provider: Provider.YANDEX_DIRECT, name: 'Поиск' });
  db.seedAdGroup({ id: 'g1', campaignId: 'c1', externalId: 'ext-1' });
});

function poll(ads: Parameters<typeof fakeAdapter>[0]['ads']) {
  const adapter = fakeAdapter({ channel: Provider.YANDEX_DIRECT, ads });
  return pollAdModeration(db.asDb(), TARGET, channelContext(false), adapter);
}

describe('pollAdModeration', () => {
  it('без групп в кабинет не ходит', async () => {
    const empty = new FakeDb();
    empty.seedClient({ id: 'cl1' });
    const adapter = fakeAdapter({
      channel: Provider.YANDEX_DIRECT,
      listAds: async () => {
        throw new Error('listAds не должен вызываться без групп');
      },
    });

    const result = await pollAdModeration(empty.asDb(), TARGET, channelContext(false), adapter);
    expect(result).toEqual({ polled: 0, updated: 0, orphaned: 0, rejected: [] });
  });

  it('считает чужие объявления сиротами, а не своими', async () => {
    db.seedAd({ id: 'ad1', adGroupId: 'g1', externalId: 'a1' });
    // Кабинет вернул больше, чем спрашивали: так бывает при рассинхроне групп.
    const adapter = fakeAdapter({
      channel: Provider.YANDEX_DIRECT,
      listAds: async () => [
        remoteAd({ externalId: 'a1', adGroupExternalId: 'ext-1' }),
        // Группы нет в нашей БД — её заведёт ingestion.
        remoteAd({ externalId: 'a9', adGroupExternalId: 'ext-unknown' }),
        // Группа есть, а объявления в нашей БД нет.
        remoteAd({ externalId: 'a8', adGroupExternalId: 'ext-1' }),
      ],
    });

    const result = await pollAdModeration(db.asDb(), TARGET, channelContext(false), adapter);

    expect(result.polled).toBe(1);
    expect(result.orphaned).toBe(2);
  });

  it('изменившаяся причина отказа обновляет строку', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.REJECTED,
      moderationReason: 'Старая причина',
    });

    const result = await poll([
      remoteAd({
        externalId: 'a1',
        adGroupExternalId: 'ext-1',
        moderationReason: 'Новая причина',
      }),
    ]);

    expect(result.updated).toBe(1);
    expect(db.adOf('ad1').moderationReason).toBe('Новая причина');
    expect(result.rejected[0]).toMatchObject({
      id: 'ad1',
      campaignName: 'Поиск',
      reason: 'Новая причина',
    });
  });

  it('совпавший статус не порождает записи', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.APPROVED,
      moderationReason: null,
    });

    const result = await poll([
      remoteAd({
        externalId: 'a1',
        adGroupExternalId: 'ext-1',
        moderationStatus: 'ACCEPTED',
        moderationReason: undefined,
      }),
    ]);

    expect(result).toMatchObject({ polled: 1, updated: 0, rejected: [] });
  });

  it('берёт тексты с площадки, а не из нашей БД', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      title: 'Устаревший заголовок',
      body: 'Устаревший текст',
      moderationStatus: ModerationStatus.REJECTED,
    });

    const result = await poll([
      remoteAd({
        externalId: 'a1',
        adGroupExternalId: 'ext-1',
        title: 'Актуальный заголовок',
        title2: 'Второй',
        text: 'Актуальный текст',
      }),
    ]);

    expect(result.rejected[0]?.ad).toEqual({
      title: 'Актуальный заголовок',
      title2: 'Второй',
      text: 'Актуальный текст',
    });
  });
});
