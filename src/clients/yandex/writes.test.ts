import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetYandexRuntimeState,
  YandexHttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@/clients/yandex/http.js';
import {
  addCampaignNegativeKeywords,
  buildCampaignPayload,
  resume,
  setCampaignNegativeKeywords,
  setKeywordBids,
  summariseResults,
  suspend,
  updateAds,
  updateCampaigns,
} from '@/clients/yandex/writes.js';

interface FakeTransport {
  (req: HttpRequest): Promise<HttpResponse>;
  calls: HttpRequest[];
}

function transportOf(bodies: unknown[]): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = async (req: HttpRequest): Promise<HttpResponse> => {
    const index = calls.length;
    calls.push(req);
    return { status: 200, headers: {}, data: bodies[index] ?? bodies.at(-1) };
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

function clientOf(transport: FakeTransport): YandexHttpClient {
  return new YandexHttpClient({
    clientId: 'client-1',
    credentials: { accessToken: 't' },
    baseUrl: 'https://api-sandbox.direct.yandex.com/json/v5/',
    transport,
    ledger: { record: async () => undefined },
    unitsReserve: 0,
  });
}

function params(req: HttpRequest | undefined): Record<string, unknown> {
  return (req?.body as { params?: Record<string, unknown> })?.params ?? {};
}

function method(req: HttpRequest | undefined): string {
  return (req?.body as { method?: string })?.method ?? '';
}

beforeEach(() => {
  resetYandexRuntimeState();
});

describe('summariseResults', () => {
  it('separates successes from per-object errors instead of failing the batch', () => {
    const summary = summariseResults(
      [
        { Id: 10 },
        { Errors: [{ Code: 5001, Message: 'Некорректная фраза', Details: 'слишком длинная' }] },
        { Id: 12, Warnings: [{ Code: 10100, Message: 'Часть текста обрезана' }] },
      ],
      'test',
    );

    expect(summary.succeeded).toEqual([10, 12]);
    expect(summary.failed).toEqual([
      { index: 1, code: 5001, message: 'Некорректная фраза', details: 'слишком длинная' },
    ]);
    expect(summary.warnings).toEqual([{ index: 2, code: 10100, message: 'Часть текста обрезана' }]);
  });

  it('handles a missing results array', () => {
    expect(summariseResults(undefined, 'test')).toEqual({
      succeeded: [],
      failed: [],
      warnings: [],
    });
  });
});

describe('setKeywordBids', () => {
  it('converts bids to micro-units and reports per-object failures', async () => {
    const transport = transportOf([
      {
        result: {
          SetResults: [{ KeywordId: 1 }, { Errors: [{ Code: 4001, Message: 'нет фразы' }] }],
        },
      },
    ]);

    const summary = await setKeywordBids(clientOf(transport), [
      { keywordId: 1, searchBid: 12.34 },
      { keywordId: 2, searchBid: 5, networkBid: 3, strategyPriority: 'HIGH' },
    ]);

    expect(method(transport.calls[0])).toBe('set');
    expect(params(transport.calls[0])['KeywordBids']).toEqual([
      { KeywordId: 1, SearchBid: 12_340_000 },
      { KeywordId: 2, SearchBid: 5_000_000, NetworkBid: 3_000_000, StrategyPriority: 'HIGH' },
    ]);
    expect(summary.succeeded).toEqual([1]);
    expect(summary.failed).toHaveLength(1);
  });

  it('splits more than 10 000 bids into several requests', async () => {
    const transport = transportOf([{ result: { SetResults: [] } }]);
    await setKeywordBids(
      clientOf(transport),
      Array.from({ length: 10_001 }, (_, i) => ({ keywordId: i + 1, searchBid: 1 })),
    );
    expect(transport.calls).toHaveLength(2);
  });
});

describe('buildCampaignPayload', () => {
  it('converts the daily budget to micro-units', () => {
    expect(buildCampaignPayload({ campaignId: 7, dailyBudget: 1500 })).toEqual({
      Id: 7,
      DailyBudget: { Amount: 1_500_000_000, Mode: 'STANDARD' },
    });
  });

  it('always writes both strategy sides, because the API replaces the strategy wholesale', () => {
    const payload = buildCampaignPayload({
      campaignId: 7,
      strategy: {
        search: {
          type: 'WB_MAXIMUM_CLICKS',
          settings: { WbMaximumClicks: { WeeklySpendLimit: 10 } },
        },
        network: { type: 'SERVING_OFF' },
      },
    });
    expect(payload['TextCampaign']).toEqual({
      BiddingStrategy: {
        Search: {
          BiddingStrategyType: 'WB_MAXIMUM_CLICKS',
          WbMaximumClicks: { WeeklySpendLimit: 10 },
        },
        Network: { BiddingStrategyType: 'SERVING_OFF' },
      },
    });
  });

  it('places settings under UnifiedCampaign when asked', () => {
    const payload = buildCampaignPayload({
      campaignId: 7,
      campaignKind: 'UnifiedCampaign',
      strategy: { search: { type: 'AVERAGE_CPA' }, network: { type: 'SERVING_OFF' } },
    });
    expect(payload['UnifiedCampaign']).toBeDefined();
    expect(payload['TextCampaign']).toBeUndefined();
  });
});

describe('updateCampaigns', () => {
  it('batches at ten campaigns per request', async () => {
    const transport = transportOf([{ result: { UpdateResults: [] } }]);
    await updateCampaigns(
      clientOf(transport),
      Array.from({ length: 11 }, (_, i) => ({ campaignId: i + 1, dailyBudget: 100 })),
    );
    expect(transport.calls).toHaveLength(2);
  });

  it('reports failed indices relative to the whole input, not the batch', async () => {
    const transport = transportOf([
      { result: { UpdateResults: Array.from({ length: 10 }, (_, i) => ({ Id: i + 1 })) } },
      { result: { UpdateResults: [{ Errors: [{ Code: 5001 }] }] } },
    ]);
    const summary = await updateCampaigns(
      clientOf(transport),
      Array.from({ length: 11 }, (_, i) => ({ campaignId: i + 1, dailyBudget: 100 })),
    );
    expect(summary.failed).toEqual([{ index: 10, code: 5001 }]);
  });
});

describe('suspend and resume', () => {
  it('calls the matching service method with an id selection', async () => {
    const transport = transportOf([{ result: { SuspendResults: [{ Id: 1 }] } }]);
    await suspend(clientOf(transport), 'campaigns', [1]);
    expect(transport.calls[0]?.url).toContain('/campaigns');
    expect(method(transport.calls[0])).toBe('suspend');
    expect(params(transport.calls[0])['SelectionCriteria']).toEqual({ Ids: [1] });
  });

  it('resumes ads through the ads service', async () => {
    const transport = transportOf([{ result: { ResumeResults: [{ Id: 9 }] } }]);
    const summary = await resume(clientOf(transport), 'ads', [9]);
    expect(transport.calls[0]?.url).toContain('/ads');
    expect(summary.succeeded).toEqual([9]);
  });
});

describe('updateAds', () => {
  it('rewrites the text body of an existing ad', async () => {
    const transport = transportOf([{ result: { UpdateResults: [{ Id: 42 }] } }]);
    await updateAds(clientOf(transport), [
      { adId: 42, title: 'Новый заголовок', title2: 'Второй', text: 'Новый текст' },
    ]);
    expect(params(transport.calls[0])['Ads']).toEqual([
      { Id: 42, TextAd: { Title: 'Новый заголовок', Title2: 'Второй', Text: 'Новый текст' } },
    ]);
  });
});

describe('campaign negative keywords', () => {
  it('replaces the whole list with Campaigns.update', async () => {
    const transport = transportOf([{ result: { UpdateResults: [{ Id: 5 }] } }]);
    await setCampaignNegativeKeywords(clientOf(transport), 5, ['бесплатно', 'скачать']);
    expect(params(transport.calls[0])['Campaigns']).toEqual([
      { Id: 5, NegativeKeywords: { Items: ['бесплатно', 'скачать'] } },
    ]);
  });

  it('merges new phrases with the existing ones instead of wiping them', async () => {
    const transport = transportOf([{ result: { UpdateResults: [{ Id: 5 }] } }]);
    const out = await addCampaignNegativeKeywords(
      clientOf(transport),
      5,
      ['скачать', 'бесплатно'],
      ['бесплатно'],
    );
    expect(out.added).toEqual(['скачать']);
    expect(out.total).toEqual(['бесплатно', 'скачать']);
    expect(params(transport.calls[0])['Campaigns']).toEqual([
      { Id: 5, NegativeKeywords: { Items: ['бесплатно', 'скачать'] } },
    ]);
  });

  it('spends nothing when every phrase is already present', async () => {
    const transport = transportOf([{ result: { UpdateResults: [] } }]);
    const out = await addCampaignNegativeKeywords(
      clientOf(transport),
      5,
      ['бесплатно'],
      ['бесплатно'],
    );
    expect(out.added).toEqual([]);
    expect(transport.calls).toHaveLength(0);
  });
});
