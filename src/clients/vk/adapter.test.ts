import { describe, expect, it } from 'vitest';
import type { ChannelContext } from '@/channels/types.js';
import { RateLimitGovernor, VkHttpClient, type VkTransport } from '@/clients/vk/http.js';
import { VK_PATHS } from '@/clients/vk/entities.js';
import { VkAdsAdapter, buildRecreatePayload } from '@/clients/vk/adapter.js';
import type { VkBanner } from '@/clients/vk/schemas.js';

interface Recorded {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

function harness(reply: (call: Recorded) => unknown = () => ({ success: 1 })): {
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
    return { status: 200, data: reply(call), headers: {} };
  };
  const client = new VkHttpClient({
    transport,
    getAccessToken: async () => 'token',
    attempts: 1,
    governor: new RateLimitGovernor(
      () => Date.now(),
      async () => undefined,
    ),
  });
  return { adapter: new VkAdsAdapter({ httpFactory: () => client }), calls };
}

function ctx(dryRun: boolean): ChannelContext {
  return { clientId: 'client-1', credentials: { clientId: 'a', clientSecret: 'b' }, dryRun };
}

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
        cost: 5,
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
});
