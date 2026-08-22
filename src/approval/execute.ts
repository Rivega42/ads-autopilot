import type { ApprovalAction, ApprovalActionKind } from '@/approval/types.js';
import { getAdapter } from '@/channels/registry.js';
import type { ChannelContext, WriteResult } from '@/channels/types.js';
import { AppError } from '@/lib/errors.js';

/**
 * Исполнение одобренного действия.
 *
 * Создание кампании не выражается через `ChannelAdapter` — контракт его не
 * описывает, а лезть в контракт из approval-модуля нельзя. Поэтому здесь есть
 * точка расширения: эпик, который операцию реализует, регистрирует исполнителя
 * (`registerCampaignApprovalExecutor`), и `bootstrapChannels()` зовёт его рядом с
 * регистрацией адаптеров.
 *
 * `notSupported` остаётся не «на будущее», а на случай забытой регистрации: точка
 * входа, не позвавшая `bootstrapChannels()`, обязана уронить заявку в FAILED с
 * внятным текстом, а не сделать вид, что применила. Виды действий, у которых
 * исполнителя нет вовсе, в `approvalActionSchema` не объявляются — карточка,
 * падающая после нажатия ✅, хуже отсутствующей функции.
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
      return notSupported(action.kind);

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/**
 * Что записать в ChangeLog: до/после и адрес изменения.
 *
 * `entityId` не бывает пустым: у создаваемой кампании внешнего id ещё нет, и её
 * адресуют именем — колонка обязательная, а пустая строка в индексе бесполезна.
 */
export function changeSnapshot(action: ApprovalAction): {
  before: unknown;
  after: unknown;
  entityType: string;
  entityId: string;
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
        entityType: 'campaign',
        entityId: action.campaignName,
        campaignExternalId: null,
      };

    case 'budget_change':
      return {
        before: { dailyBudget: action.before },
        after: { dailyBudget: action.after },
        entityType: 'campaign',
        entityId: action.campaignExternalId,
        campaignExternalId: action.campaignExternalId,
      };

    case 'pause_entities':
      return {
        before: { status: 'ACTIVE', externalIds: action.externalIds },
        after: { status: 'PAUSED', externalIds: action.externalIds },
        entityType: action.level,
        entityId: action.externalIds[0] ?? action.level,
        campaignExternalId: null,
      };

    case 'resume_entities':
      return {
        before: { status: 'PAUSED', externalIds: action.externalIds },
        after: { status: 'ACTIVE', externalIds: action.externalIds },
        entityType: action.level,
        entityId: action.externalIds[0] ?? action.level,
        campaignExternalId: null,
      };

    case 'bid_change':
      return {
        before: action.changes.map((c) => ({
          keywordExternalId: c.keywordExternalId,
          bid: c.bidBefore ?? null,
        })),
        after: action.changes.map((c) => ({ keywordExternalId: c.keywordExternalId, bid: c.bid })),
        entityType: 'keyword',
        entityId: action.changes[0]?.keywordExternalId ?? 'keyword',
        campaignExternalId: null,
      };

    case 'add_negatives':
      return {
        before: { negatives: [] },
        after: { negatives: action.phrases },
        entityType: 'campaign',
        entityId: action.campaignExternalId,
        campaignExternalId: action.campaignExternalId,
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
