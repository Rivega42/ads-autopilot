import type { ChannelContext, WriteResult } from '@/channels/types.js';
import { getAdapter } from '@/channels/registry.js';
import { AppError } from '@/lib/errors.js';
import type { ApprovalAction, ApprovalActionKind } from '@/approval/types.js';

/**
 * Исполнение одобренного действия.
 *
 * Часть видов действий (создание кампании, смена стратегии, заливка креативов)
 * пока не выражается через `ChannelAdapter` — контракт их не описывает, а лезть
 * в него из approval-модуля нельзя. Поэтому здесь есть точка расширения:
 * эпики, которые эти операции реализуют, регистрируют исполнителя, а до тех пор
 * апрув честно падает в FAILED с внятным текстом вместо тихого «ничего не произошло».
 */

export type ActionExecutor = (ctx: ChannelContext, action: ApprovalAction) => Promise<WriteResult>;

const overrides = new Map<ApprovalActionKind, ActionExecutor>();

export function registerActionExecutor(kind: ApprovalActionKind, exec: ActionExecutor): void {
  overrides.set(kind, exec);
}

/** Только для тестов и перезагрузки модулей: снимает все регистрации. */
export function clearActionExecutors(): void {
  overrides.clear();
}

function notSupported(kind: ApprovalActionKind): never {
  throw new AppError(`Действие «${kind}» пока не поддерживается адаптером канала`, {
    code: 'ACTION_NOT_SUPPORTED',
    context: { kind },
  });
}

export async function executeAction(
  ctx: ChannelContext,
  action: ApprovalAction,
): Promise<WriteResult> {
  const override = overrides.get(action.kind);
  if (override) return override(ctx, action);

  // Адаптер достаём лениво: для незарегистрированных видов действий он не нужен,
  // и падать хочется с «действие не поддерживается», а не с «нет адаптера».
  const adapter = () => getAdapter(action.channel);

  switch (action.kind) {
    case 'budget_change':
      return adapter().setBudgets(ctx, [
        { campaignExternalId: action.campaignExternalId, dailyBudget: action.after },
      ]);

    case 'pause_entities':
      return adapter().pauseEntities(ctx, action.level, action.externalIds);

    case 'resume_entities':
      return adapter().resumeEntities(ctx, action.level, action.externalIds);

    case 'bid_change':
      return adapter().setBids(
        ctx,
        action.changes.map((c) => ({ keywordExternalId: c.keywordExternalId, bid: c.bid })),
      );

    case 'add_negatives': {
      const a = adapter();
      if (!a.addNegativeKeywords) {
        throw new AppError(`Канал ${action.channel} не умеет минус-слова`, {
          code: 'ACTION_NOT_SUPPORTED',
          context: { kind: action.kind, channel: action.channel },
        });
      }
      return a.addNegativeKeywords(ctx, action.campaignExternalId, action.phrases);
    }

    case 'create_campaign':
    case 'strategy_change':
    case 'upload_creatives':
      return notSupported(action.kind);

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Что записать в ChangeLog: до/после и адрес изменения. */
export function changeSnapshot(action: ApprovalAction): {
  before: unknown;
  after: unknown;
  targetType: string;
  targetId: string | null;
  campaignExternalId: string | null;
} {
  switch (action.kind) {
    case 'create_campaign':
      return {
        before: null,
        after: {
          name: action.campaignName,
          dailyBudget: action.dailyBudget,
          strategy: action.strategy,
        },
        targetType: 'campaign',
        targetId: null,
        campaignExternalId: null,
      };

    case 'budget_change':
      return {
        before: { dailyBudget: action.before },
        after: { dailyBudget: action.after },
        targetType: 'campaign',
        targetId: action.campaignExternalId,
        campaignExternalId: action.campaignExternalId,
      };

    case 'strategy_change':
      return {
        before: { strategy: action.before },
        after: { strategy: action.after },
        targetType: 'campaign',
        targetId: action.campaignExternalId,
        campaignExternalId: action.campaignExternalId,
      };

    case 'pause_entities':
      return {
        before: { status: 'ACTIVE', externalIds: action.externalIds },
        after: { status: 'PAUSED', externalIds: action.externalIds },
        targetType: action.level,
        targetId: action.externalIds[0] ?? null,
        campaignExternalId: null,
      };

    case 'resume_entities':
      return {
        before: { status: 'PAUSED', externalIds: action.externalIds },
        after: { status: 'ACTIVE', externalIds: action.externalIds },
        targetType: action.level,
        targetId: action.externalIds[0] ?? null,
        campaignExternalId: null,
      };

    case 'bid_change':
      return {
        before: action.changes.map((c) => ({
          keywordExternalId: c.keywordExternalId,
          bid: c.bidBefore ?? null,
        })),
        after: action.changes.map((c) => ({ keywordExternalId: c.keywordExternalId, bid: c.bid })),
        targetType: 'keyword',
        targetId: action.changes[0]?.keywordExternalId ?? null,
        campaignExternalId: null,
      };

    case 'add_negatives':
      return {
        before: { negatives: [] },
        after: { negatives: action.phrases },
        targetType: 'campaign',
        targetId: action.campaignExternalId,
        campaignExternalId: action.campaignExternalId,
      };

    case 'upload_creatives':
      return {
        before: null,
        after: { creativeIds: action.creativeIds, llmGenerated: action.llmGenerated },
        targetType: 'adgroup',
        targetId: action.adGroupExternalId,
        campaignExternalId: null,
      };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Имя операции в ChangeLog.action — совпадает с видом действия, строки не изобретаем. */
export function changeLogAction(action: ApprovalAction): string {
  return action.kind;
}
