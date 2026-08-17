import { ModerationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';
import { VkAdsAdapter, buildRecreatePayload } from '@/clients/vk-ads/adapter.js';
import { VK_PATHS } from '@/clients/vk-ads/entities.js';
import { RateLimitGovernor, VkHttpClient, type VkTransport } from '@/clients/vk-ads/http.js';
import type { VkBanner } from '@/clients/vk-ads/schemas.js';
import { toModerationStatus } from '@/ingestion/mapping.js';
import { ChannelError } from '@/lib/errors.js';

interface Recorded {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

/** Пауз в тестах нет: спейсинг проверяется в http.test.ts. */
function fastGovernor(): RateLimitGovernor {
  return new RateLimitGovernor(
    () => Date.now(),
    async () => undefined,
  );
}

/**
 * Стенд адаптера. Подменяется только транспорт: клиент адаптер создаёт сам,
 * своей настоящей фабрикой, — иначе тест прячет то, сколько клиентов (а значит
 * очередей и снимков лимитов) он на самом деле поднимает.
 */
function harness(
  reply: (call: Recorded) => unknown = () => ({ success: 1 }),
  statusOf: (call: Recorded, index: number) => number = () => 200,
): {
  adapter: VkAdsAdapter;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: VkTransport = async (config) => {
    const call: Recorded = {
      url: config.url ?? '',
      method: config.method ?? 'GET',
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    };
    calls.push(call);
    return { status: statusOf(call, calls.length - 1), data: reply(call), headers: {} };
  };
  const adapter = new VkAdsAdapter({
    http: {
      transport,
      getAccessToken: async () => 'token',
      attempts: 1,
      governor: fastGovernor(),
    },
  });
  return { adapter, calls };
}

function ctx(dryRun: boolean): ChannelContext {
  return { clientId: 'client-1', credentials: { clientId: 'a', clientSecret: 'b' }, dryRun };
}

describe('VkAdsAdapter http client lifetime', () => {
  /** Фабрика, которая, как настоящая, каждый раз создаёт новый клиент — но считает вызовы. */
  function countingHarness(): {
    adapter: VkAdsAdapter;
    created: VkHttpClient[];
  } {
    const created: VkHttpClient[] = [];
    const transport: VkTransport = async () => ({
      status: 200,
      data: { count: 0, items: [] },
      headers: {},
    });
    const adapter = new VkAdsAdapter({
      httpFactory: () => {
        const client = new VkHttpClient({
          transport,
          getAccessToken: async () => 'token',
          attempts: 1,
          governor: fastGovernor(),
        });
        created.push(client);
        return client;
      },
    });
    return { adapter, created };
  }

  it('reuses one client per cabinet, so throttle state is not thrown away', async () => {
    const { adapter, created } = countingHarness();
    const c = ctx(false);

    // Ровно тот вызов из синка, который поднимал три несинхронизированных потока.
    await Promise.all([
      adapter.listCampaigns(c),
      adapter.listAdGroups(c, []),
      adapter.listAds(c, []),
    ]);
    await adapter.getStats(c, 'campaign', { from: '2026-08-01', to: '2026-08-01' });

    expect(created).toHaveLength(1);
  });

  it('does not share a client between cabinets', async () => {
    const { adapter, created } = countingHarness();
    await adapter.listCampaigns(ctx(false));
    await adapter.listCampaigns({
      clientId: 'client-2',
      credentials: { clientId: 'a', clientSecret: 'b' },
      dryRun: false,
    });
    expect(created).toHaveLength(2);
  });

  it('builds a new client when the cabinet credentials change', async () => {
    const { adapter, created } = countingHarness();
    await adapter.listCampaigns(ctx(false));
    await adapter.listCampaigns({
      clientId: 'client-1',
      credentials: { clientId: 'another-app', clientSecret: 'b' },
      dryRun: false,
    });
    expect(created).toHaveLength(2);
  });
});

describe('VkAdsAdapter reads', () => {
  it('maps ad plans onto RemoteCampaign', async () => {
    const { adapter } = harness(() => ({
      count: 1,
      items: [
        {
          id: 55,
          name: 'Лето',
          status: 'active',
          objective: 'siteconversions',
          budget_limit_day: '1500.00',
          autobidding_mode: 'max_goals',
          max_price: '0',
        },
      ],
    }));

    const [campaign] = await adapter.listCampaigns(ctx(false));
    expect(campaign).toMatchObject({
      externalId: '55',
      name: 'Лето',
      type: 'siteconversions',
      status: 'active',
      dailyBudget: 1500,
    });
    expect(campaign?.strategy).toEqual({
      autobiddingMode: 'max_goals',
      maxPrice: 0,
      budgetLimit: null,
    });
  });

  it('reads banner texts out of textblocks', async () => {
    const { adapter } = harness(() => ({
      count: 1,
      items: [
        {
          id: 9,
          ad_group_id: 4,
          status: 'active',
          moderation_status: 'rejected',
          moderation_reason: 'превосходная степень',
          textblocks: { title_25: { text: 'Заголовок' }, text_90: { text: 'Описание' } },
          url: 'https://example.ru',
        },
      ],
    }));

    const [ad] = await adapter.listAds(ctx(false), []);
    expect(ad).toMatchObject({
      externalId: '9',
      adGroupExternalId: '4',
      title: 'Заголовок',
      text: 'Описание',
      moderationStatus: 'rejected',
      moderationReason: 'превосходная степень',
      href: 'https://example.ru',
    });
  });

  it('не выдаёт нашу собственную паузу за отказ модерации', async () => {
    const { adapter } = harness(() => ({
      count: 2,
      items: [
        // `moderation_status` у VK не обязателен. Слово `blocked` в статусе показов —
        // это ровно то, что пишет `pauseEntities`, а в словаре модерации то же слово
        // значит «отклонено»: без поправки выключенное нами объявление каждые полчаса
        // уезжало бы на переписывание и заводило в кабинете новый баннер.
        { id: 9, ad_group_id: 4, status: 'blocked' },
        { id: 10, ad_group_id: 4, status: 'active' },
      ],
    }));

    const [paused, active] = await adapter.listAds(ctx(false), []);

    expect(paused?.status).toBe('blocked');
    expect(toModerationStatus(paused?.moderationStatus ?? '')).toBe(ModerationStatus.PENDING);
    expect(toModerationStatus(active?.moderationStatus ?? '')).toBe(ModerationStatus.APPROVED);
  });

  it('has no keyword level at all', async () => {
    const { adapter, calls } = harness();
    await expect(adapter.listKeywords(ctx(false), ['1'])).resolves.toEqual([]);
    await expect(adapter.getStats(ctx(false), 'keyword', { from: 'a', to: 'b' })).resolves.toEqual(
      [],
    );
    expect(calls).toHaveLength(0);
  });

  it('resolves ids before asking for statistics', async () => {
    const { adapter, calls } = harness((call) => {
      if (call.url.startsWith('statistics/')) {
        return {
          items: [
            {
              id: '1',
              rows: [{ date: '2026-08-01', base: { shows: 10, clicks: 2, spent: 5, goals: 1 } }],
            },
          ],
        };
      }
      return { count: 1, items: [{ id: 1, name: 'p', status: 'active' }] };
    });

    const rows = await adapter.getStats(ctx(false), 'campaign', {
      from: '2026-08-01',
      to: '2026-08-01',
    });

    expect(calls[0]?.url).toBe(`${VK_PATHS.adPlans}.json`);
    expect(calls[1]?.url).toBe(`statistics/${VK_PATHS.adPlans}/day.json`);
    expect(rows).toEqual([
      {
        date: '2026-08-01',
        entityExternalId: '1',
        impressions: 10,
        clicks: 2,
        spend: 5,
        conversions: 1,
      },
    ]);
  });
});

describe('VkAdsAdapter writes under dryRun', () => {
  it('sends nothing to the transport and returns the plan instead', async () => {
    const { adapter, calls } = harness();
    const dry = ctx(true);

    const bids = await adapter.setBids(dry, [{ keywordExternalId: '11', bid: 42 }]);
    const budgets = await adapter.setBudgets(dry, [
      { campaignExternalId: '22', dailyBudget: 1000 },
    ]);
    const paused = await adapter.pauseEntities(dry, 'ad', ['33']);
    const resumed = await adapter.resumeEntities(dry, 'campaign', ['44']);

    for (const res of [bids, budgets, paused, resumed]) {
      expect(res.applied).toBe(false);
      expect(res.result).toBeUndefined();
    }
    expect(bids.plan).toMatchObject({
      action: 'setBids',
      items: [{ adGroupExternalId: '11', maxPrice: 42 }],
    });
    expect(paused.plan).toMatchObject({ action: 'pauseEntities', status: 'blocked' });
    expect(resumed.plan).toMatchObject({ action: 'resumeEntities', status: 'active' });
    // Главная гарантия контракта: при dryRun из процесса не ушёл ни один запрос.
    expect(calls).toHaveLength(0);
  });

  it('plans the delete+recreate of a banner without writing anything', async () => {
    const { adapter, calls } = harness(() => ({
      count: 1,
      items: [
        {
          id: 9,
          ad_group_id: 4,
          status: 'rejected',
          textblocks: { title_25: { text: 'старый' }, text_90: { text: 'старый текст' } },
        },
      ],
    }));

    const res = await adapter.updateAdText(ctx(true), '9', {
      title: 'новый',
      text: 'новый текст',
    });

    expect(res.applied).toBe(false);
    expect(res.plan).toMatchObject({ strategy: 'recreate', deleteBannerExternalId: '9' });
    // Единственный ушедший запрос — чтение баннера; записи нет.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });
});

describe('VkAdsAdapter writes for real', () => {
  it('writes ad group max_price for bid changes', async () => {
    const { adapter, calls } = harness();
    const res = await adapter.setBids(ctx(false), [
      { keywordExternalId: '11', bid: 42 },
      { keywordExternalId: '12', bid: 43 },
    ]);

    expect(res.applied).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${VK_PATHS.adGroups}/mass_action.json`);
    expect(calls[0]?.data).toEqual([
      { id: 11, max_price: 42 },
      { id: 12, max_price: 43 },
    ]);
  });

  it('creates the replacement banner before deleting the rejected one', async () => {
    const { adapter, calls } = harness((call) =>
      call.method === 'GET'
        ? {
            count: 1,
            items: [
              {
                id: 9,
                ad_group_id: 4,
                status: 'rejected',
                textblocks: { title_25: { text: 'старый' } },
                url: 'https://example.ru',
              },
            ],
          }
        : { id: 10, ad_group_id: 4 },
    );

    const res = await adapter.updateAdText(ctx(false), '9', {
      title: 'новый',
      text: 'новый текст',
    });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${VK_PATHS.banners}.json`,
      `POST ${VK_PATHS.banners}.json`,
      `DELETE ${VK_PATHS.banners}/9.json`,
    ]);
    expect(res.result).toEqual({
      createdBannerExternalId: '10',
      deletedBannerExternalId: '9',
    });
  });

  it('keeps the old banner alive when the created one has no confirmed id', async () => {
    const { adapter, calls } = harness((call) =>
      call.method === 'GET'
        ? { count: 1, items: [{ id: 9, ad_group_id: 4, status: 'rejected' }] }
        : // Схема ответа поехала: id замены неизвестен.
          { result: 'ok' },
    );

    await expect(
      adapter.updateAdText(ctx(false), '9', { title: 'новый', text: 'новый текст' }),
    ).rejects.toMatchObject({ code: 'VK_BANNER_CREATE_NO_ID' });

    // Удаления быть не должно: иначе группа осталась бы без объявления вообще.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('pauses the old banner and names the replacement when the delete fails', async () => {
    const { adapter, calls } = harness(
      (call) => {
        if (call.method === 'GET') {
          return { count: 1, items: [{ id: 9, ad_group_id: 4, status: 'rejected' }] };
        }
        if (call.method === 'DELETE') return { error: { message: 'gone wrong' } };
        return { id: 10, ad_group_id: 4 };
      },
      (call) => (call.method === 'DELETE' ? 500 : 200),
    );

    const err = await adapter
      .updateAdText(ctx(false), '9', { title: 'новый', text: 'новый текст' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).code).toBe('VK_BANNER_REPLACE_ORPHAN');
    // Повтор вслепую создал бы третий баннер, поэтому в ошибке видно, что уже создано.
    expect((err as ChannelError).context).toMatchObject({
      adExternalId: '9',
      createdBannerExternalId: '10',
      oldBannerPaused: true,
    });
    // Старый баннер не удалился, но и деньги больше не тратит.
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${VK_PATHS.banners}.json`,
      `POST ${VK_PATHS.banners}.json`,
      `DELETE ${VK_PATHS.banners}/9.json`,
      `POST ${VK_PATHS.banners}/mass_action.json`,
    ]);
    expect(calls[3]?.data).toEqual([{ id: 9, status: 'blocked' }]);
  });

  it('never writes a non-finite budget, because null means "no daily cap" in VK', async () => {
    const { adapter, calls } = harness();

    await expect(
      adapter.setBudgets(ctx(false), [{ campaignExternalId: '22', dailyBudget: Number.NaN }]),
    ).rejects.toMatchObject({ code: 'VK_INVALID_MONEY' });
    await expect(
      adapter.setBudgets(ctx(false), [{ campaignExternalId: '22', dailyBudget: 0 }]),
    ).rejects.toMatchObject({ code: 'VK_INVALID_MONEY' });

    // Ни один такой «апдейт» не должен доехать до площадки.
    expect(calls).toHaveLength(0);
  });

  it('quantises money to kopecks before writing', async () => {
    const { adapter, calls } = harness();
    await adapter.setBudgets(ctx(false), [{ campaignExternalId: '22', dailyBudget: 1049.376 }]);
    expect(calls[0]?.data).toEqual([{ id: 22, budget_limit_day: 1049.38 }]);
  });

  it('rejects the whole change set when one id is unusable', async () => {
    const { adapter, calls } = harness();
    await expect(
      adapter.setBids(ctx(false), [
        { keywordExternalId: '11', bid: 42 },
        { keywordExternalId: 'group-12', bid: 43 },
      ]),
    ).rejects.toMatchObject({ code: 'VK_INVALID_ID' });
    expect(calls).toHaveLength(0);
  });

  it('reports per-item rejections instead of claiming everything was applied', async () => {
    const { adapter } = harness(() => ({
      items: [
        { id: 33, success: true },
        { id: 34, error: { message: 'banner is archived' } },
      ],
    }));

    const res = await adapter.pauseEntities(ctx(false), 'ad', ['33', '34']);

    expect(res.applied).toBe(true);
    expect(res.result).toEqual({
      requested: 2,
      updated: 1,
      failed: [{ id: '34', message: 'banner is archived' }],
    });
  });

  it('does not report success when VK rejected every object', async () => {
    const { adapter } = harness(() => ({ items: [{ id: 33, error: { message: 'nope' } }] }));
    await expect(adapter.pauseEntities(ctx(false), 'ad', ['33'])).rejects.toMatchObject({
      code: 'VK_MASS_UPDATE_REJECTED',
    });
  });

  it('refuses a level VK does not have', async () => {
    const { adapter } = harness();
    await expect(adapter.pauseEntities(ctx(false), 'keyword', ['1'])).rejects.toMatchObject({
      code: 'VK_UNSUPPORTED_LEVEL',
    });
  });
});

describe('buildRecreatePayload', () => {
  it('keeps group, media and urls but swaps the texts', () => {
    const banner = {
      id: 9,
      ad_group_id: 4,
      status: 'rejected',
      name: 'баннер',
      content: { image_240x400: { id: 1 } },
      urls: { primary: { url: 'https://example.ru' } },
      textblocks: { title_25: { text: 'старый' }, text_90: { text: 'старый текст' } },
    } as unknown as VkBanner;

    const payload = buildRecreatePayload(banner, {
      title: 'новый',
      title2: 'второй',
      text: 'новый текст',
    });

    expect(payload).toMatchObject({
      ad_group_id: 4,
      name: 'баннер',
      content: { image_240x400: { id: 1 } },
      urls: { primary: { url: 'https://example.ru' } },
    });
    expect(payload['textblocks']).toEqual({
      title_25: { text: 'новый' },
      title_2: { text: 'второй' },
      text_90: { text: 'новый текст' },
    });
    // id старого баннера в тело не попадает — это создание, а не апдейт.
    expect(payload['id']).toBeUndefined();
  });

  it('не включает объявление, которое было выключено', () => {
    const banner = { id: 9, ad_group_id: 4, status: 'blocked' } as unknown as VkBanner;

    // Замена создаётся заново, а у нового баннера статус по умолчанию — «крутится».
    // Выключенное объявление (проигравший вариант A/B, пауза оптимизатора) начало бы
    // тратить бюджет клиента само.
    expect(buildRecreatePayload(banner, { title: 'новый', text: 'новый текст' })).toMatchObject({
      status: 'blocked',
    });
  });

  it('сохраняет работающий статус исходного баннера', () => {
    const banner = { id: 9, ad_group_id: 4, status: 'active' } as unknown as VkBanner;

    expect(buildRecreatePayload(banner, { title: 'новый', text: 'новый текст' })).toMatchObject({
      status: 'active',
    });
  });

  it('незнакомый статус трактует как «не крутится»', () => {
    const banner = { id: 9, ad_group_id: 4, status: 'на_модерации' } as unknown as VkBanner;

    // Ошибиться можно в обе стороны, но включить чужой бюджет дороже, чем не включить
    // объявление и дождаться человека.
    expect(buildRecreatePayload(banner, { title: 'новый', text: 'новый текст' })).toMatchObject({
      status: 'blocked',
    });
  });
});
