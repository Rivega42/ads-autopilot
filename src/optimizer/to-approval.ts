import type { Provider } from '@prisma/client';

import type { ApprovalRequest } from './policy.js';
import type { Decision } from './types.js';

import type { ApprovalAction } from '@/approval/index.js';

export interface ApprovalTarget {
  clientId: string;
  channel: Provider;
  campaignExternalId: string | null;
  campaignName: string;
  /** Внутренний id -> внешний id площадки: решения адресуются по нашим строкам. */
  externalIdOf: (entityId: string) => string | null;
}

/**
 * Перевод решения оптимизатора в дескриптор апрува.
 *
 * Возвращает null, когда карточку построить нельзя: у сущности нет внешнего
 * идентификатора, либо вид решения ещё не поддержан approval-модулем. Молча
 * подставлять пустую строку нельзя — человек одобрил бы операцию над «ничем»,
 * а apply отправил бы её в кабинет.
 */
export function toApprovalAction(
  request: ApprovalRequest,
  target: ApprovalTarget,
): ApprovalAction | null {
  const base = { clientId: target.clientId, channel: target.channel, reason: request.summary };

  switch (request.kind) {
    case 'MASS_PAUSE': {
      const level = levelOf(request.decisions);
      const externalIds = collectExternalIds(request.decisions, target);
      if (!level || externalIds.length === 0) return null;
      return { ...base, kind: 'pause_entities', level, externalIds };
    }

    case 'BID_CHANGE': {
      const changes = request.decisions.flatMap((d) => {
        const externalId = target.externalIdOf(d.entityId);
        if (!externalId || d.nextValue.kind !== 'bid') return [];
        const bidBefore = d.prevValue.kind === 'bid' ? d.prevValue.amount : undefined;
        return [
          {
            keywordExternalId: externalId,
            bid: d.nextValue.amount,
            ...(bidBefore === undefined ? {} : { bidBefore }),
          },
        ];
      });
      if (changes.length === 0) return null;
      return { ...base, kind: 'bid_change', changes };
    }

    case 'BUDGET_CHANGE': {
      const decision = request.decisions[0];
      if (!decision || !target.campaignExternalId) return null;
      if (decision.nextValue.kind !== 'budget') return null;
      const before = decision.prevValue.kind === 'budget' ? decision.prevValue.amount : 0;
      return {
        ...base,
        kind: 'budget_change',
        campaignExternalId: target.campaignExternalId,
        campaignName: target.campaignName,
        before,
        after: decision.nextValue.amount,
      };
    }

    default:
      // NEW_CAMPAIGN и STRATEGY_CHANGE оптимизатор пока не порождает; когда
      // начнёт — добавить ветку здесь, а не расширять default.
      return null;
  }
}

function levelOf(decisions: readonly Decision[]): 'campaign' | 'adgroup' | 'ad' | 'keyword' | null {
  const first = decisions[0];
  if (!first) return null;
  // Смешивать уровни в одной карточке нельзя: adapter.pauseEntities принимает
  // один уровень на вызов, и половина списка ушла бы не туда.
  if (decisions.some((d) => d.entityType !== first.entityType)) return null;
  switch (first.entityType) {
    case 'CAMPAIGN':
      return 'campaign';
    case 'ADGROUP':
      return 'adgroup';
    case 'AD':
      return 'ad';
    case 'KEYWORD':
      return 'keyword';
  }
}

function collectExternalIds(decisions: readonly Decision[], target: ApprovalTarget): string[] {
  return decisions.flatMap((d) => {
    const externalId = target.externalIdOf(d.entityId);
    return externalId ? [externalId] : [];
  });
}
