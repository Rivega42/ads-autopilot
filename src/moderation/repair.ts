import { ChangeActor, ModerationStatus, type Prisma } from '@prisma/client';

import type { ChannelAdapter, ChannelContext } from '@/channels/types.js';
import { logger } from '@/logger.js';
import { classifyRejection } from '@/moderation/classify.js';
import type { ModerationDb, ModerationDeps } from '@/moderation/deps.js';
import type { EscalationCause, ModerationEscalation } from '@/moderation/escalate.js';
import type { ModerationTarget, RejectedAd } from '@/moderation/poll.js';
import { rewriteRejectedAd } from '@/moderation/rewrite.js';
import type { AdText, ClassifiedRejection } from '@/moderation/types.js';

const log = logger.child({ scope: 'moderation:repair' });

/**
 * Шаги 3–6 из TZ §13.4 для одного объявления: классифицировать, переписать,
 * отправить, а после трёх неудач — отдать человеку.
 */

/** Столько переписываний площадка получает, прежде чем задачу заберёт человек. */
export const MAX_MODERATION_RETRIES = 3;

export const REWRITE_ACTION = 'moderation_rewrite';
export const ESCALATION_ACTION = 'moderation_escalated';

export interface RepairContext {
  deps: ModerationDeps;
  target: ModerationTarget;
  ctx: ChannelContext;
  adapter: ChannelAdapter;
  client: { name: string; chatId: string };
}

export type RepairOutcome =
  | { status: 'rewritten'; retries: number; changes: string }
  | { status: 'planned'; plan: Record<string, unknown> }
  | { status: 'escalated'; cause: EscalationCause }
  | { status: 'skipped'; reason: string };

interface EscalationInput {
  cause: EscalationCause;
  classification: ClassifiedRejection | null;
  ad: AdText;
  problems: readonly string[];
}

function toJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  // Через JSON-раунд-трип: в объекте попадаются `undefined`, на которых Prisma падает.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

/**
 * Эскалация уже отправлена по этой попытке?
 *
 * Ключ дедупликации — счётчик попыток: он растёт внутри одного цикла отказов и
 * обнуляется, когда площадка объявление принимает. Так человек получает ровно одно
 * письмо на застрявшее объявление, а не по письму каждые полчаса, — и при этом
 * следующий цикл отказов снова достучится.
 */
async function alreadyEscalated(db: ModerationDb, adId: string, retries: number): Promise<boolean> {
  const rows = await db.changeLog.findMany({
    where: { entityType: 'AD', entityId: adId, action: ESCALATION_ACTION },
    select: { newValue: true },
    orderBy: { appliedAt: 'desc' },
    take: 5,
  });
  return rows.some((row) => {
    const value = row.newValue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return (value as Record<string, unknown>)['retries'] === retries;
  });
}

async function escalate(
  rc: RepairContext,
  ad: RejectedAd,
  input: EscalationInput,
): Promise<RepairOutcome> {
  const { deps, target } = rc;
  if (await alreadyEscalated(deps.db, ad.id, ad.retries)) {
    return { status: 'skipped', reason: 'already escalated' };
  }

  const escalation: ModerationEscalation = {
    clientId: target.clientId,
    clientName: rc.client.name,
    chatId: rc.client.chatId,
    channel: target.provider,
    campaignName: ad.campaignName,
    adId: ad.id,
    adExternalId: ad.externalId,
    retries: ad.retries,
    reason: ad.reason,
    classification: input.classification,
    ad: input.ad,
    problems: input.problems,
    cause: input.cause,
  };

  // Сначала доставка, потом запись: упавшая отправка обязана повториться в
  // следующем прогоне, а не остаться «уже эскалировано» с непрочитанным письмом.
  await deps.escalate(escalation);

  await deps.db.changeLog.create({
    data: {
      campaignId: ad.campaignId,
      entityType: 'AD',
      entityId: ad.id,
      action: ESCALATION_ACTION,
      prevValue: toJson({ ...input.ad, reason: ad.reason }),
      newValue: toJson({
        retries: ad.retries,
        cause: input.cause,
        category: input.classification?.category ?? null,
        problems: [...input.problems],
      }),
      reason: `Модерация: ${input.cause}`,
      actor: ChangeActor.AI,
      provider: target.provider,
    },
  });

  log.warn(
    { adId: ad.id, clientId: target.clientId, cause: input.cause, retries: ad.retries },
    'moderation escalated to human',
  );
  return { status: 'escalated', cause: input.cause };
}

export async function repairRejectedAd(rc: RepairContext, ad: RejectedAd): Promise<RepairOutcome> {
  const { deps, target, ctx, adapter } = rc;

  if (ad.retries >= MAX_MODERATION_RETRIES) {
    return escalate(rc, ad, {
      cause: 'retries_exhausted',
      classification: null,
      ad: ad.ad,
      problems: [`переписывали ${ad.retries} раза, площадка отклонила каждый вариант`],
    });
  }

  const updateAdText = adapter.updateAdText?.bind(adapter);
  if (!updateAdText) {
    // Переписывать текст, который потом некуда отправить, — это платный вызов модели
    // впустую. Поэтому проверка идёт до классификации.
    return escalate(rc, ad, {
      cause: 'channel_unsupported',
      classification: null,
      ad: ad.ad,
      problems: [`адаптер ${target.provider} не реализует updateAdText`],
    });
  }

  const classification = await classifyRejection(
    {
      clientId: target.clientId,
      channel: target.provider,
      reason: ad.reason,
      ad: ad.ad,
    },
    { run: deps.runClassify },
  );

  const rewrite = await rewriteRejectedAd(
    {
      clientId: target.clientId,
      channel: target.provider,
      reason: ad.reason,
      classification,
      ad: ad.ad,
      moderationAttempt: ad.retries,
    },
    { run: deps.runRewrite },
  );

  if (!rewrite.ok) {
    // Модель не смогла собрать вариант, проходящий проверки. Отправлять последний
    // черновик нельзя: он не прошёл ровно те же проверки, что и новое объявление.
    return escalate(rc, ad, {
      cause: 'rewrite_failed',
      classification,
      ad: ad.ad,
      problems: rewrite.problems,
    });
  }

  if (ctx.dryRun) {
    // Ни одной записи в БД: счётчик попыток тратится только на реальную отправку.
    const preview = await updateAdText(ctx, ad.externalId, rewrite.ad);
    log.info({ adId: ad.id, category: classification.category }, 'rewrite planned (dry run)');
    return { status: 'planned', plan: preview.plan };
  }

  // Заявка на объявление: перевод REJECTED → REWRITING со сверкой счётчика делает
  // захват атомарным. Два наложившихся прогона не отправят два разных текста —
  // второй увидит count = 0 и уйдёт.
  const claim = await deps.db.ad.updateMany({
    where: {
      id: ad.id,
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: ad.retries,
    },
    data: {
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: ad.retries + 1,
    },
  });
  if (claim.count === 0) return { status: 'skipped', reason: 'claimed by another run' };

  try {
    await updateAdText(ctx, ad.externalId, rewrite.ad);
  } catch (err) {
    // Статус возвращаем, счётчик — нет. У VK «обновление текста» это создание нового
    // баннера с удалением старого, и упасть оно может уже после создания: считать
    // такую попытку несостоявшейся значило бы отправить ещё один текст поверх.
    await deps.db.ad.updateMany({
      where: { id: ad.id, moderationStatus: ModerationStatus.REWRITING },
      data: { moderationStatus: ModerationStatus.REJECTED },
    });
    throw err;
  }

  await deps.db.ad.update({
    where: { id: ad.id },
    data: {
      title: rewrite.ad.title,
      body: rewrite.ad.text,
      moderationStatus: ModerationStatus.PENDING,
      moderationReason: null,
      llmVariant: `${classification.category}:${ad.retries + 1}`,
    },
  });

  await deps.db.changeLog.create({
    data: {
      campaignId: ad.campaignId,
      entityType: 'AD',
      entityId: ad.id,
      action: REWRITE_ACTION,
      prevValue: toJson({ ...ad.ad, reason: ad.reason }),
      newValue: toJson({
        ...rewrite.ad,
        category: classification.category,
        ruleIds: classification.rules.map((rule) => rule.id),
        retries: ad.retries + 1,
        prompts: [classification.promptVersion, rewrite.promptVersion],
      }),
      reason: rewrite.changes,
      actor: ChangeActor.AI,
      provider: target.provider,
    },
  });

  log.info(
    {
      adId: ad.id,
      clientId: target.clientId,
      category: classification.category,
      retries: ad.retries + 1,
      regenerated: rewrite.regenerated,
    },
    'rejected ad rewritten and resubmitted',
  );
  return { status: 'rewritten', retries: ad.retries + 1, changes: rewrite.changes };
}
