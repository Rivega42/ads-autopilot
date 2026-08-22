import { describe, expect, it } from 'vitest';

import { FakeDb } from '@/moderation/__tests__/fake-db.js';

/**
 * Тесты на сам стенд.
 *
 * Стенд подменяет Postgres, и единственное, чем он может соврать по-крупному, —
 * пропустить ограничение схемы. `@@unique([adGroupId, externalId])` тут главное:
 * на нём держится вся ветка «новый id уже занят».
 */

function seeded(): FakeDb {
  const db = new FakeDb();
  db.seedCampaign({ id: 'c1', clientId: 'cl1' });
  db.seedAdGroup({ id: 'g1', campaignId: 'c1' });
  return db;
}

describe('FakeDb: уникальность (adGroupId, externalId)', () => {
  it('не даёт завести две строки с одним внешним id', () => {
    const db = seeded();
    db.seedAd({ id: 'ad1', adGroupId: 'g1', externalId: '10' });

    expect(() => db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: '10' })).toThrow(/Unique/);
  });

  it('ловит занятый id и в updateMany, а не только в update', async () => {
    const db = seeded();
    db.seedAd({ id: 'ad1', adGroupId: 'g1', externalId: '9' });
    db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: '10' });

    await expect(
      db.ad.updateMany({ where: { id: 'ad1' }, data: { externalId: '10' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(db.adOf('ad1').externalId).toBe('9');
  });

  it('соседняя группа тем же id не мешает', async () => {
    const db = seeded();
    db.seedAdGroup({ id: 'g2', campaignId: 'c1' });
    db.seedAd({ id: 'ad1', adGroupId: 'g1', externalId: '10' });

    expect(() => db.seedAd({ id: 'ad2', adGroupId: 'g2', externalId: '10' })).not.toThrow();
    await expect(
      db.ad.update({ where: { id: 'ad1' }, data: { externalId: '10' } }),
    ).resolves.toMatchObject({ externalId: '10' });
  });
});
