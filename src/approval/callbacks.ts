import { ApprovalStatus, type PendingApproval } from '@prisma/client';
import type { Context } from 'grammy';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { applyApproval, editCard } from '@/approval/apply.js';
import { renderDetails } from '@/approval/card.js';
import { decodeCallbackData, type ApprovalVerdict } from '@/approval/callback-data.js';
import { getMessenger } from '@/approval/telegram.js';
import { approvalActionSchema } from '@/approval/types.js';

const log = scoped('approval:callback');

export type CallbackOutcomeKind =
  | 'applied'
  | 'apply_failed'
  | 'rejected'
  | 'details'
  | 'already_handled'
  | 'expired'
  | 'not_found'
  | 'ignored';

export interface CallbackOutcome {
  kind: CallbackOutcomeKind;
  /** Текст всплывашки для пользователя, всегда по-русски. */
  answer: string;
  /** Показать модалкой, а не тостом. */
  alert: boolean;
}

export interface CallbackRequest {
  /** Содержимое `callback_data` нажатой кнопки. */
  data: string;
  /** Кто нажал: `@username` либо telegram id — уходит в `ChangeLog.approvedBy`. */
  actor: string;
  now?: Date;
}

/**
 * Обработка нажатия кнопки.
 *
 * Ключевое место всего эпика — защита от двойного нажатия. Бот может работать
 * в нескольких процессах (и Telegram сам ретраит апдейты), поэтому «прочитать
 * статус → проверить → записать» гарантированно даст двойное применение под
 * гонкой. Вместо этого статус захватывается условным UPDATE ... WHERE
 * status = PENDING: атомарность обеспечивает Postgres, выигрывает ровно один
 * вызов, остальные получают affected = 0 и вежливый отказ.
 */
export async function processApprovalCallback(req: CallbackRequest): Promise<CallbackOutcome> {
  const parsed = decodeCallbackData(req.data);
  if (!parsed) return { kind: 'ignored', answer: 'Кнопка не распознана.', alert: false };

  const now = req.now ?? new Date();
  const { approvalId, verdict } = parsed;

  if (verdict === 'details') return details(approvalId);

  const claimed = await claim(approvalId, verdict, req.actor, now);
  if (!claimed) return explainLostClaim(approvalId, now);

  if (verdict === 'reject') {
    await editCard(claimed, { kind: 'rejected', by: req.actor });
    log.info({ approvalId, actor: req.actor }, 'approval rejected');
    return { kind: 'rejected', answer: 'Отклонено. Изменение не применено.', alert: false };
  }

  const outcome = await applyApproval(approvalId, req.actor);
  if (outcome.status === 'APPLIED') {
    return {
      kind: 'applied',
      answer: outcome.dryRun
        ? 'Одобрено. Dry-run: в кабинет ничего не отправлено.'
        : 'Одобрено и применено.',
      alert: false,
    };
  }
  if (outcome.status === 'FAILED') {
    return {
      kind: 'apply_failed',
      answer: `Одобрено, но применить не удалось: ${outcome.error}`,
      alert: true,
    };
  }
  return { kind: 'already_handled', answer: 'Заявка уже обработана.', alert: false };
}

/**
 * Атомарный захват заявки. Условие включает и срок жизни: истёкшая заявка
 * не должна применяться, даже если крон экспирации ещё не добежал.
 */
async function claim(
  approvalId: string,
  verdict: Exclude<ApprovalVerdict, 'details'>,
  actor: string,
  now: Date,
): Promise<PendingApproval | null> {
  const status = verdict === 'approve' ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
  const res = await prisma.pendingApproval.updateMany({
    where: { id: approvalId, status: ApprovalStatus.PENDING, expiresAt: { gt: now } },
    data: { status, respondedAt: now, respondedBy: actor },
  });
  if (res.count === 0) return null;
  return prisma.pendingApproval.findUnique({ where: { id: approvalId } });
}

/** Захват не удался — читаем строку только чтобы объяснить человеку причину. */
async function explainLostClaim(approvalId: string, now: Date): Promise<CallbackOutcome> {
  const approval = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
  if (!approval) {
    return { kind: 'not_found', answer: 'Заявка не найдена — возможно, она удалена.', alert: true };
  }

  if (approval.status === ApprovalStatus.PENDING && approval.expiresAt <= now) {
    // Срок истёк: помечаем сами, тем же условным UPDATE, и закрываем карточку.
    const res = await prisma.pendingApproval.updateMany({
      where: { id: approvalId, status: ApprovalStatus.PENDING },
      data: { status: ApprovalStatus.EXPIRED, respondedAt: now },
    });
    if (res.count > 0) await editCard(approval, { kind: 'expired' });
    return {
      kind: 'expired',
      answer: 'Срок ответа истёк, изменение не применено. Запросите новое решение оптимизатора.',
      alert: true,
    };
  }

  const by = approval.respondedBy ? ` (${approval.respondedBy})` : '';
  return {
    kind: 'already_handled',
    answer: `Заявка уже обработана${by}: ${statusRu(approval.status)}.`,
    alert: false,
  };
}

async function details(approvalId: string): Promise<CallbackOutcome> {
  const approval = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
  if (!approval) {
    return { kind: 'not_found', answer: 'Заявка не найдена.', alert: true };
  }
  const parsed = approvalActionSchema.safeParse(approval.payload);
  const body = parsed.success
    ? renderDetails(parsed.data)
    : 'Детали недоступны: payload повреждён.';
  return { kind: 'details', answer: body, alert: true };
}

function statusRu(status: ApprovalStatus): string {
  switch (status) {
    case ApprovalStatus.PENDING:
      return 'ожидает решения';
    case ApprovalStatus.APPROVED:
      return 'одобрена';
    case ApprovalStatus.REJECTED:
      return 'отклонена';
    case ApprovalStatus.EXPIRED:
      return 'истекла';
    case ApprovalStatus.APPLIED:
      return 'применена';
    case ApprovalStatus.FAILED:
      return 'применить не удалось';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Кто нажал: username предпочтительнее — он читаем в ChangeLog спустя месяцы. */
export function actorFrom(ctx: Context): string {
  const user = ctx.callbackQuery?.from ?? ctx.from;
  if (!user) return 'unknown';
  return user.username ? `@${user.username}` : String(user.id);
}

/**
 * Адаптер grammY. Отвечать на callback_query обязательно, иначе у клиента
 * бесконечно крутится индикатор загрузки — поэтому answer идёт даже на падении.
 */
export async function handleApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const queryId = ctx.callbackQuery?.id;
  if (!data || !queryId) return;

  let outcome: CallbackOutcome;
  try {
    outcome = await processApprovalCallback({ data, actor: actorFrom(ctx) });
  } catch (err) {
    log.error({ err: describeError(err), data }, 'approval callback crashed');
    outcome = { kind: 'apply_failed', answer: 'Внутренняя ошибка, попробуйте позже.', alert: true };
  }

  try {
    await getMessenger().answerCallbackQuery(queryId, outcome.answer, outcome.alert);
  } catch (err) {
    log.warn({ err: describeError(err) }, 'cannot answer callback query');
  }
}
