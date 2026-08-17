import { describe, expect, it } from 'vitest';

import { UnknownRegionsError, matchRegionIds } from '../clients/yandex-direct/geo.js';

import { BidModifierError, buildBidModifierPayloads } from './bid-modifiers-deploy.js';
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
  it('создаёт все кампании blueprint, кроме ретаргетинга без сегментов', async () => {
    const result = await deploy();
    const deployable = SMARTSAY_ACCOUNT.campaigns.filter((c) => c.placement !== 'retargeting');

    expect(result.campaigns).toHaveLength(deployable.length);
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
    const firstWave = SMARTSAY_ACCOUNT.campaigns.filter(
      (c) => c.priority === 1 && c.placement !== 'retargeting',
    );
    expect(result.campaigns).toHaveLength(firstWave.length);
  });

  it('пропускает ретаргетинг, пока нет сегментов Метрики', async () => {
    const result = await deploy();
    const retargeting = SMARTSAY_ACCOUNT.campaigns.find((c) => c.placement === 'retargeting');

    expect(result.campaigns.some((c) => c.name === retargeting?.name)).toBe(false);
    expect(result.campaigns).toHaveLength(SMARTSAY_ACCOUNT.campaigns.length - 1);
  });

  it('создаёт условия ретаргетинга, когда сегменты переданы', async () => {
    const transport = new DryRunTransport(GEO);
    const retargeting = SMARTSAY_ACCOUNT.campaigns.find((c) => c.placement === 'retargeting');

    const result = await deployAccount(transport, SMARTSAY_ACCOUNT, {
      ...OPTIONS,
      retargetingListIds: { [retargeting?.name ?? '']: [777, 888] },
    });

    expect(result.campaigns.some((c) => c.name === retargeting?.name)).toBe(true);
    const targets = result.calls.filter((c) => c.service === 'audiencetargets');
    expect(targets).toHaveLength(1);
    expect((targets[0]?.params.AudienceTargets as unknown[]).length).toBe(2);
  });

  it('создаёт корректировки ставок для очных кампаний', async () => {
    const result = await deploy([1]);
    const calls = result.calls.filter((c) => c.service === 'bidmodifiers');
    expect(calls.length).toBeGreaterThan(0);

    const flat = calls.flatMap((c) => c.params.BidModifiers as Record<string, unknown>[]);
    expect(flat.some((m) => m.MobileAdjustment !== undefined)).toBe(true);
    expect(flat.some((m) => m.RegionalAdjustment !== undefined)).toBe(true);
    expect(flat.some((m) => m.DemographicsAdjustment !== undefined)).toBe(true);
  });

  it('не отправляет группе ретаргетинга ключевые фразы', async () => {
    const result = await deploy();
    const groupsWithoutKeywords = SMARTSAY_ACCOUNT.campaigns
      .flatMap((c) => c.groups)
      .filter((g) => g.keywords.length === 0)
      .map((g) => g.name);
    const groupIds = new Set(
      result.campaigns
        .flatMap((c) => c.groups)
        .filter((g) => groupsWithoutKeywords.includes(g.name))
        .map((g) => g.id),
    );
    const keywordCalls = result.calls.filter((c) => c.service === 'keywords');
    for (const call of keywordCalls) {
      for (const keyword of call.params.Keywords as { AdGroupId: number }[]) {
        expect(groupIds.has(keyword.AdGroupId)).toBe(false);
      }
    }
  });

  it('создаёт объекты в порядке зависимостей: кампания раньше групп, группы раньше фраз', async () => {
    const result = await deploy([1]);
    const order = result.calls.map((c) => c.service);
    const at = (service: string) => order.indexOf(service);

    // Набор быстрых ссылок нужен объявлениям, поэтому создаётся до всего.
    expect(at('sitelinks')).toBeLessThan(at('campaigns'));
    expect(at('campaigns')).toBeLessThan(at('vcards'));
    expect(at('vcards')).toBeLessThan(at('adgroups'));
    expect(at('bidmodifiers')).toBeLessThan(at('adgroups'));
    expect(at('adgroups')).toBeLessThan(at('keywords'));
    expect(at('keywords')).toBeLessThan(at('ads'));
  });

  it('создаёт набор быстрых ссылок и уточнения один раз на аккаунт', async () => {
    const result = await deploy();
    expect(result.calls.filter((c) => c.service === 'sitelinks')).toHaveLength(1);
    expect(result.calls.filter((c) => c.service === 'adextensions')).toHaveLength(1);
  });

  it('прикрепляет к каждому объявлению визитку, быстрые ссылки и уточнения', async () => {
    const result = await deploy([1]);

    for (const call of result.calls.filter((c) => c.service === 'ads')) {
      for (const ad of call.params.Ads as {
        TextAd: { VCardId?: number; SitelinkSetId?: number; AdExtensionIds?: number[] };
      }[]) {
        expect(ad.TextAd.VCardId).toBeGreaterThan(0);
        expect(ad.TextAd.SitelinkSetId).toBeGreaterThan(0);
        expect(ad.TextAd.AdExtensionIds?.length).toBe(SMARTSAY_ACCOUNT.callouts.length);
      }
    }
  });

  it('не загружает один и тот же файл дважды для разных кампаний', async () => {
    const transport = new DryRunTransport(GEO);
    const shared = [{ name: 'adults-1x1.jpg', base64: 'AAA' }];
    const names = SMARTSAY_ACCOUNT.campaigns.slice(0, 3).map((c) => c.name);

    await deployAccount(transport, SMARTSAY_ACCOUNT, {
      ...OPTIONS,
      imagesByCampaign: Object.fromEntries(names.map((name) => [name, shared])),
    });

    expect(transport.calls.filter((c) => c.service === 'adimages')).toHaveLength(1);
  });

  it('раздаёт вариантам объявлений разные картинки, если они переданы', async () => {
    const transport = new DryRunTransport(GEO);
    const campaign = SMARTSAY_ACCOUNT.campaigns.find((c) => c.priority === 1);
    const result = await deployAccount(transport, SMARTSAY_ACCOUNT, {
      ...OPTIONS,
      onlyPriority: [1],
      imagesByCampaign: {
        [campaign?.name ?? '']: [
          { name: 'a', base64: 'AAA' },
          { name: 'b', base64: 'BBB' },
          { name: 'c', base64: 'CCC' },
        ],
      },
    });

    const adCall = result.calls.find(
      (c) => c.service === 'ads' && JSON.stringify(c.params).includes('AdImageHash'),
    );
    const hashes = (adCall?.params.Ads as { TextAd: { AdImageHash?: string } }[])
      .slice(0, 3)
      .map((ad) => ad.TextAd.AdImageHash);
    expect(new Set(hashes).size).toBe(3);
  });
});

describe('buildBidModifierPayloads', () => {
  const regions = new Map([['Санкт-Петербург', 2]]);

  it('кладёт проценты устройств и регионов в разные поля Директа', () => {
    const payloads = buildBidModifierPayloads(
      1,
      [
        { kind: 'mobile', percent: 120, note: '' },
        { kind: 'region', region: 'Санкт-Петербург', percent: 60, note: '' },
      ],
      regions,
    );

    expect(payloads[0]).toEqual({ CampaignId: 1, MobileAdjustment: { BidModifierPercent: 120 } });
    expect(payloads[1]).toEqual({
      CampaignId: 1,
      RegionalAdjustment: { RegionId: 2, BidModifier: 60 },
    });
  });

  it('падает на неразрешённом регионе, а не создаёт корректировку в пустоту', () => {
    expect(() =>
      buildBidModifierPayloads(
        1,
        [{ kind: 'region', region: 'Урюпинск', percent: 60, note: '' }],
        regions,
      ),
    ).toThrow(BidModifierError);
  });
});
