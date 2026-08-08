import type { PendingApproval } from '@prisma/client';

import { createApproval, type CreateApprovalOptions } from '@/approval/create.js';
import { registerActionExecutor } from '@/approval/execute.js';
import type { ApprovalAction } from '@/approval/types.js';
import { applyPlan, type ApplyPlanDeps, type CampaignApplyResult } from '@/campaigns/apply.js';
import { readPlanRef, type CampaignPlan } from '@/campaigns/plan.schema.js';
import type { ChannelContext, WriteResult } from '@/channels/types.js';
import { AppError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'campaigns:approval' });

/**
 * Создание кампании — действие из списка TZ §3.5: без человека оно не выполняется.
 *
 * Поэтому планировщик ничего не заливает сам. Он отдаёт план сюда, здесь на каждую
 * кампанию плана выпускается карточка `ApprovalKind.NEW_CAMPAIGN`, и только нажатие
 * «✅ Одобрить» доводит дело до `Campaigns.add`.
 *
 * Одна карточка на кампанию, а не одна на план: человек соглашается на конкретный
 * дневной бюджет конкретной кампании, и отказаться от РСЯ, оставив поиск, он должен
 * уметь одной кнопкой.
 */

/** Сколько символов предупреждений влезает в причину карточки, не ломая её чтение. */
const REASON_WARNINGS_LIMIT = 300;

export interface SubmitCampaignPlanOptions extends CreateApprovalOptions {
  /** Подменяется в тестах: настоящий создаёт строку в БД и шлёт сообщение в TG. */
  createApproval?: (
    action: ApprovalAction,
    opts?: CreateApprovalOptions,
  ) => Promise<PendingApproval>;
}

/**
 * Выпускает карточки апрува по плану.
 *
 * @param plan - сохранённый план (у несохранённого нет id, ссылаться не на что)
 * @returns созданные заявки в порядке кампаний плана
 */
export async function submitCampaignPlan(
  plan: CampaignPlan,
  opts: SubmitCampaignPlanOptions = {},
): Promise<PendingApproval[]> {
  const planId = plan.id;
  if (planId === null) {
    throw new AppError('Cannot submit an unsaved campaign plan for approval', {
      code: 'CAMPAIGN_PLAN_NOT_SAVED',
      context: { clientId: plan.clientId },
    });
  }

  const { createApproval: create = createApproval, ...approvalOpts } = opts;
  const approvals: PendingApproval[] = [];

  for (const [index, item] of plan.campaigns.entries()) {
    const action: ApprovalAction = {
      kind: 'create_campaign',
      clientId: plan.clientId,
      channel: item.channel,
      reason: buildReason(plan),
      campaignName: item.name,
      dailyBudget: item.dailyBudgetRub,
      // В карточку кладём ссылку, а не план: `renderDetails` показывает strategy
      // одним alert'ом Telegram, а он обрезается на 200 символах.
      strategy: { planId, campaignIndex: index, placement: item.placement },
    };
    approvals.push(await create(action, approvalOpts));
  }

  log.info({ planId, approvals: approvals.length }, 'campaign plan submitted for approval');
  return approvals;
}

function buildReason(plan: CampaignPlan): string {
  const head = plan.summary.trim() || 'План кампании собран AI-стратегом по брифу клиента';
  if (plan.warnings.length === 0) return head;
  const warnings = plan.warnings.join(' ').slice(0, REASON_WARNINGS_LIMIT);
  return `${head} ⚠️ ${warnings}`;
}

/**
 * Подключает создание кампаний к approval-модулю.
 *
 * До регистрации `executeAction` честно падает с «действие не поддерживается»
 * (см. src/approval/execute.ts). Зовётся из точки входа — бота, воркера, CLI —
 * рядом с `bootstrapChannels()`.
 */
export function registerCampaignApprovalExecutor(deps: ApplyPlanDeps = {}): void {
  registerActionExecutor('create_campaign', (ctx, action) =>
    executeCreateCampaign(ctx, action, deps),
  );
}

export async function executeCreateCampaign(
  ctx: ChannelContext,
  action: ApprovalAction,
  deps: ApplyPlanDeps = {},
): Promise<WriteResult<CampaignApplyResult>> {
  if (action.kind !== 'create_campaign') {
    throw new AppError(`executeCreateCampaign got action "${action.kind}"`, {
      code: 'ACTION_KIND_MISMATCH',
      context: { kind: action.kind },
    });
  }

  const ref = readPlanRef(action.strategy);
  if (!ref) {
    // Заявка выпущена не планировщиком (или старой версией кода). Создавать кампанию
    // «по одному имени и бюджету» нельзя: без групп, фраз и объявлений это пустышка,
    // которую потом никто не свяжет с планом.
    throw new AppError('Заявка на создание кампании не ссылается на план', {
      code: 'CAMPAIGN_PLAN_REF_MISSING',
      context: { campaignName: action.campaignName },
    });
  }

  const result = await applyPlan(ref.planId, {
    ...deps,
    campaignIndex: ref.campaignIndex,
    // Контекст уже собран approval-модулем вместе с режимом, обещанным карточкой.
    buildContext: () => Promise.resolve(ctx),
  });

  const outcome = result.campaigns[0];
  if (!outcome) {
    throw new AppError('Применение плана не вернуло результата по кампании', {
      code: 'CAMPAIGN_APPLY_EMPTY',
      context: { planId: ref.planId, campaignIndex: ref.campaignIndex },
    });
  }

  if (outcome.status === 'failed') {
    throw new AppError(outcome.note ?? 'Создание кампании не удалось', {
      code: 'CAMPAIGN_CREATE_FAILED',
      context: { planId: ref.planId, campaignIndex: ref.campaignIndex },
    });
  }

  return { applied: outcome.status === 'created', plan: outcome.plan, result: outcome };
}
