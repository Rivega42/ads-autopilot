import type { Provider } from '@prisma/client';

import { prisma } from '@/db/prisma.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'approval:mark-negated' });

export interface MarkNegatedInput {
  clientId: string;
  provider: Provider;
  /** Внешний id кампании на площадке: другого адреса у одобренного действия нет. */
  campaignExternalId: string;
  phrases: string[];
}

/**
 * Помечает применённые минус-фразы в `SearchQueryStat.negated`.
 *
 * Без пометки завтрашний прогон оптимизатора увидит те же строки статистики и
 * предложит те же фразы снова — и так каждые сутки: лишние units на площадке и
 * повторные карточки человеку за изменение, которое уже сделано.
 *
 * Помечаем всю кампанию, а не одну группу: минус-слово добавляется на уровне
 * кампании, значит «уже сделано» верно для всех её групп.
 *
 * Переход от внешнего id к внутреннему идёт через уникальную пару
 * `(provider, externalId)` — другого однозначного соответствия в схеме нет.
 * Кампания живёт у ровно одного клиента, поэтому чужой `clientId` означает
 * рассинхрон данных: тогда лучше не пометить ничего, чем тронуть чужую статистику.
 *
 * `mapped: false` отделено от `count: 0` намеренно: ноль строк бывает и в норме
 * (фразы уже помечены прошлым прогоном), а несопоставленная кампания означает,
 * что пометки не будет никогда и человеку это надо показать.
 *
 * @throws ошибку Prisma — вызывающий сам решает, чем это для него является.
 */
export interface MarkNegatedResult {
  /** Нашлась ли кампания, к которой относится действие. */
  mapped: boolean;
  /** Сколько строк статистики помечено. */
  count: number;
}

export async function markNegatedQueries(input: MarkNegatedInput): Promise<MarkNegatedResult> {
  const phrases = [...new Set(input.phrases)];
  if (phrases.length === 0) return { mapped: true, count: 0 };

  const campaign = await prisma.campaign.findUnique({
    where: {
      provider_externalId: { provider: input.provider, externalId: input.campaignExternalId },
    },
    select: { id: true, clientId: true },
  });

  if (!campaign || campaign.clientId !== input.clientId) {
    log.warn(
      {
        clientId: input.clientId,
        provider: input.provider,
        campaignExternalId: input.campaignExternalId,
        found: campaign?.clientId ?? null,
        phrases: phrases.length,
      },
      'cannot map campaign to internal id: negated flag not set',
    );
    return { mapped: false, count: 0 };
  }

  const updated = await prisma.searchQueryStat.updateMany({
    where: { adGroup: { campaignId: campaign.id }, query: { in: phrases }, negated: false },
    data: { negated: true },
  });
  return { mapped: true, count: updated.count };
}
