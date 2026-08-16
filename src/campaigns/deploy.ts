import type {
  DeployResult,
  DeployedCampaign,
  RecordedCall,
  Transport,
} from '../clients/yandex-direct/deploy-types.js';
import { resolveRegionIds } from '../clients/yandex-direct/geo.js';

import {
  createCallouts,
  createSitelinkSet,
  createVCard,
  uploadImages,
} from './extensions-deploy.js';
import { adVariants } from './smartsay/ad-variants.js';
import type { AccountBlueprint, CampaignBlueprint, StrategyType } from './smartsay/types.js';

/**
 * Заливка blueprint в Яндекс Директ.
 *
 * Кампании создаются остановленными: показы включает человек после того,
 * как глазами посмотрит на объявления в интерфейсе. Автоматически включать
 * рекламу, которая тратит деньги клиента, нельзя ни при каких настройках.
 */

/** Деньги в API v5 — в микроединицах валюты: 1 ₽ = 1 000 000. */
export function rubToMicros(rub: number): number {
  return Math.round(rub * 1_000_000);
}

const SERVING_OFF = { BiddingStrategyType: 'SERVING_OFF' } as const;

function searchStrategy(campaign: CampaignBlueprint): Record<string, unknown> {
  const weekly = rubToMicros(campaign.weeklyBudgetRub);

  const byType: Record<StrategyType, Record<string, unknown>> = {
    max_clicks_weekly_budget: {
      BiddingStrategyType: 'WB_MAXIMUM_CLICKS',
      WbMaximumClicks: { WeeklySpendLimit: weekly },
    },
    max_clicks_manual_bids: { BiddingStrategyType: 'HIGHEST_POSITION' },
    max_conversions_cpa: {
      BiddingStrategyType: 'WB_MAXIMUM_CONVERSION_RATE',
      WbMaximumConversionRate: { WeeklySpendLimit: weekly },
    },
    max_conversions_pay_per_conversion: {
      BiddingStrategyType: 'PAY_FOR_CONVERSION',
      PayForConversion: { WeeklySpendLimit: weekly },
    },
  };

  return byType[campaign.strategy];
}

function networkStrategy(campaign: CampaignBlueprint): Record<string, unknown> {
  return {
    BiddingStrategyType: 'NETWORK_DEFAULT',
    NetworkDefault: { LimitPercent: 100, BidPercent: 100 },
    ...(campaign.strategy === 'max_clicks_weekly_budget'
      ? { WbMaximumClicks: { WeeklySpendLimit: rubToMicros(campaign.weeklyBudgetRub) } }
      : {}),
  };
}

function biddingStrategy(campaign: CampaignBlueprint): Record<string, unknown> {
  if (campaign.placement === 'search') {
    return { Search: searchStrategy(campaign), Network: SERVING_OFF };
  }
  // Сети и ретаргетинг: поиск выключен, иначе кампания начнёт конкурировать
  // за те же запросы, что и поисковые, и разгонит ставку сама себе.
  return { Search: SERVING_OFF, Network: networkStrategy(campaign) };
}

export interface DeployOptions {
  /** Счётчики Метрики для кампаний. Без них автостратегии не обучатся. */
  readonly counterIds?: readonly number[];
  /** Дата старта в формате YYYY-MM-DD. Кампания всё равно создаётся остановленной. */
  readonly startDate: string;
  /** UTM-шаблон в поле «Параметры URL». */
  readonly urlParams?: string;
  readonly onlyPriority?: readonly (1 | 2 | 3)[];
  /** Картинки для РСЯ по имени кампании: base64 файлов из creatives/out. */
  readonly imagesByCampaign?: Readonly<
    Record<string, readonly { readonly name: string; readonly base64: string }[]>
  >;
  readonly log?: (line: string) => void;
}

function campaignPayload(
  campaign: CampaignBlueprint,
  options: DeployOptions,
): Record<string, unknown> {
  const settings: Record<string, string>[] = [
    { Option: 'ADD_METRICA_TAG', Value: 'YES' },
    { Option: 'ADD_OPENSTAT_TAG', Value: 'NO' },
  ];

  const textCampaign: Record<string, unknown> = {
    BiddingStrategy: biddingStrategy(campaign),
    Settings: settings,
  };
  if (options.counterIds !== undefined && options.counterIds.length > 0) {
    textCampaign.CounterIds = { Items: [...options.counterIds] };
  }

  const payload: Record<string, unknown> = {
    Name: campaign.name,
    StartDate: options.startDate,
    TimeZone: 'Europe/Moscow',
    TextCampaign: textCampaign,
  };

  if (campaign.negativeKeywords.length > 0) {
    payload.NegativeKeywords = { Items: [...campaign.negativeKeywords] };
  }

  return payload;
}

function landingUrl(site: string, path: string, urlParams: string | undefined): string {
  if (urlParams === undefined || urlParams === '') return `${site}${path}`;
  const separator = path.includes('?') ? '&' : '?';
  return `${site}${path}${separator}${urlParams}`;
}

interface AddResult {
  readonly AddResults: readonly { readonly Id?: number; readonly Errors?: unknown[] }[];
}

function collectIds(result: AddResult, what: string): number[] {
  const ids: number[] = [];
  for (const item of result.AddResults) {
    if (item.Id === undefined) {
      throw new Error(`Директ не создал ${what}: ${JSON.stringify(item.Errors ?? item)}`);
    }
    ids.push(item.Id);
  }
  return ids;
}

export async function deployAccount(
  transport: Transport,
  account: AccountBlueprint,
  options: DeployOptions,
): Promise<DeployResult> {
  const log = options.log ?? (() => undefined);
  const wanted =
    options.onlyPriority === undefined
      ? account.campaigns
      : account.campaigns.filter((c) => options.onlyPriority?.includes(c.priority) === true);

  const regionNames = [...new Set(wanted.flatMap((c) => c.regions))];
  const regionIds = await resolveRegionIds(transport, regionNames);
  log(`Регионы разрешены: ${regionNames.length}`);

  const sitelinkSetId = await createSitelinkSet(transport, account.sitelinks);
  log(`sitelinks.add  набор из ${account.sitelinks.length} ссылок → ${sitelinkSetId}`);

  const calloutIds = await createCallouts(transport, account.callouts);
  log(`adextensions.add  уточнений ${calloutIds.length}`);

  const deployed: DeployedCampaign[] = [];
  const imageHashByName = new Map<string, string>();
  let keywordCount = 0;
  let adCount = 0;

  for (const campaign of wanted) {
    const created = await transport.request<AddResult>('campaigns', 'add', {
      Campaigns: [campaignPayload(campaign, options)],
    });
    const campaignId = collectIds(created, `кампанию «${campaign.name}»`)[0] as number;
    log(`campaigns.add  ${campaign.name} → ${campaignId}`);

    const vCardId = await createVCard(transport, campaignId, account.vcard);

    // Один сюжет используют несколько кампаний. Повторная загрузка того же
    // файла стоила бы баллов и плодила дубли в библиотеке изображений.
    const campaignImages = options.imagesByCampaign?.[campaign.name] ?? [];
    const fresh = campaignImages.filter((image) => !imageHashByName.has(image.name));
    if (fresh.length > 0) {
      const hashes = await uploadImages(transport, fresh);
      fresh.forEach((image, i) => imageHashByName.set(image.name, hashes[i] as string));
      log(`adimages.add   картинок ${hashes.length}`);
    }
    const imageHashes = campaignImages
      .map((image) => imageHashByName.get(image.name))
      .filter((hash): hash is string => hash !== undefined);

    const groupsWithTargeting = campaign.groups;
    const groupPayloads = groupsWithTargeting.map((group) => {
      const payload: Record<string, unknown> = {
        Name: group.name,
        CampaignId: campaignId,
        RegionIds: campaign.regions.map((r) => regionIds.get(r)).filter((id) => id !== undefined),
      };
      if (group.negativeKeywords.length > 0) {
        payload.NegativeKeywords = { Items: [...group.negativeKeywords] };
      }
      return payload;
    });

    const addedGroups = await transport.request<AddResult>('adgroups', 'add', {
      AdGroups: groupPayloads,
    });
    const groupIds = collectIds(addedGroups, `группы кампании «${campaign.name}»`);
    log(`adgroups.add   ${groupIds.length} групп`);

    const keywords = groupsWithTargeting.flatMap((group, i) =>
      group.keywords.map((keyword) => ({ Keyword: keyword, AdGroupId: groupIds[i] })),
    );
    if (keywords.length > 0) {
      await transport.request('keywords', 'add', { Keywords: keywords });
      keywordCount += keywords.length;
      log(`keywords.add   ${keywords.length} фраз`);
    }

    const ads = groupsWithTargeting.flatMap((group, i) =>
      adVariants(group).map((variant, variantIndex) => ({
        AdGroupId: groupIds[i],
        TextAd: {
          Title: variant.title,
          Title2: variant.title2,
          Text: variant.text,
          Href: landingUrl(account.site, group.ad.landingPath, options.urlParams),
          DisplayUrlPath: group.ad.displayLink,
          Mobile: 'NO',
          VCardId: vCardId,
          SitelinkSetId: sitelinkSetId,
          AdExtensionIds: calloutIds,
          // Каждому варианту — своя картинка: одинаковая во всех трёх убила бы
          // смысл теста, Директ не смог бы различить их по креативу.
          ...(imageHashes.length > 0
            ? { AdImageHash: imageHashes[variantIndex % imageHashes.length] }
            : {}),
        },
      })),
    );
    if (ads.length > 0) {
      await transport.request('ads', 'add', { Ads: ads });
      adCount += ads.length;
      log(`ads.add        ${ads.length} объявлений`);
    }

    deployed.push({
      name: campaign.name,
      id: campaignId,
      groups: groupsWithTargeting.map((group, i) => ({
        name: group.name,
        id: groupIds[i] as number,
      })),
    });
  }

  return {
    campaigns: deployed,
    keywordCount,
    adCount,
    calls: transport instanceof DryRunTransport ? transport.calls : [],
  };
}

/**
 * Транспорт для холостого прогона: в Директ ничего не уходит, но payload
 * собирается настоящий — его можно глазами сверить перед боевой заливкой.
 */
export class DryRunTransport implements Transport {
  private readonly recorded: RecordedCall[] = [];
  private nextId = 1_000_001;

  constructor(private readonly geoRegions: readonly Record<string, unknown>[] = []) {}

  /**
   * Холостой прогон без доступа к API: справочник регионов подменяется заглушкой
   * по именам из blueprint. ID здесь ненастоящие — проверяем форму запросов,
   * а не попадание в дерево регионов Яндекса.
   */
  static forAccount(account: AccountBlueprint): DryRunTransport {
    const names = [...new Set(account.campaigns.flatMap((c) => c.regions))];
    return new DryRunTransport(
      names.map((name, i) => ({
        GeoRegionId: 900_000 + i,
        GeoRegionName: name,
        GeoRegionType: 'STUB',
      })),
    );
  }

  get calls(): readonly RecordedCall[] {
    return this.recorded;
  }

  async request<TResult>(
    service: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    this.recorded.push({ service, method, params });

    if (service === 'dictionaries') {
      return { GeoRegions: this.geoRegions } as TResult;
    }

    const collection = Object.values(params)[0];
    const count = Array.isArray(collection) ? collection.length : 1;

    if (service === 'adimages') {
      return {
        AddResults: Array.from({ length: count }, () => ({
          AdImageHash: `stub-hash-${this.nextId++}`,
        })),
      } as TResult;
    }

    return {
      AddResults: Array.from({ length: count }, () => ({ Id: this.nextId++ })),
    } as TResult;
  }
}
