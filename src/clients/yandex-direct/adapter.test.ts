import { beforeEach, describe, expect, it } from 'vitest';

import type { ChannelContext, StatLevel } from '@/channels/types.js';
import { YandexDirectAdapter } from '@/clients/yandex-direct/adapter.js';
import {
  resetYandexRuntimeState,
  type HttpRequest,
  type HttpResponse,
} from '@/clients/yandex-direct/http.js';

interface Step {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
}

interface FakeTransport {
  (req: HttpRequest): Promise<HttpResponse>;
  calls: HttpRequest[];
}

function transportOf(steps: Step[] = [{}]): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = async (req: HttpRequest): Promise<HttpResponse> => {
    const step = steps[calls.length] ?? steps.at(-1);
    calls.push(req);
    return {
      status: step?.status ?? 200,
      headers: step?.headers ?? {},
      data: step?.data ?? { result: {} },
    };
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

function adapterOf(transport: FakeTransport): YandexDirectAdapter {
  return new YandexDirectAdapter({
    transport,
    ledger: { record: async () => undefined },
    baseUrl: 'https://api-sandbox.direct.yandex.com/json/v5/',
    unitsReserve: 0,
    reportOptions: { sleepFn: async () => undefined },
  });
}

function ctxOf(dryRun: boolean): ChannelContext {
  return { clientId: 'client-1', credentials: { accessToken: 'token' }, dryRun };
}

function params(req: HttpRequest | undefined): Record<string, unknown> {
  return (req?.body as { params?: Record<string, unknown> })?.params ?? {};
}

beforeEach(() => {
  resetYandexRuntimeState();
});

describe('dry run', () => {
  const cases: Array<[string, (a: YandexDirectAdapter, ctx: ChannelContext) => Promise<unknown>]> =
    [
      ['setBids', (a, c) => a.setBids(c, [{ keywordExternalId: '1', bid: 10 }])],
      ['setBudgets', (a, c) => a.setBudgets(c, [{ campaignExternalId: '5', dailyBudget: 1000 }])],
      ['pauseEntities', (a, c) => a.pauseEntities(c, 'campaign', ['5'])],
      ['resumeEntities', (a, c) => a.resumeEntities(c, 'campaign', ['5'])],
      ['addNegativeKeywords', (a, c) => a.addNegativeKeywords(c, '5', ['бесплатно'])],
      ['updateAdText', (a, c) => a.updateAdText(c, '42', { title: 'Заголовок', text: 'Текст' })],
    ];

  it.each(cases)('%s issues no HTTP request at all', async (_name, call) => {
    const transport = transportOf();
    const result = await call(adapterOf(transport), ctxOf(true));

    // Главный инвариант EPIC-01: при dryRun ни один запрос не покидает процесс —
    // включая read-modify-write вроде минус-фраз.
    expect(transport.calls).toHaveLength(0);
    expect(result).toMatchObject({ applied: false });
    expect((result as { plan: Record<string, unknown> }).plan).toBeTruthy();
  });

  it('returns a plan that describes what would have happened', async () => {
    const res = await adapterOf(transportOf()).setBids(ctxOf(true), [
      { keywordExternalId: '7', bid: 12.5 },
    ]);
    expect(res.plan).toEqual({
      action: 'KeywordBids.set',
      count: 1,
      bids: [{ keywordId: 7, searchBid: 12.5 }],
    });
  });
});

describe('writes when dry run is off', () => {
  it('applies bids and reports the summary', async () => {
    const transport = transportOf([{ data: { result: { SetResults: [{ KeywordId: 7 }] } } }]);
    const res = await adapterOf(transport).setBids(ctxOf(false), [
      { keywordExternalId: '7', bid: 12.5 },
    ]);

    expect(transport.calls).toHaveLength(1);
    expect(params(transport.calls[0])['KeywordBids']).toEqual([
      { KeywordId: 7, SearchBid: 12_500_000 },
    ]);
    expect(res.applied).toBe(true);
  });

  it('reads the current negative keywords before replacing them', async () => {
    const transport = transportOf([
      {
        data: {
          result: { Campaigns: [{ Id: 5, Name: 'C', NegativeKeywords: { Items: ['даром'] } }] },
        },
      },
      { data: { result: { UpdateResults: [{ Id: 5 }] } } },
    ]);
    const res = await adapterOf(transport).addNegativeKeywords(ctxOf(false), '5', ['бесплатно']);

    expect(transport.calls).toHaveLength(2);
    expect(params(transport.calls[1])['Campaigns']).toEqual([
      { Id: 5, NegativeKeywords: { Items: ['даром', 'бесплатно'] } },
    ]);
    expect(res.applied).toBe(true);
  });

  it('refuses to suspend an ad group, which the API has no method for', async () => {
    await expect(
      adapterOf(transportOf()).pauseEntities(ctxOf(false), 'adgroup', ['1']),
    ).rejects.toThrow(/cannot suspend\/resume/);
  });

  it('rejects a non-numeric external id before touching the network', async () => {
    const transport = transportOf();
    await expect(
      adapterOf(transport).pauseEntities(ctxOf(false), 'campaign', ['not-a-number']),
    ).rejects.toThrow(/Not a numeric Yandex id/);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('reads', () => {
  it('maps campaigns into the channel-agnostic shape', async () => {
    const transport = transportOf([
      {
        data: {
          result: {
            Campaigns: [
              {
                Id: 111,
                Name: 'Поиск / Москва',
                Type: 'TEXT_CAMPAIGN',
                State: 'ON',
                Status: 'ACCEPTED',
                DailyBudget: { Amount: 1_500_000_000, Mode: 'STANDARD' },
                TextCampaign: {
                  BiddingStrategy: { Search: { BiddingStrategyType: 'AVERAGE_CPA' } },
                },
              },
            ],
          },
        },
      },
    ]);

    const [campaign] = await adapterOf(transport).listCampaigns(ctxOf(false));
    expect(campaign).toMatchObject({
      externalId: '111',
      name: 'Поиск / Москва',
      type: 'TEXT_CAMPAIGN',
      status: 'ON',
      dailyBudget: 1500,
    });
    expect(campaign?.strategy).toEqual({ Search: { BiddingStrategyType: 'AVERAGE_CPA' } });
  });

  it('surfaces the moderation status and rejection reason of an ad', async () => {
    const transport = transportOf([
      {
        data: {
          result: {
            Ads: [
              {
                Id: 42,
                AdGroupId: 7,
                State: 'OFF',
                Status: 'REJECTED',
                StatusClarification: 'Превосходная степень без подтверждения',
                TextAd: { Title: 'Лучший', Title2: 'В мире', Text: 'Текст', Href: 'https://x.ru' },
              },
            ],
          },
        },
      },
    ]);

    const [ad] = await adapterOf(transport).listAds(ctxOf(false), ['7']);
    expect(ad).toMatchObject({
      externalId: '42',
      adGroupExternalId: '7',
      title: 'Лучший',
      title2: 'В мире',
      moderationStatus: 'REJECTED',
      moderationReason: 'Превосходная степень без подтверждения',
    });
  });

  it('converts keyword bids out of micro-units', async () => {
    const transport = transportOf([
      {
        data: {
          result: {
            Keywords: [
              { Id: 3, AdGroupId: 7, Keyword: 'купить слона', Bid: 25_000_000, State: 'ON' },
            ],
          },
        },
      },
    ]);
    const [kw] = await adapterOf(transport).listKeywords(ctxOf(false), ['7']);
    expect(kw).toMatchObject({ externalId: '3', phrase: 'купить слона', bid: 25 });
  });

  it('turns a campaign performance report into StatRow values', async () => {
    const transport = transportOf([
      {
        status: 200,
        data: [
          'Date\tCampaignId\tImpressions\tClicks\tCost\tConversions\tRevenue',
          '2026-08-01\t111\t1000\t50\t1250.75\t--\t--',
        ].join('\n'),
      },
    ]);

    const rows = await adapterOf(transport).getStats(ctxOf(false), 'campaign', {
      from: '2026-08-01',
      to: '2026-08-07',
    });

    expect(rows).toEqual([
      {
        date: '2026-08-01',
        entityExternalId: '111',
        impressions: 1000,
        clicks: 50,
        spend: 1250.75,
        conversions: 0,
        revenue: 0,
      },
    ]);
  });

  it('reads search queries through the search-query report', async () => {
    const transport = transportOf([
      {
        status: 200,
        data: [
          'Date\tCampaignId\tQuery\tImpressions\tClicks\tCost\tConversions',
          '2026-08-01\t111\t"купить ""слона"""\t10\t2\t50\t1',
        ].join('\n'),
      },
    ]);
    const rows = await adapterOf(transport).getSearchQueries(ctxOf(false), {
      from: '2026-08-01',
      to: '2026-08-07',
    });
    expect(rows[0]).toMatchObject({ query: 'купить "слона"', clicks: 2, conversions: 1 });
  });

  it.each<[StatLevel, string]>([
    ['campaign', 'CAMPAIGN_PERFORMANCE_REPORT'],
    ['adgroup', 'AD_PERFORMANCE_REPORT'],
    ['ad', 'AD_PERFORMANCE_REPORT'],
    ['keyword', 'AD_PERFORMANCE_REPORT'],
  ])('picks the right report type for level %s', async (level, expected) => {
    const transport = transportOf([{ status: 200, data: 'Date\n' }]);
    await adapterOf(transport).getStats(ctxOf(false), level, {
      from: '2026-08-01',
      to: '2026-08-01',
    });
    expect(params(transport.calls[0])['ReportType']).toBe(expected);
  });

  it('verifies access via the cheapest account call', async () => {
    const transport = transportOf([
      { data: { result: { Clients: [{ Login: 'demo', ClientInfo: 'ООО Ромашка' }] } } },
    ]);
    expect(await adapterOf(transport).verifyAccess(ctxOf(false))).toEqual({
      ok: true,
      accountName: 'ООО Ромашка',
    });
    expect(transport.calls[0]?.url).toContain('/clients');
  });

  it('fails with an auth error when the credentials are unusable', async () => {
    const adapter = adapterOf(transportOf());
    await expect(
      adapter.verifyAccess({ clientId: 'c', credentials: {}, dryRun: false }),
    ).rejects.toThrow(/credentials are missing or malformed/);
  });
});
