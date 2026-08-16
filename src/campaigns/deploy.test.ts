import { describe, expect, it } from 'vitest';

import { UnknownRegionsError, matchRegionIds } from '../clients/yandex-direct/geo.js';

import { DryRunTransport, deployAccount, rubToMicros } from './deploy.js';
import { SMARTSAY_ACCOUNT, UTM_TEMPLATE } from './smartsay/blueprint.js';

const GEO = [
  { GeoRegionId: 225, GeoRegionName: 'Россия', GeoRegionType: 'COUNTRY' },
  { GeoRegionId: 2, GeoRegionName: 'Санкт-Петербург', GeoRegionType: 'CITY', ParentId: 10174 },
  { GeoRegionId: 10174, GeoRegionName: 'Ленинградская область', GeoRegionType: 'REGION' },
  { GeoRegionId: 100961, GeoRegionName: 'Петергоф', GeoRegionType: 'CITY', ParentId: 2 },
  { GeoRegionId: 100962, GeoRegionName: 'Ломоносов', GeoRegionType: 'CITY', ParentId: 2 },
  { GeoRegionId: 100963, GeoRegionName: 'Стрельна', GeoRegionType: 'CITY', ParentId: 2 },
  { GeoRegionId: 100964, GeoRegionName: 'Красное Село', GeoRegionType: 'CITY', ParentId: 2 },
];

const OPTIONS = {
  startDate: '2026-08-09',
  counterIds: [99999999],
  urlParams: UTM_TEMPLATE,
};

function deploy(onlyPriority?: readonly (1 | 2 | 3)[]) {
  const transport = new DryRunTransport(GEO);
  return deployAccount(transport, SMARTSAY_ACCOUNT, {
    ...OPTIONS,
    ...(onlyPriority ? { onlyPriority } : {}),
  });
}

describe('rubToMicros', () => {
  it('переводит рубли в микроединицы API', () => {
    expect(rubToMicros(4500)).toBe(4_500_000_000);
    expect(rubToMicros(0.5)).toBe(500_000);
  });
});

describe('matchRegionIds', () => {
  it('находит регионы по имени без учёта регистра и ё', () => {
    const ids = matchRegionIds(GEO, ['россия', 'Санкт-Петербург']);
    expect(ids.get('россия')).toBe(225);
    expect(ids.get('Санкт-Петербург')).toBe(2);
  });

  it('падает с перечислением ненайденных, а не молча пропускает', () => {
    expect(() => matchRegionIds(GEO, ['Петергоф', 'Урюпинск'])).toThrow(UnknownRegionsError);
    try {
      matchRegionIds(GEO, ['Урюпинск']);
    } catch (error) {
      expect((error as UnknownRegionsError).regions).toEqual(['Урюпинск']);
    }
  });
});

describe('deployAccount', () => {
  it('создаёт все кампании blueprint и возвращает их ID', async () => {
    const result = await deploy();

    expect(result.campaigns).toHaveLength(SMARTSAY_ACCOUNT.campaigns.length);
    expect(result.campaigns.every((c) => c.id > 0)).toBe(true);
  });

  it('заливает столько фраз и объявлений, сколько описано в blueprint', async () => {
    const result = await deploy();

    const expectedKeywords = SMARTSAY_ACCOUNT.campaigns.reduce(
      (sum, c) => sum + c.groups.reduce((s, g) => s + g.keywords.length, 0),
      0,
    );
    expect(result.keywordCount).toBe(expectedKeywords);
    expect(result.adCount).toBeGreaterThan(0);
  });

  it('запрашивает справочник регионов один раз, а не на каждую кампанию', async () => {
    const result = await deploy();
    const dictCalls = result.calls.filter((c) => c.service === 'dictionaries');
    expect(dictCalls).toHaveLength(1);
  });

  it('создаёт кампании остановленными: в payload нет включения показов', async () => {
    const result = await deploy();
    const campaignCalls = result.calls.filter((c) => c.service === 'campaigns');

    for (const call of campaignCalls) {
      expect(JSON.stringify(call.params)).not.toContain('"State":"ON"');
      expect(JSON.stringify(call.params)).not.toContain('resume');
    }
  });

  it('выключает сети в поисковых кампаниях и поиск в сетевых', async () => {
    const result = await deploy();
    const payloads = result.calls
      .filter((c) => c.service === 'campaigns')
      .map((c) => (c.params.Campaigns as Record<string, unknown>[])[0]);

    for (const payload of payloads) {
      const blueprint = SMARTSAY_ACCOUNT.campaigns.find((c) => c.name === payload?.Name);
      const strategy = (payload?.TextCampaign as Record<string, unknown>).BiddingStrategy as {
        Search: { BiddingStrategyType: string };
        Network: { BiddingStrategyType: string };
      };

      if (blueprint?.placement === 'search') {
        expect(strategy.Network.BiddingStrategyType).toBe('SERVING_OFF');
        expect(strategy.Search.BiddingStrategyType).not.toBe('SERVING_OFF');
      } else {
        expect(strategy.Search.BiddingStrategyType).toBe('SERVING_OFF');
      }
    }
  });

  it('переводит недельный бюджет в микроединицы', async () => {
    const result = await deploy([1]);
    const adults = result.calls
      .filter((c) => c.service === 'campaigns')
      .map((c) => (c.params.Campaigns as Record<string, unknown>[])[0])
      .find((p) => (p?.Name as string).includes('Взрослые'));

    const strategy = (adults?.TextCampaign as Record<string, unknown>).BiddingStrategy as {
      Search: { WbMaximumClicks: { WeeklySpendLimit: number } };
    };
    expect(strategy.Search.WbMaximumClicks.WeeklySpendLimit).toBe(4_500_000_000);
  });

  it('подставляет счётчик Метрики и UTM во все объявления', async () => {
    const result = await deploy([1]);

    const campaignPayload = (
      result.calls.find((c) => c.service === 'campaigns')?.params.Campaigns as Record<
        string,
        unknown
      >[]
    )[0];
    expect((campaignPayload?.TextCampaign as Record<string, unknown>).CounterIds).toEqual({
      Items: [99999999],
    });

    const adCalls = result.calls.filter((c) => c.service === 'ads');
    for (const call of adCalls) {
      for (const ad of call.params.Ads as { TextAd: { Href: string } }[]) {
        expect(ad.TextAd.Href).toContain('utm_source=yandex');
        expect(ad.TextAd.Href.startsWith('https://smartsay.ru/')).toBe(true);
      }
    }
  });

  it('фильтрует кампании по приоритету', async () => {
    const result = await deploy([1]);
    const firstWave = SMARTSAY_ACCOUNT.campaigns.filter((c) => c.priority === 1);
    expect(result.campaigns).toHaveLength(firstWave.length);
  });

  it('не отправляет группе ретаргетинга ключевые фразы', async () => {
    const result = await deploy();
    const retargeting = SMARTSAY_ACCOUNT.campaigns.find((c) => c.placement === 'retargeting');
    const campaignIndex = result.campaigns.findIndex((c) => c.name === retargeting?.name);
    expect(campaignIndex).toBeGreaterThanOrEqual(0);

    const groupIds = new Set(result.campaigns[campaignIndex]?.groups.map((g) => g.id));
    const keywordCalls = result.calls.filter((c) => c.service === 'keywords');
    for (const call of keywordCalls) {
      for (const keyword of call.params.Keywords as { AdGroupId: number }[]) {
        expect(groupIds.has(keyword.AdGroupId)).toBe(false);
      }
    }
  });

  it('сохраняет порядок вызовов: кампания → группы → фразы → объявления', async () => {
    const result = await deploy([1]);
    const order = result.calls.filter((c) => c.service !== 'dictionaries').map((c) => c.service);

    const firstCampaign = order.indexOf('campaigns');
    expect(order[firstCampaign]).toBe('campaigns');
    expect(order[firstCampaign + 1]).toBe('adgroups');
    expect(order[firstCampaign + 2]).toBe('keywords');
    expect(order[firstCampaign + 3]).toBe('ads');
  });
});
