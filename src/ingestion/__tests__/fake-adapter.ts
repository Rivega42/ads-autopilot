import type { Provider } from '@prisma/client';

import type {
  ChannelAdapter,
  ChannelContext,
  RemoteAd,
  RemoteAdGroup,
  RemoteCampaign,
  RemoteKeyword,
  SearchQueryRow,
  StatLevel,
  StatRow,
  WriteResult,
} from '@/channels/types.js';

const noWrite = async (): Promise<WriteResult> => ({ applied: false, plan: {} });

export interface FakeAdapterData {
  campaigns?: RemoteCampaign[];
  adGroups?: RemoteAdGroup[];
  ads?: RemoteAd[];
  keywords?: RemoteKeyword[];
  stats?: Partial<Record<StatLevel, StatRow[]>>;
  searchQueries?: SearchQueryRow[];
  /** Не реализовывать `getSearchQueries` — канал без отчёта по запросам. */
  withoutSearchQueries?: boolean;
}

/** Адаптер-заглушка: отдаёт заранее заданные данные, ничего не пишет. */
export function fakeAdapter(
  channel: Provider,
  data: FakeAdapterData = {},
): ChannelAdapter & { calls: string[] } {
  const calls: string[] = [];
  const adapter: ChannelAdapter & { calls: string[] } = {
    channel,
    calls,
    verifyAccess: async () => ({ ok: true }),
    listCampaigns: async () => {
      calls.push('listCampaigns');
      return data.campaigns ?? [];
    },
    listAdGroups: async () => {
      calls.push('listAdGroups');
      return data.adGroups ?? [];
    },
    listAds: async () => {
      calls.push('listAds');
      return data.ads ?? [];
    },
    listKeywords: async () => {
      calls.push('listKeywords');
      return data.keywords ?? [];
    },
    getStats: async (_ctx: ChannelContext, level: StatLevel) => {
      calls.push(`getStats:${level}`);
      return data.stats?.[level] ?? [];
    },
    setBids: noWrite,
    setBudgets: noWrite,
    pauseEntities: noWrite,
    resumeEntities: noWrite,
  };

  if (!data.withoutSearchQueries) {
    adapter.getSearchQueries = async () => {
      calls.push('getSearchQueries');
      return data.searchQueries ?? [];
    };
  }
  return adapter;
}

export function remoteCampaign(patch: Partial<RemoteCampaign> = {}): RemoteCampaign {
  return {
    externalId: '100',
    name: 'SEO услуги',
    type: 'TEXT_CAMPAIGN',
    status: 'ON',
    dailyBudget: 5000,
    strategy: { Search: { BiddingStrategyType: 'WB_MAXIMUM_CLICKS' } },
    raw: {},
    ...patch,
  };
}

export function remoteAdGroup(patch: Partial<RemoteAdGroup> = {}): RemoteAdGroup {
  return {
    externalId: '200',
    campaignExternalId: '100',
    name: 'Москва',
    status: 'ACCEPTED',
    targeting: { regionIds: [213] },
    raw: {},
    ...patch,
  };
}

export function remoteAd(patch: Partial<RemoteAd> = {}): RemoteAd {
  return {
    externalId: '300',
    adGroupExternalId: '200',
    title: 'Продвижение сайтов',
    text: 'От 30 000 ₽',
    status: 'ON',
    moderationStatus: 'ACCEPTED',
    raw: {},
    ...patch,
  };
}

export function remoteKeyword(patch: Partial<RemoteKeyword> = {}): RemoteKeyword {
  return {
    externalId: '400',
    adGroupExternalId: '200',
    phrase: 'seo продвижение',
    bid: 42.5,
    status: 'ON',
    raw: {},
    ...patch,
  };
}

export function fakeContext(clientId: string, credentials: Record<string, unknown> = {}) {
  return async (): Promise<ChannelContext> => ({ clientId, credentials, dryRun: true });
}
