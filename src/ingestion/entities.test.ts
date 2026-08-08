import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';
import {
  fakeAdapter,
  remoteAd,
  remoteAdGroup,
  remoteCampaign,
  remoteKeyword,
} from '@/ingestion/__tests__/fake-adapter.js';
import { FakePrisma, type FakeRow } from '@/ingestion/__tests__/fake-prisma.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { syncEntities } = await import('@/ingestion/entities.js');

const CLIENT = 'cl1';
const CTX: ChannelContext = { clientId: CLIENT, credentials: {}, dryRun: true };

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  db.seed('client', [{ id: CLIENT, name: 'Ромашка', status: 'ACTIVE' }]);
});

function deps(adapter: ReturnType<typeof fakeAdapter>) {
  return {
    db: db.asPrisma(),
    adapterFor: () => adapter,
    contextFor: async (): Promise<ChannelContext> => CTX,
  };
}

const fullCabinet = {
  campaigns: [remoteCampaign()],
  adGroups: [remoteAdGroup()],
  ads: [remoteAd()],
  keywords: [remoteKeyword()],
};

describe('syncEntities', () => {
  it('раскладывает дерево кабинета по таблицам и связывает по внутренним id', async () => {
    const result = await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)),
    );

    expect(result.campaigns.upserted).toBe(1);
    expect(result.adGroups.upserted).toBe(1);
    expect(result.ads.upserted).toBe(1);
    expect(result.keywords.upserted).toBe(1);

    const campaign = db.store.campaign[0] as FakeRow;
    const group = db.store.adGroup[0] as FakeRow;
    expect(campaign['clientId']).toBe(CLIENT);
    expect(campaign['status']).toBe('ACTIVE');
    expect(campaign['strategy']).toBe('WB_MAXIMUM_CLICKS');
    expect(Number(campaign['dailyBudget'])).toBe(5000);

    // Ключ связи — внутренний cuid, а не идентификатор площадки.
    expect(group['campaignId']).toBe(campaign['id']);
    expect(group['campaignId']).not.toBe('100');
    expect(db.store.ad[0]?.['adGroupId']).toBe(group['id']);
    expect(db.store.keyword[0]?.['adGroupId']).toBe(group['id']);
    expect(Number(db.store.keyword[0]?.['bid'])).toBe(42.5);
  });

  it('повторный прогон обновляет те же строки, а не плодит новые', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', fullCabinet);
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(adapter));
    const ids = {
      campaign: db.store.campaign[0]?.['id'],
      group: db.store.adGroup[0]?.['id'],
      ad: db.store.ad[0]?.['id'],
      keyword: db.store.keyword[0]?.['id'],
    };

    const renamed = fakeAdapter('YANDEX_DIRECT', {
      ...fullCabinet,
      campaigns: [remoteCampaign({ name: 'SEO услуги (новое имя)' })],
    });
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(renamed));

    expect(db.store.campaign).toHaveLength(1);
    expect(db.store.adGroup).toHaveLength(1);
    expect(db.store.ad).toHaveLength(1);
    expect(db.store.keyword).toHaveLength(1);
    expect(db.store.campaign[0]?.['id']).toBe(ids.campaign);
    expect(db.store.adGroup[0]?.['id']).toBe(ids.group);
    expect(db.store.ad[0]?.['id']).toBe(ids.ad);
    expect(db.store.keyword[0]?.['id']).toBe(ids.keyword);
    expect(db.store.campaign[0]?.['name']).toBe('SEO услуги (новое имя)');
  });

  it('исчезнувшую из кабинета сущность архивирует, а не удаляет', async () => {
    const both = fakeAdapter('YANDEX_DIRECT', {
      campaigns: [remoteCampaign(), remoteCampaign({ externalId: '101', name: 'Контекст' })],
      adGroups: [remoteAdGroup(), remoteAdGroup({ externalId: '201' })],
      keywords: [remoteKeyword(), remoteKeyword({ externalId: '401', phrase: 'сео' })],
    });
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(both));

    const survivor = fakeAdapter('YANDEX_DIRECT', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup()],
      keywords: [remoteKeyword()],
    });
    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(survivor));

    expect(result.campaigns.archived).toBe(1);
    expect(result.adGroups.archived).toBe(1);
    expect(result.keywords.archived).toBe(1);

    // Строки на месте — вместе с ними уцелела и история в CampaignStat.
    expect(db.store.campaign).toHaveLength(2);
    expect(db.store.campaign.find((c) => c['externalId'] === '101')?.['status']).toBe('ARCHIVED');
    expect(db.store.campaign.find((c) => c['externalId'] === '100')?.['status']).toBe('ACTIVE');
    expect(db.store.adGroup.find((g) => g['externalId'] === '201')?.['status']).toBe('ARCHIVED');
    expect(db.store.keyword.find((k) => k['externalId'] === '401')?.['status']).toBe('ARCHIVED');
  });

  it('не архивирует ничего, когда кабинет ответил пустым списком', async () => {
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)));

    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT')));

    expect(result.campaigns.archived).toBe(0);
    expect(db.store.campaign[0]?.['status']).toBe('ACTIVE');
  });

  it('не трогает минус-слова и ещё не залитые фразы', async () => {
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)));
    const adGroupId = db.store.adGroup[0]?.['id'];
    db.seed('keyword', [
      { id: 'kw-negative', adGroupId, phrase: 'бесплатно', matchType: 'NEGATIVE' },
      { id: 'kw-local', adGroupId, phrase: 'новая фраза', externalId: null },
    ]);

    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(fakeAdapter('YANDEX_DIRECT', { ...fullCabinet, keywords: [remoteKeyword()] })),
    );

    expect(db.store.keyword.find((k) => k['id'] === 'kw-negative')?.['status']).toBe('ACTIVE');
    expect(db.store.keyword.find((k) => k['id'] === 'kw-local')?.['status']).toBe('ACTIVE');
  });

  it('подхватывает локально созданную фразу по тексту и запоминает её внешний id', async () => {
    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(
        fakeAdapter('YANDEX_DIRECT', {
          campaigns: [remoteCampaign()],
          adGroups: [remoteAdGroup()],
        }),
      ),
    );
    const adGroupId = db.store.adGroup[0]?.['id'];
    db.seed('keyword', [
      { id: 'kw-local', adGroupId, phrase: 'seo продвижение', externalId: null },
    ]);

    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(fakeAdapter('YANDEX_DIRECT', { ...fullCabinet, keywords: [remoteKeyword()] })),
    );

    expect(db.store.keyword).toHaveLength(1);
    expect(db.store.keyword[0]?.['id']).toBe('kw-local');
    expect(db.store.keyword[0]?.['externalId']).toBe('400');
  });

  it('считает сироту, чей родитель не приехал, и не роняет прогон', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup(), remoteAdGroup({ externalId: '999', campaignExternalId: '777' })],
      ads: [remoteAd(), remoteAd({ externalId: '888', adGroupExternalId: '999' })],
    });

    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    expect(result.adGroups.orphaned).toBe(1);
    expect(result.adGroups.upserted).toBe(1);
    expect(result.ads.orphaned).toBe(1);
  });

  it('не затирает известный бюджет, когда площадка его не прислала', async () => {
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)));

    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(fakeAdapter('YANDEX_DIRECT', { campaigns: [remoteCampaign({ dailyBudget: null })] })),
    );

    expect(Number(db.store.campaign[0]?.['dailyBudget'])).toBe(5000);
  });
});
