import type { Provider } from '@prisma/client';

import type { ApprovalAction } from '@/approval/types.js';
import type { StatLevel } from '@/channels/types.js';
import { keepsBidOnAdGroup, syncVkAdGroupBids } from '@/clients/vk-ads/local-state.js';
import { prisma } from '@/db/prisma.js';

export interface LocalStateResult {
  /** Сколько сущностей действие адресовало. */
  requested: number;
  /** Сколько наших строк удалось привести в соответствие с кабинетом. */
  updated: number;
}

/** Владелец строки: по внешнему id одного клиента нельзя трогать строки другого. */
interface Owner {
  clientId: string;
  provider: Provider;
}

/**
 * Приводит наши строки к тому, что человек уже одобрил и что уже в кабинете.
 *
 * Тот же долг, что и у пометки минус-фраз (`markNegatedQueries`): решения
 * оптимизатора считаются от значений в нашей БД (`Keyword.status`, `Keyword.bid`,
 * `Ad.status`, `Campaign.dailyBudget`), и пока строка не обновлена, следующий
 * прогон видит прежнее состояние и предлагает то же самое снова — новой карточкой
 * человеку и новой записью в ChangeLog об изменении, которого не было. До
 * появления этой функции дыру закрывала только загрузка сущностей раз в час.
 *
 * Адрес у одобренного действия внешний, поэтому каждый запрос ограничен парой
 * (клиент, площадка): внешний id уникален в кабинете, но не в нашей таблице, и
 * без ограничения можно погасить чужую строку с тем же номером.
 *
 * Ноль обновлённых строк при непустом `requested` означает, что сущности в нашей
 * базе нет: изменение в кабинете есть, а у нас не отражено — и вызывающий обязан
 * сказать об этом человеку, иначе карточка вернётся завтра.
 *
 * @throws ошибку Prisma — вызывающий сам решает, чем это для него является.
 */
export async function syncLocalEntities(action: ApprovalAction): Promise<LocalStateResult> {
  const owner: Owner = { clientId: action.clientId, provider: action.channel };

  switch (action.kind) {
    case 'pause_entities':
      return setStatus(owner, action.level, action.externalIds, 'PAUSED');

    case 'resume_entities':
      return setStatus(owner, action.level, action.externalIds, 'ACTIVE');

    case 'bid_change':
      // Ставка живёт не на одном и том же уровне у всех каналов: у Директа это
      // фраза, у VK — группа объявлений, и `keywordExternalId` карточки там на
      // самом деле id группы (`VkAdsAdapter.setBids`). Пока ветки не было, ставку
      // VK писать было некуда: фраз у канала ноль, `updateMany` находил ноль строк,
      // и каждая карточка ставки заканчивалась «обновлено частично (0 из 1)».
      return keepsBidOnAdGroup(owner.provider)
        ? syncVkAdGroupBids(
            owner.clientId,
            action.changes.map((c) => ({ adGroupExternalId: c.keywordExternalId, bid: c.bid })),
          )
        : setBids(owner, action.changes);

    case 'budget_change': {
      const updated = await prisma.campaign.updateMany({
        where: { externalId: { in: [action.campaignExternalId] }, ...owner },
        data: { dailyBudget: action.after },
      });
      return { requested: 1, updated: updated.count };
    }

    // Минус-слова отражает `markNegatedQueries` во флаге `SearchQueryStat.negated`;
    // у создаваемой кампании своей строки ещё нет вовсе.
    case 'add_negatives':
    case 'create_campaign':
      return { requested: 0, updated: 0 };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

async function setStatus(
  owner: Owner,
  level: StatLevel,
  externalIds: readonly string[],
  status: 'ACTIVE' | 'PAUSED',
): Promise<LocalStateResult> {
  const ids = [...new Set(externalIds)];
  const requested = ids.length;
  if (requested === 0) return { requested: 0, updated: 0 };

  const externalId = { in: ids };
  switch (level) {
    case 'campaign': {
      const res = await prisma.campaign.updateMany({
        where: { externalId, ...owner },
        data: { status },
      });
      return { requested, updated: res.count };
    }
    case 'adgroup': {
      const res = await prisma.adGroup.updateMany({
        where: { externalId, campaign: owner },
        data: { status },
      });
      return { requested, updated: res.count };
    }
    case 'ad': {
      const res = await prisma.ad.updateMany({
        where: { externalId, adGroup: { campaign: owner } },
        data: { status },
      });
      return { requested, updated: res.count };
    }
    case 'keyword': {
      const res = await prisma.keyword.updateMany({
        where: { externalId, adGroup: { campaign: owner } },
        data: { status },
      });
      return { requested, updated: res.count };
    }
  }
}

async function setBids(
  owner: Owner,
  changes: ReadonlyArray<{ keywordExternalId: string; bid: number }>,
): Promise<LocalStateResult> {
  // Одна ставка — один запрос: значения у фраз разные, а `updateMany` пишет всем одно.
  const byBid = new Map<number, string[]>();
  for (const change of changes) {
    const ids = byBid.get(change.bid) ?? [];
    if (!ids.includes(change.keywordExternalId)) ids.push(change.keywordExternalId);
    byBid.set(change.bid, ids);
  }

  let requested = 0;
  let updated = 0;
  for (const [bid, ids] of byBid) {
    requested += ids.length;
    const res = await prisma.keyword.updateMany({
      where: { externalId: { in: ids }, adGroup: { campaign: owner } },
      data: { bid },
    });
    updated += res.count;
  }
  return { requested, updated };
}
