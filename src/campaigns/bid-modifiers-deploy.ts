import type { Transport } from '../clients/yandex-direct/deploy-types.js';

import type { BidModifierBlueprint } from './smartsay/types.js';

/**
 * Корректировки ставок.
 *
 * Директ хранит их отдельными объектами уровня кампании, а не полем кампании,
 * поэтому создаются после campaigns.add. Для регионов и демографии проценты
 * лежат в поле BidModifier, для устройств — в BidModifierPercent: у Яндекса
 * тут историческая несогласованность имён, и перепутать их легко.
 */

interface AddResult {
  readonly AddResults: readonly { readonly Id?: number; readonly Errors?: unknown[] }[];
}

export class BidModifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BidModifierError';
  }
}

export function buildBidModifierPayloads(
  campaignId: number,
  modifiers: readonly BidModifierBlueprint[],
  regionIds: ReadonlyMap<string, number>,
): Record<string, unknown>[] {
  return modifiers.map((modifier) => {
    if (modifier.kind === 'mobile') {
      return {
        CampaignId: campaignId,
        MobileAdjustment: { BidModifierPercent: modifier.percent },
      };
    }

    if (modifier.kind === 'region') {
      if (modifier.region === undefined) {
        throw new BidModifierError('Корректировка по региону без имени региона');
      }
      const regionId = regionIds.get(modifier.region);
      if (regionId === undefined) {
        throw new BidModifierError(`Регион корректировки не разрешён: ${modifier.region}`);
      }
      return {
        CampaignId: campaignId,
        RegionalAdjustment: { RegionId: regionId, BidModifier: modifier.percent },
      };
    }

    if (modifier.age === undefined) {
      throw new BidModifierError('Корректировка по возрасту без возрастной группы');
    }
    return {
      CampaignId: campaignId,
      DemographicsAdjustment: { Age: modifier.age, BidModifier: modifier.percent },
    };
  });
}

export async function createBidModifiers(
  transport: Transport,
  campaignId: number,
  modifiers: readonly BidModifierBlueprint[],
  regionIds: ReadonlyMap<string, number>,
): Promise<number> {
  if (modifiers.length === 0) return 0;

  const payloads = buildBidModifierPayloads(campaignId, modifiers, regionIds);
  const result = await transport.request<AddResult>('bidmodifiers', 'add', {
    BidModifiers: payloads,
  });

  result.AddResults.forEach((item, i) => {
    if (item.Id === undefined) {
      throw new BidModifierError(
        `Директ отклонил корректировку ${modifiers[i]?.kind}: ${JSON.stringify(item.Errors ?? item)}`,
      );
    }
  });

  return payloads.length;
}
