import type { Provider } from '@prisma/client';

import { summarizeDecisions, type ApprovalRequest } from './policy.js';
import type { Decision, OptimizerEntityType } from './types.js';

import type { ApprovalAction } from '@/approval/index.js';

export interface ApprovalTarget {
  clientId: string;
  channel: Provider;
  campaignExternalId: string | null;
  campaignName: string;
  /** Внутренний id -> внешний id площадки: решения адресуются по нашим строкам. */
  externalIdOf: (entityId: string) => string | null;
}

type PauseLevel = 'campaign' | 'adgroup' | 'ad' | 'keyword';

const LEVEL_BY_ENTITY: Record<OptimizerEntityType, PauseLevel> = {
  CAMPAIGN: 'campaign',
  ADGROUP: 'adgroup',
  AD: 'ad',
  KEYWORD: 'keyword',
};

/** Порядок карточек фиксирован, чтобы повтор прогона давал те же ключи идемпотентности. */
const LEVEL_ORDER: readonly PauseLevel[] = ['campaign', 'adgroup', 'ad', 'keyword'];

interface Resolved {
  decision: Decision;
  externalId: string;
}

/**
 * Перевод решений оптимизатора в дескрипторы апрувов.
 *
 * Одна заявка политики может дать несколько карточек. Так и должно быть:
 * `pauseEntities` принимает один уровень на вызов, а волна из 11+ пауз почти
 * всегда смешивает фразы и объявления; режим передачи управления (IMPORT_HANDOVER)
 * и вовсе складывает в один bucket всё подряд. Раньше такие заявки возвращали
 * `null` и человек не видел ничего — что неотличимо от сломанной системы.
 *
 * Решения без внешнего идентификатора отбрасываются поимённо, а текст карточки
 * строится по оставшимся: иначе «Отключить 4 фразы» соседствовало бы со списком
 * из одиннадцати причин.
 */
export function toApprovalActions(
  request: ApprovalRequest,
  target: ApprovalTarget,
): ApprovalAction[] {
  const pauses = new Map<PauseLevel, Resolved[]>();
  const bids: Resolved[] = [];
  const budgets: Decision[] = [];
  const negatives: Decision[] = [];

  for (const decision of request.decisions) {
    switch (decision.action) {
      case 'PAUSE': {
        const externalId = target.externalIdOf(decision.entityId);
        if (!externalId) break;
        const level = LEVEL_BY_ENTITY[decision.entityType];
        pauses.set(level, [...(pauses.get(level) ?? []), { decision, externalId }]);
        break;
      }

      case 'BID_DECREASE':
      case 'BID_INCREASE': {
        const externalId = target.externalIdOf(decision.entityId);
        if (!externalId || decision.nextValue.kind !== 'bid') break;
        bids.push({ decision, externalId });
        break;
      }

      case 'BUDGET_CHANGE': {
        if (!target.campaignExternalId || decision.nextValue.kind !== 'budget') break;
        budgets.push(decision);
        break;
      }

      case 'ADD_NEGATIVE_KEYWORD': {
        if (!target.campaignExternalId || decision.nextValue.kind !== 'negativeKeyword') break;
        negatives.push(decision);
        break;
      }

      // NEW_CAMPAIGN и STRATEGY_CHANGE оптимизатор пока не порождает; когда начнёт —
      // добавить ветку здесь, а не расширять default.
      default:
        break;
    }
  }

  const base = (
    decisions: readonly Decision[],
  ): { clientId: string; channel: Provider; reason: string } => ({
    clientId: target.clientId,
    channel: target.channel,
    // Пустой reason не пройдёт zod-схему действия, а безымянная карточка человеку бесполезна.
    reason: summarizeDecisions(request.kind, decisions) || request.summary,
  });

  const actions: ApprovalAction[] = [];

  for (const level of LEVEL_ORDER) {
    const items = pauses.get(level);
    if (!items || items.length === 0) continue;
    actions.push({
      ...base(items.map((item) => item.decision)),
      kind: 'pause_entities',
      level,
      externalIds: items.map((item) => item.externalId),
    });
  }

  if (bids.length > 0) {
    actions.push({
      ...base(bids.map((item) => item.decision)),
      kind: 'bid_change',
      changes: bids.map(({ decision, externalId }) => {
        const bid = decision.nextValue.kind === 'bid' ? decision.nextValue.amount : 0;
        const bidBefore = decision.prevValue.kind === 'bid' ? decision.prevValue.amount : undefined;
        return {
          keywordExternalId: externalId,
          bid,
          ...(bidBefore === undefined ? {} : { bidBefore }),
        };
      }),
    });
  }

  const campaignExternalId = target.campaignExternalId;
  if (campaignExternalId) {
    for (const decision of budgets) {
      actions.push({
        ...base([decision]),
        kind: 'budget_change',
        campaignExternalId,
        campaignName: target.campaignName,
        before: decision.prevValue.kind === 'budget' ? decision.prevValue.amount : 0,
        after: decision.nextValue.kind === 'budget' ? decision.nextValue.amount : 0,
      });
    }

    const phrases = negatives.flatMap((decision) =>
      decision.nextValue.kind === 'negativeKeyword' ? [decision.nextValue.phrase] : [],
    );
    if (phrases.length > 0) {
      actions.push({
        ...base(negatives),
        kind: 'add_negatives',
        campaignExternalId,
        phrases,
      });
    }
  }

  return actions;
}
