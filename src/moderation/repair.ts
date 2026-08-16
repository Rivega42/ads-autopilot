import { ChangeActor, ModerationStatus, type Prisma } from '@prisma/client';

import type { ChannelAdapter, ChannelContext } from '@/channels/types.js';
import { textVariantId } from '@/creatives/types.js';
import { describeError } from '@/lib/errors.js';
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
  /**
   * На каком значении счётчика объявление паркуется. По умолчанию — на потолке:
   * «отдали человеку» означает, что автоматика по этому объявлению закончила.
   */
  parkAt?: number;
}

function toJson(value: Record<string, unknown>): Prisma.InputJsonObject {
  // Через JSON-раунд-трип: в объекте попадаются `undefined`, на которых Prisma падает.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

/**
 * Эскалация уже отправлена по этому состоянию объявления?
 *
 * Ключ дедупликации — счётчик, на котором объявление запарковано (`parkedAt`), а не
 * число сделанных попыток: письмо «не смогли переписать» и следующее за ним «попытки
 * кончились» относятся к одному и тому же застрявшему объявлению, и человеку нужно
 * ровно одно из них. Счётчик обнуляется, когда площадка объявление принимает
 * (см. `pollAdModeration`), — следующий цикл отказов снова достучится.
 */
async function alreadyEscalated(db: ModerationDb, adId: string, parkedAt: number): Promise<boolean> {
  const rows = await db.changeLog.findMany({
    where: { entityType: 'AD', entityId: adId, action: ESCALATION_ACTION },
    select: { newValue: true },
    orderBy: { appliedAt: 'desc' },
    take: 5,
  });
  return rows.some((row) => {
    const value = row.newValue;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return (value as Record<string, unknown>)['parkedAt'] === parkedAt;
  });
}

/**
 * Отдаёт объявление человеку и паркует его.
 *
 * Парковка — это перевод счётчика попыток на потолок. Без неё объявление, которое
 * невозможно переписать, каждые полчаса заново оплачивало бы классификацию и три
 * переписывания: счётчик рос только на успешной отправке, а значит не рос никогда.
 * Цена парковки — потерянные остатки попыток, и это правильный размен: письмо человеку
 * уже ушло, и до его решения объявление всё равно остановлено.
 */
async function escalate(
  rc: RepairContext,
  ad: RejectedAd,
  input: EscalationInput,
): Promise<RepairOutcome> {
  const { deps, target } = rc;
  const parkedAt = Math.max(input.parkAt ?? MAX_MODERATION_RETRIES, ad.retries);
  if (await alreadyEscalated(deps.db, ad.id, parkedAt)) {
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
        parkedAt,
        cause: input.cause,
        category: input.classification?.category ?? null,
        problems: [...input.problems],
      }),
      reason: `Модерация: ${input.cause}`,
      actor: ChangeActor.AI,
      provider: target.provider,
    },
  });

  if (parkedAt > ad.retries) {
    // Сверка со счётчиком в условии: если параллельный прогон уже захватил строку,
    // парковать нечего — он сам решит судьбу этой попытки.
    await deps.db.ad.updateMany({
      where: {
        id: ad.id,
        moderationStatus: ModerationStatus.REJECTED,
        moderationRetries: ad.retries,
      },
      data: { moderationRetries: parkedAt },
    });
  }

  log.warn(
    { adId: ad.id, clientId: target.clientId, cause: input.cause, retries: ad.retries, parkedAt },
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
    // Единственный отказ, после которого объявление в кабинете может остаться
    // наполовину обновлённым, — человек обязан о нём узнать. Парковка здесь не нужна:
    // потрачена одна попытка, и следующий прогон имеет право попробовать ещё раз.
    try {
      await escalate(rc, ad, {
        cause: 'apply_failed',
        classification,
        ad: rewrite.ad,
        problems: [`отправка в кабинет ${target.provider} не удалась: ${describeError(err)}`],
        parkAt: ad.retries + 1,
      });
    } catch (escalationErr) {
      // Наверх обязана уйти исходная ошибка отправки: её ждёт ErrorLog прогона.
      log.error(
        { adId: ad.id, err: describeError(escalationErr) },
        'failed to escalate apply failure',
      );
    }
    throw err;
  }

  await deps.db.ad.update({
    where: { id: ad.id },
    data: {
      title: rewrite.ad.title,
      body: rewrite.ad.text,
      moderationStatus: ModerationStatus.PENDING,
      moderationReason: null,
      // `llmVariant` — отпечаток текста, по нему A/B-отчёт складывает статистику
      // (см. `creatives/ab/experiment.ts`). Переписывание меняет текст, значит это
      // новый вариант; категория отказа в это поле не помещается ни по смыслу, ни по
      // последствиям — два разных объявления с одной категорией слились бы в один ряд.
      llmVariant: textVariantId(rewrite.ad),
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
