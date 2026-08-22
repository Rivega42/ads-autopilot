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

  it('кладёт ставку группы в колонку — уровень, на котором её держит VK', async () => {
    const adapter = fakeAdapter('VK_ADS', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup({ bid: 120 })],
    });

    await syncEntities(CLIENT, 'VK_ADS', deps(adapter));

    expect(Number(db.store.adGroup[0]?.['bid'])).toBe(120);
  });

  it('молчание канала про ставку группы не затирает известное значение', async () => {
    await syncEntities(
      CLIENT,
      'VK_ADS',
      deps(
        fakeAdapter('VK_ADS', {
          campaigns: [remoteCampaign()],
          adGroups: [remoteAdGroup({ bid: 120 })],
        }),
      ),
    );

    // Директ ставку группы не отдаёт вовсе, а у VK поле может не приехать под
    // проекцией `fields`. И то и другое — «не знаю», а не «ставки нет».
    const silent = fakeAdapter('VK_ADS', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup()],
    });
    await syncEntities(CLIENT, 'VK_ADS', deps(silent));

    expect(Number(db.store.adGroup[0]?.['bid'])).toBe(120);
  });

  it('явное «ручной ставки нет» колонку обнуляет', async () => {
    await syncEntities(
      CLIENT,
      'VK_ADS',
      deps(
        fakeAdapter('VK_ADS', {
          campaigns: [remoteCampaign()],
          adGroups: [remoteAdGroup({ bid: 120 })],
        }),
      ),
    );

    // Группу перевели на автостратегию: иначе она вечно носила бы последнюю ручную цену.
    const auto = fakeAdapter('VK_ADS', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup({ bid: null })],
    });
    await syncEntities(CLIENT, 'VK_ADS', deps(auto));

    expect(db.store.adGroup[0]?.['bid']).toBeNull();
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

  it.each([
    { remote: 'ON', stored: 'ACTIVE' },
    { remote: 'OFF', stored: 'PAUSED' },
    { remote: 'SUSPENDED', stored: 'PAUSED' },
    { remote: 'ARCHIVED', stored: 'ARCHIVED' },
    // Незнакомое слово площадки — «работает»: спрятать живое объявление дороже.
    { remote: 'СОВСЕМ_НОВЫЙ_СТАТУС', stored: 'ACTIVE' },
  ])('статус объявления $remote из кабинета пишется как $stored', async ({ remote, stored }) => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      ...fullCabinet,
      ads: [remoteAd({ status: remote })],
    });

    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    expect(db.store.ad[0]?.['status']).toBe(stored);
  });

  it('выключение объявления в кабинете доезжает до строки при повторном прогоне', async () => {
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)));
    expect(db.store.ad[0]?.['status']).toBe('ACTIVE');

    const paused = fakeAdapter('YANDEX_DIRECT', {
      ...fullCabinet,
      ads: [remoteAd({ status: 'OFF' })],
    });
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(paused));

    expect(db.store.ad).toHaveLength(1);
    expect(db.store.ad[0]?.['status']).toBe('PAUSED');
  });

  it('не архивирует ничего, когда кабинет ответил пустым списком', async () => {
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)));

    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT')));

    expect(result.campaigns.archived).toBe(0);
    expect(db.store.campaign[0]?.['status']).toBe('ACTIVE');
  });

  it('оборванный листинг не архивирует всё, чего не оказалось на первой странице', async () => {
    const three = fakeAdapter('YANDEX_DIRECT', {
      campaigns: [
        remoteCampaign(),
        remoteCampaign({ externalId: '101', name: 'Контекст' }),
        remoteCampaign({ externalId: '102', name: 'РСЯ' }),
      ],
    });
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(three));

    // Ответ не пустой и не упал — просто оборвался на первой странице из трёх.
    const truncated = fakeAdapter('YANDEX_DIRECT', { campaigns: [remoteCampaign()] });
    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(truncated));

    expect(result.campaigns.archived).toBe(0);
    expect(db.store.campaign.every((c) => c['status'] === 'ACTIVE')).toBe(true);
  });

  it('частичный листинг фраз не архивирует ключи чужой группы', async () => {
    const both = fakeAdapter('YANDEX_DIRECT', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup(), remoteAdGroup({ externalId: '201', name: 'Питер' })],
      keywords: [
        remoteKeyword(),
        remoteKeyword({ externalId: '401', phrase: 'сео', adGroupExternalId: '201' }),
      ],
    });
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(both));

    // Прогон, в котором ответ пришёл только по группе 200: про 201 кабинет
    // промолчал — это не «фразы удалили».
    const partial = fakeAdapter('YANDEX_DIRECT', {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup(), remoteAdGroup({ externalId: '201', name: 'Питер' })],
      keywords: [remoteKeyword()],
    });
    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(partial));

    expect(result.keywords.archived).toBe(0);
    expect(db.store.keyword.find((k) => k['externalId'] === '401')?.['status']).toBe('ACTIVE');
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

  it('не заводит живую строку под баннер, который мы сами заменили при правке текста', async () => {
    // Строка уже переехала на новый баннер: так делает `moderation/repair.ts`, когда VK
    // создал замену, а удалить старый баннер не смог. Старый при этом остаётся в
    // листинге — `VK_DEFAULT_STATUSES` включает `blocked`.
    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(
        fakeAdapter('YANDEX_DIRECT', { ...fullCabinet, ads: [remoteAd({ externalId: '301' })] }),
      ),
    );
    const row = db.store.ad[0] as FakeRow;
    row['supersededExternalIds'] = ['300'];

    const withOrphan = fakeAdapter('YANDEX_DIRECT', {
      ...fullCabinet,
      ads: [remoteAd({ externalId: '301' }), remoteAd({ externalId: '300', status: 'BLOCKED' })],
    });
    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(withOrphan));

    expect(result.ads.superseded).toBe(1);
    const orphan = db.store.ad.find((ad) => ad['externalId'] === '300');
    // Строка есть — её расход не должен потеряться, — но в решениях не участвует.
    expect(orphan?.['status']).toBe('ARCHIVED');
    expect(db.store.ad.find((ad) => ad['externalId'] === '301')?.['status']).toBe('ACTIVE');
  });

  it('гасит все баннеры цепочки замен, а не только последний', async () => {
    // Строку переписывают до трёх раз подряд, и каждая неудавшаяся уборка оставляет в
    // кабинете ещё один погашенный баннер. Помнить только последний — значит вернуть
    // предыдущему «работает» на первом же синке.
    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(
        fakeAdapter('YANDEX_DIRECT', { ...fullCabinet, ads: [remoteAd({ externalId: '302' })] }),
      ),
    );
    (db.store.ad[0] as FakeRow)['supersededExternalIds'] = ['300', '301'];

    const withOrphans = fakeAdapter('YANDEX_DIRECT', {
      ...fullCabinet,
      ads: [
        remoteAd({ externalId: '302' }),
        remoteAd({ externalId: '301', status: 'BLOCKED' }),
        remoteAd({ externalId: '300', status: 'BLOCKED' }),
      ],
    });
    const result = await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(withOrphans));

    expect(result.ads.superseded).toBe(2);
    expect(db.store.ad.find((ad) => ad['externalId'] === '300')?.['status']).toBe('ARCHIVED');
    expect(db.store.ad.find((ad) => ad['externalId'] === '301')?.['status']).toBe('ARCHIVED');
    expect(db.store.ad.find((ad) => ad['externalId'] === '302')?.['status']).toBe('ACTIVE');
  });

  it('гасит заменённый баннер, даже если кабинет отдаёт его работающим', async () => {
    // Погасить старый баннер адаптер пытается сам, но попытка может не пройти. Тогда
    // объявление крутится и тратит бюджет, а его строка попала бы и в оптимизатор, и в
    // модерацию — то есть получила бы ещё одно переписывание.
    await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(
        fakeAdapter('YANDEX_DIRECT', { ...fullCabinet, ads: [remoteAd({ externalId: '301' })] }),
      ),
    );
    (db.store.ad[0] as FakeRow)['supersededExternalIds'] = ['300'];

    const stillRunning = fakeAdapter('YANDEX_DIRECT', {
      ...fullCabinet,
      ads: [remoteAd({ externalId: '301' }), remoteAd({ externalId: '300', status: 'ON' })],
    });
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(stillRunning));

    expect(db.store.ad.find((ad) => ad['externalId'] === '300')?.['status']).toBe('ARCHIVED');
  });

  it('чужая запись журнала не гасит объявление другой группы', async () => {
    // externalId уникален только внутри группы, поэтому совпадение id из чужой замены
    // не имеет права выключить работающее объявление.
    const twoGroups = {
      campaigns: [remoteCampaign()],
      adGroups: [remoteAdGroup(), remoteAdGroup({ externalId: '201' })],
      ads: [remoteAd(), remoteAd({ externalId: '399', adGroupExternalId: '201' })],
    };
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', twoGroups)));
    const other = db.store.ad.find((ad) => ad['externalId'] === '399');
    if (other) other['supersededExternalIds'] = ['300'];

    const result = await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(fakeAdapter('YANDEX_DIRECT', twoGroups)),
    );

    expect(result.ads.superseded).toBe(0);
    expect(db.store.ad.every((ad) => ad['status'] === 'ACTIVE')).toBe(true);
  });

  it('строка без заменённых баннеров ничего не гасит', async () => {
    // У Директа текст правится на месте: замены нет, и список остаётся пустым.
    await syncEntities(CLIENT, 'YANDEX_DIRECT', deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)));
    expect(db.store.ad[0]?.['supersededExternalIds']).toEqual([]);

    const result = await syncEntities(
      CLIENT,
      'YANDEX_DIRECT',
      deps(fakeAdapter('YANDEX_DIRECT', fullCabinet)),
    );

    expect(result.ads.superseded).toBe(0);
    expect(db.store.ad[0]?.['status']).toBe('ACTIVE');
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
