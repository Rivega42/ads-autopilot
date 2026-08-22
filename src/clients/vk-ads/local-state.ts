import type { Provider } from '@prisma/client';

import { VK_CHANNEL } from '@/clients/vk-ads/auth.js';
import { prisma } from '@/db/prisma.js';

/** Изменение ставки VK: адрес внешний, потому что таким его знает карточка апрува. */
export interface VkAdGroupBidChange {
  adGroupExternalId: string;
  bid: number;
}

export interface VkBidSyncResult {
  /** Сколько групп адресовало изменение. */
  requested: number;
  /** Сколько наших строк приведено в соответствие с кабинетом. */
  updated: number;
}

/**
 * Держит ли канал ставку на группе объявлений, а не на фразе.
 *
 * У Директа торг идёт по ключевым фразам (`Keyword.bid`), у VK фраз нет вовсе:
 * показы покупаются аудиториями, а цена задаётся на группе. Из-за этого одна и та
 * же карточка `bid_change` адресует у двух каналов разные таблицы, и решать, какую
 * из них писать, должен тот, кто знает про канал, — то есть этот модуль.
 */
export function keepsBidOnAdGroup(provider: Provider): boolean {
  return provider === VK_CHANNEL;
}

/**
 * Приводит `AdGroup.bid` к тому, что уже применено в кабинете VK.
 *
 * Тот же долг, что и у фраз (`optimizer/local-state.ts`, `approval/local-state.ts`):
 * решения считаются от значений в нашей БД, и пока строка не обновлена, следующий
 * прогон видит прежнюю цену и предлагает ровно то же изменение — новой карточкой
 * человеку и новой записью в `ChangeLog` об изменении, которого не было. До появления
 * колонки писать это было некуда, и каждая ставка VK заканчивалась предупреждением
 * «обновлено частично (0 из 1)» — не сигналом о поломке, а постоянным фоном.
 *
 * Адрес у одобренного действия внешний, поэтому запрос ограничен парой (клиент,
 * VK): id группы уникален в кабинете, но не в нашей таблице, и без ограничения
 * можно переписать ставку однофамильцу из чужого кабинета.
 *
 * Один запрос на одно значение ставки: `updateMany` пишет всем адресатам одно
 * число, а в карточке групп бывает несколько и цены у них разные.
 *
 * @param clientId - владелец кабинета; провайдер здесь не параметр, а константа.
 * @param changes - изменения, уже применённые в кабинете.
 * @throws ошибку Prisma — вызывающий сам решает, чем это для него является.
 */
export async function syncVkAdGroupBids(
  clientId: string,
  changes: readonly VkAdGroupBidChange[],
): Promise<VkBidSyncResult> {
  const byBid = new Map<number, string[]>();
  for (const change of changes) {
    const ids = byBid.get(change.bid) ?? [];
    if (!ids.includes(change.adGroupExternalId)) ids.push(change.adGroupExternalId);
    byBid.set(change.bid, ids);
  }

  let requested = 0;
  let updated = 0;
  for (const [bid, externalIds] of byBid) {
    requested += externalIds.length;
    const res = await prisma.adGroup.updateMany({
      where: {
        externalId: { in: externalIds },
        campaign: { clientId, provider: VK_CHANNEL },
      },
      data: { bid },
    });
    updated += res.count;
  }
  return { requested, updated };
}
