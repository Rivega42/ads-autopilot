import { beforeEach, describe, expect, it } from 'vitest';
import {
  chunk,
  getAdGroups,
  getAds,
  getCampaigns,
  getKeywords,
  getSelfClient,
  MAX_PAGE_LIMIT,
} from '@/clients/yandex/entities.js';
import {
  resetYandexRuntimeState,
  YandexHttpClient,
  type HttpRequest,
  type HttpResponse,
} from '@/clients/yandex/http.js';

interface FakeTransport {
  (req: HttpRequest): Promise<HttpResponse>;
  calls: HttpRequest[];
}

function transportOf(pages: unknown[]): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = async (req: HttpRequest): Promise<HttpResponse> => {
    const index = calls.length;
    calls.push(req);
    return { status: 200, headers: {}, data: pages[index] ?? pages.at(-1) };
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

function body(req: HttpRequest | undefined): Record<string, unknown> {
  return (req?.body as { params?: Record<string, unknown> })?.params ?? {};
}

beforeEach(() => {
  resetYandexRuntimeState();
});

describe('chunk', () => {
  it('splits into batches of the requested size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe('LimitedBy pagination', () => {
  it('fetches a second page using LimitedBy as the next offset', async () => {
    const transport = transportOf([
      {
        result: {
          Campaigns: [
            { Id: 1, Name: 'A' },
            { Id: 2, Name: 'B' },
          ],
          // Выборка обрезана: LimitedBy — номер последнего отданного объекта.
          LimitedBy: 2,
        },
      },
      { result: { Campaigns: [{ Id: 3, Name: 'C' }] } },
    ]);

    const campaigns = await getCampaigns(clientOf(transport));

    expect(campaigns.map((c) => c.Id)).toEqual([1, 2, 3]);
    expect(transport.calls).toHaveLength(2);
    expect(body(transport.calls[0])['Page']).toEqual({ Limit: MAX_PAGE_LIMIT });
    expect(body(transport.calls[1])['Page']).toEqual({ Limit: MAX_PAGE_LIMIT, Offset: 2 });
  });

  it('stops after a single page when LimitedBy is absent', async () => {
    const transport = transportOf([{ result: { Campaigns: [{ Id: 1, Name: 'A' }] } }]);
    await getCampaigns(clientOf(transport));
    expect(transport.calls).toHaveLength(1);
  });

  it('stops when LimitedBy does not advance, instead of looping forever', async () => {
    const transport = transportOf([
      { result: { Campaigns: [{ Id: 1, Name: 'A' }], LimitedBy: 1 } },
      { result: { Campaigns: [{ Id: 2, Name: 'B' }], LimitedBy: 1 } },
    ]);
    const campaigns = await getCampaigns(clientOf(transport));
    expect(campaigns).toHaveLength(2);
    expect(transport.calls).toHaveLength(2);
  });

  it('stops when a truncated page comes back empty', async () => {
    const transport = transportOf([{ result: { Campaigns: [], LimitedBy: 5 } }]);
    expect(await getCampaigns(clientOf(transport))).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });
});

describe('request shaping', () => {
  it('asks for the bidding strategy sub-object of both campaign kinds', async () => {
    const transport = transportOf([{ result: { Campaigns: [] } }]);
    await getCampaigns(clientOf(transport));
    expect(body(transport.calls[0])['TextCampaignFieldNames']).toEqual(['BiddingStrategy']);
    expect(body(transport.calls[0])['UnifiedCampaignFieldNames']).toEqual(['BiddingStrategy']);
  });

  it('splits campaign ids into batches of ten (API selection limit)', async () => {
    const transport = transportOf([{ result: { AdGroups: [] } }]);
    await getAdGroups(clientOf(transport), {
      campaignIds: Array.from({ length: 25 }, (_, i) => i + 1),
    });
    expect(transport.calls).toHaveLength(3);
    const criteria = body(transport.calls[0])['SelectionCriteria'] as { CampaignIds: number[] };
    expect(criteria.CampaignIds).toHaveLength(10);
  });

  it('requests text bodies and moderation clarification for ads', async () => {
    const transport = transportOf([{ result: { Ads: [] } }]);
    await getAds(clientOf(transport), { adGroupIds: [1] });
    expect(body(transport.calls[0])['FieldNames']).toContain('StatusClarification');
    expect(body(transport.calls[0])['TextAdFieldNames']).toContain('Title2');
  });

  it('returns an empty list without a network call when no selection is given', async () => {
    const transport = transportOf([{ result: {} }]);
    expect(await getAdGroups(clientOf(transport), {})).toEqual([]);
    expect(await getAds(clientOf(transport), {})).toEqual([]);
    expect(await getKeywords(clientOf(transport), {})).toEqual([]);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('getSelfClient', () => {
  it('returns the account name and currency', async () => {
    const transport = transportOf([
      { result: { Clients: [{ Login: 'demo-login', ClientInfo: 'ООО Ромашка', Currency: 'RUB' }] } },
    ]);
    expect(await getSelfClient(clientOf(transport))).toEqual({
      login: 'demo-login',
      name: 'ООО Ромашка',
      currency: 'RUB',
    });
  });

  it('returns null when the account list is empty', async () => {
    const transport = transportOf([{ result: { Clients: [] } }]);
    expect(await getSelfClient(clientOf(transport))).toBeNull();
  });
});
