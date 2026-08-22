import { ApprovalDecision, type PendingApproval } from '@prisma/client';
import type { Context } from 'grammy';

import { applyApproval, editCard } from '@/approval/apply.js';
import { decodeCallbackData, type ApprovalVerdict } from '@/approval/callback-data.js';
import { renderDetails } from '@/approval/card.js';
import { getMessenger } from '@/approval/telegram.js';
import { approvalActionSchema } from '@/approval/types.js';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'approval:callback' });

export type CallbackOutcomeKind =
  | 'applied'
  | 'apply_failed'
  | 'rejected'
  | 'details'
  | 'already_handled'
  | 'expired'
  | 'not_found'
  | 'forbidden'
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
  /** Кто нажал: `@username` либо telegram id — уходит в `PendingApproval.respondedBy`. */
  actor: string;
  /**
   * Чат, в котором нажали кнопку. Обязателен: Telegram сохраняет инлайн-клавиатуру
   * при пересылке сообщения, поэтому без сверки с `PendingApproval.chatId` карточку
   * может нажать кто угодно, кому её переслали. undefined — источник неизвестен,
   * такое нажатие отклоняем.
   */
  chatId: string | undefined;
  now?: Date;
}

/** Сообщение об отказе одно на все случаи: чужому не подсказываем, что заявка существует. */
const FORBIDDEN_ANSWER =
  'Эта карточка адресована другому чату — решение по ней можно принять только там.';

/**
 * Обработка нажатия кнопки.
 *
 * Ключевое место всего эпика — защита от двойного нажатия. Бот может работать
 * в нескольких процессах (и Telegram сам ретраит апдейты), поэтому «прочитать
 * решение → проверить → записать» гарантированно даст двойное применение под
 * гонкой. Вместо этого строка захватывается условным UPDATE ... WHERE
 * decision = PENDING: атомарность обеспечивает Postgres, выигрывает ровно один
 * вызов, остальные получают affected = 0 и вежливый отказ.
 *
 * Перед этим — проверка чата. Гонки здесь нет: `chatId` заявки неизменен, поэтому
 * обычное чтение достаточно, а захват по-прежнему остаётся атомарным.
 */
export async function processApprovalCallback(req: CallbackRequest): Promise<CallbackOutcome> {
  const parsed = decodeCallbackData(req.data);
  if (!parsed) return { kind: 'ignored', answer: 'Кнопка не распознана.', alert: false };

  const now = req.now ?? new Date();
  const { approvalId, verdict } = parsed;

  const approval = await prisma.pendingApproval.findUnique({ where: { id: approvalId } });
  if (!approval) {
    return { kind: 'not_found', answer: 'Заявка не найдена — возможно, она удалена.', alert: true };
  }
  if (!chatAllowed(approval.chatId, req.chatId)) {
    log.warn(
      { approvalId, actor: req.actor, from: req.chatId, expected: approval.chatId, verdict },
      'approval callback from foreign chat rejected',
    );
    return { kind: 'forbidden', answer: FORBIDDEN_ANSWER, alert: true };
  }

  if (verdict === 'details') return details(approval);

  const claimed = await claim(approvalId, verdict, req.actor, now);
  if (!claimed) return explainLostClaim(approvalId, now);

  if (verdict === 'reject') {
    await editCard(claimed, { kind: 'rejected', by: req.actor });
    log.info({ approvalId, actor: req.actor }, 'approval rejected');
    return { kind: 'rejected', answer: 'Отклонено. Изменение не применено.', alert: false };
  }

  const outcome = await applyApproval(approvalId, req.actor);
  if (outcome.status === 'APPLIED') {
    const head = outcome.dryRun
      ? 'Одобрено. Dry-run: в кабинет ничего не отправлено.'
      : outcome.noop
        ? 'Одобрено. Менять было нечего — в кабинете ничего не изменилось.'
        : 'Одобрено и применено.';
    return {
      kind: 'applied',
      // Предупреждение означает, что изменение выполнено, но что-то рядом не записалось;
      // молчать об этом нельзя — оператор должен пойти и проверить.
      answer: outcome.warning ? `${head} Внимание: ${outcome.warning}` : head,
      alert: outcome.warning !== undefined,
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
 * Нажатие засчитывается, только если пришло из того же чата, куда ушла карточка.
 * У заявки без записанного чата сверять не с чем — такую кнопку не принимаем.
 */
function chatAllowed(approvalChatId: string | null, from: string | undefined): boolean {
  if (from === undefined || approvalChatId === null) return false;
  return from.trim() === approvalChatId.trim();
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
  const decision = verdict === 'approve' ? ApprovalDecision.APPROVED : ApprovalDecision.REJECTED;
  const res = await prisma.pendingApproval.updateMany({
    where: { id: approvalId, decision: ApprovalDecision.PENDING, expiresAt: { gt: now } },
    data: { decision, decidedAt: now, respondedBy: actor },
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

  if (approval.decision === ApprovalDecision.PENDING && approval.expiresAt <= now) {
    // Срок истёк: помечаем сами, тем же условным UPDATE, и закрываем карточку.
    const res = await prisma.pendingApproval.updateMany({
      where: { id: approvalId, decision: ApprovalDecision.PENDING },
      data: { decision: ApprovalDecision.EXPIRED, decidedAt: now },
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
    answer: `Заявка уже обработана${by}: ${decisionRu(approval.decision)}.`,
    alert: false,
  };
}

function details(approval: PendingApproval): CallbackOutcome {
  const parsed = approvalActionSchema.safeParse(approval.payload);
  const body = parsed.success
    ? renderDetails(parsed.data)
    : 'Детали недоступны: payload повреждён.';
  return { kind: 'details', answer: body, alert: true };
}

function decisionRu(decision: ApprovalDecision): string {
  switch (decision) {
    case ApprovalDecision.PENDING:
      return 'ожидает решения';
    case ApprovalDecision.APPROVED:
      return 'одобрена';
    case ApprovalDecision.REJECTED:
      return 'отклонена';
    case ApprovalDecision.EXPIRED:
      return 'истекла';
    case ApprovalDecision.APPLYING:
      return 'применяется';
    case ApprovalDecision.APPLIED:
      return 'применена';
    case ApprovalDecision.FAILED:
      return 'применить не удалось';
    default: {
      const exhaustive: never = decision;
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
 * Сколько ждём результат, прежде чем ответить на callback_query «в процессе».
 *
 * callback_query живёт недолго: применение с ретраями площадки идёт до двух минут,
 * и к его концу `answerCallbackQuery` уже отвечает ошибкой — у человека остаются
 * вечные часики. Поэтому длинную операцию квитируем заранее, а итог он видит в карточке.
 */
export const ANSWER_DEADLINE_MS = 2_000;

const IN_PROGRESS_ANSWER = 'Принято, применяю. Итог появится в карточке.';

/**
 * Адаптер grammY. Отвечать на callback_query обязательно, иначе у клиента
 * бесконечно крутится индикатор загрузки — поэтому answer идёт даже на падении.
 */
export async function handleApprovalCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const queryId = ctx.callbackQuery?.id;
  if (!data || !queryId) return;

  let answered = false;
  let answerTask: Promise<void> = Promise.resolve();
  const answerOnce = (text: string, alert: boolean): void => {
    if (answered) return;
    answered = true;
    answerTask = getMessenger()
      .answerCallbackQuery(queryId, text, alert)
      .catch((err: unknown) => {
        log.warn({ err: describeError(err) }, 'cannot answer callback query');
      });
  };

  const timer = setTimeout(() => answerOnce(IN_PROGRESS_ANSWER, false), ANSWER_DEADLINE_MS);
  try {
    const outcome = await processApprovalCallback({
      data,
      actor: actorFrom(ctx),
      // Пересланная карточка приходит из другого чата — там нажатие не засчитается.
      chatId: ctx.chat?.id === undefined ? undefined : String(ctx.chat.id),
    });
    answerOnce(outcome.answer, outcome.alert);
  } catch (err) {
    log.error({ err: describeError(err), data }, 'approval callback crashed');
    answerOnce('Внутренняя ошибка, попробуйте позже.', true);
  } finally {
    clearTimeout(timer);
    await answerTask;
  }
}
