import type { PendingApproval } from '@prisma/client';
import { prisma } from '@/db/prisma.js';
import { env } from '@/config/index.js';
import { AppError, describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { buildApprovalKeyboard, renderApprovalCard } from '@/approval/card.js';
import { matchApprovalRule } from '@/approval/policy.js';
import { getMessenger } from '@/approval/telegram.js';
import { parseAction, toJson, type ApprovalAction } from '@/approval/types.js';

const log = scoped('approval:create');

export interface CreateApprovalOptions {
  /** Куда слать. По умолчанию — `Client.approvalChatId`. */
  chatId?: string;
  /** Точка отсчёта TTL; параметр существует ради детерминированных тестов. */
  now?: Date;
  /** Отражается в карточке: клиент должен понимать, что нажатие ничего не открутит. */
  dryRun?: boolean;
}

/**
 * Создаёт заявку на апрув и кладёт карточку в Telegram.
 *
 * Порядок важен: сначала строка в БД, потом отправка. Если Telegram лежит,
 * заявка всё равно существует — её увидит дашборд и добьёт крон экспирации.
 * Обратный порядок означал бы карточку с кнопками, за которыми нет записи.
 */
export async function createApproval(
  input: ApprovalAction,
  opts: CreateApprovalOptions = {},
): Promise<PendingApproval> {
  const action = parseAction(input);
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + env.APPROVAL_TTL_MINUTES * 60_000);

  const client = await prisma.client.findUnique({
    where: { id: action.clientId },
    select: { name: true, approvalChatId: true },
  });
  if (!client) {
    throw new AppError(`Client ${action.clientId} not found`, {
      code: 'CLIENT_NOT_FOUND',
      context: { clientId: action.clientId },
    });
  }

  const chatId = opts.chatId ?? client.approvalChatId;
  const summary = renderApprovalCard({
    action,
    clientName: client.name,
    expiresAt,
    dryRun: opts.dryRun ?? false,
  });

  const approval = await prisma.pendingApproval.create({
    data: {
      clientId: action.clientId,
      action: action.kind,
      payload: toJson(action),
      summary,
      chatId,
      expiresAt,
    },
  });

  try {
    const sent = await getMessenger().sendMessage(
      chatId,
      summary,
      buildApprovalKeyboard(approval.id),
    );
    return await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { messageId: String(sent.messageId) },
    });
  } catch (err) {
    // Не пробрасываем: оптимизатор уже сделал свою работу, а недоставленная
    // карточка — проблема доставки. Она видна в `error` и в логе, заявка истечёт сама.
    const message = describeError(err);
    log.error({ approvalId: approval.id, chatId, err: message }, 'approval card not delivered');
    return prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { error: message },
    });
  }
}

/**
 * Точка входа для оптимизатора: сам решает по политике, звать человека или нет.
 * null — апрув не нужен, вызывающий применяет действие напрямую.
 */
export async function requestApprovalIfNeeded(
  input: ApprovalAction,
  opts: CreateApprovalOptions = {},
): Promise<PendingApproval | null> {
  const action = parseAction(input);
  if (!matchApprovalRule(action)) return null;
  return createApproval(action, opts);
}
