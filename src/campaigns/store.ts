import { CreativeKind, type PrismaClient } from '@prisma/client';

import { campaignPlanSchema, type CampaignPlan } from '@/campaigns/plan.schema.js';
import { AppError } from '@/lib/errors.js';

/**
 * Хранилище планов кампаний.
 *
 * Отдельной таблицы под план в схеме нет, а заводить её — breaking change, который
 * по CLAUDE.md §10 согласуется с человеком. План при этом обязан пережить рестарт:
 * между «покажи план» и «запускай» проходит человеческое время, а перегенерировать
 * его моделью нельзя — второй прогон даст другие тексты, и человек одобрит не то,
 * что увидел.
 *
 * Поэтому план живёт в `Creative`: это ровно строка «что сгенерировала модель, каким
 * промптом и за сколько денег». `provider` служит дискриминатором — по нему план
 * отличается от обычных креативов, и по нему же его можно найти.
 */

export const CAMPAIGN_PLAN_PROVIDER = 'campaign-plan';

/** Только то, что нужно плану: тестам не приходится собирать весь PrismaClient. */
export type PlanStore = Pick<PrismaClient, 'creative'>;

export class PlanNotFoundError extends AppError {
  constructor(planId: string) {
    super(`Campaign plan ${planId} not found`, {
      code: 'CAMPAIGN_PLAN_NOT_FOUND',
      context: { planId },
    });
  }
}

export class PlanCorruptedError extends AppError {
  constructor(planId: string, issues: string[]) {
    super(`Campaign plan ${planId} does not match its schema`, {
      code: 'CAMPAIGN_PLAN_CORRUPTED',
      context: { planId, issues },
    });
  }
}

export interface SavePlanOptions {
  costUsd?: number | null;
}

/**
 * Сохраняет план и возвращает его же с проставленным `id`.
 *
 * Строка неизменяемая: правка плана — это новый план с новым id, иначе одобренная
 * карточка апрува начала бы указывать на другое содержимое.
 */
export async function savePlan(
  db: PlanStore,
  plan: CampaignPlan,
  opts: SavePlanOptions = {},
): Promise<CampaignPlan> {
  const row = await db.creative.create({
    data: {
      clientId: plan.clientId,
      kind: CreativeKind.TEXT,
      provider: CAMPAIGN_PLAN_PROVIDER,
      // Версии промптов вместо текста запроса: по ним результат воспроизводится,
      // а сам текст уже лежит в AiRun.input, дублировать его здесь незачем.
      prompt: plan.prompts.join(', ') || 'campaign-plan',
      payload: JSON.parse(JSON.stringify({ ...plan, id: null })) as object,
      costUsd: opts.costUsd ?? null,
    },
    select: { id: true },
  });

  return { ...plan, id: row.id };
}

export async function loadPlan(db: PlanStore, planId: string): Promise<CampaignPlan> {
  const row = await db.creative.findUnique({
    where: { id: planId },
    select: { id: true, provider: true, payload: true },
  });

  if (!row || row.provider !== CAMPAIGN_PLAN_PROVIDER) throw new PlanNotFoundError(planId);

  const parsed = campaignPlanSchema.safeParse(row.payload);
  if (!parsed.success) {
    // План писали мы сами: несовпадение схемы означает, что код уехал вперёд данных.
    // Заливать в кабинет «примерно понятный» план нельзя.
    throw new PlanCorruptedError(
      planId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }

  return { ...parsed.data, id: row.id };
}
