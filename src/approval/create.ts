import type { PendingApproval } from '@prisma/client';

import { buildApprovalKeyboard, renderApprovalCard } from '@/approval/card.js';
import { matchApprovalRule } from '@/approval/policy.js';
import { assertActionExecutable } from '@/approval/supported.js';
import { getMessenger } from '@/approval/telegram.js';
import {
  approvalKindOf,
  buildApprovalPayload,
  parseAction,
  type ApprovalAction,
} from '@/approval/types.js';
import { prisma } from '@/db/prisma.js';
import { APPROVAL_TTL_MINUTES, env } from '@/env.js';
import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'approval:create' });

export interface CreateApprovalOptions {
  /** Куда слать. По умолчанию — личный чат клиента (`Client.tgUserId`). */
  chatId?: string;
  /** Точка отсчёта TTL; параметр существует ради детерминированных тестов. */
  now?: Date;
  /**
   * Только усиливает защиту: true включает dry-run для этой заявки, даже если
   * настройки его не требуют. Выключить dry-run через опцию нельзя — иначе карточка
   * пообещала бы человеку реальное изменение, которого настройки не допускают.
   */
  dryRun?: boolean;
}

/**
 * Эффективный dry-run заявки.
 *
 * Формула обязана совпадать с `buildContext` (src/channels/registry.ts): именно её
 * результат решает, уйдёт ли запись в кабинет. Считаем один раз здесь и кладём в
 * payload, потому что между карточкой и применением проходит до APPROVAL_TTL_MINUTES,
 * и флаги за это время могут измениться — а человек соглашался на текст карточки.
 */
function effectiveDryRun(opt: boolean | undefined): boolean {
  return env.DRY_RUN || opt === true;
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
  // До строки в БД и до сообщения в чат: пара «вид действия × канал» бывает
  // неисполнимой (VK не умеет минус-слов, Директ — паузы групп), и узнать об этом
  // человек обязан не после нажатия ✅, а вместо карточки.
  assertActionExecutable(action);
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MINUTES * 60_000);

  const client = await prisma.client.findUnique({
    where: { id: action.clientId },
    select: { name: true, tgUserId: true },
  });
  if (!client) {
    throw new AppError(`Client ${action.clientId} not found`, {
      code: 'CLIENT_NOT_FOUND',
      context: { clientId: action.clientId },
    });
  }

  const chatId = opts.chatId ?? String(client.tgUserId);
  const dryRun = effectiveDryRun(opts.dryRun);
  const summary = renderApprovalCard({
    action,
    clientName: client.name,
    expiresAt,
    dryRun,
  });

  const approval = await prisma.pendingApproval.create({
    data: {
      clientId: action.clientId,
      kind: approvalKindOf(action),
      // Вместе с действием сохраняем режим: применять будем ровно то, что обещала карточка.
      payload: buildApprovalPayload(action, { dryRun }),
      summary,
      chatId,
      expiresAt,
    },
  });

  let sent;
  try {
    sent = await getMessenger().sendMessage(chatId, summary, buildApprovalKeyboard(approval.id));
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

  // Дальше карточка с рабочими кнопками уже висит в чате. Отсюда нельзя ни бросить
  // исключение (вызывающий отправит вторую карточку на то же изменение), ни потерять
  // tgMessageId (без него итог не допишется в карточку).
  const tgMessageId = BigInt(sent.messageId);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await prisma.pendingApproval.update({
        where: { id: approval.id },
        data: { tgMessageId, error: null },
      });
    } catch (err) {
      log.error(
        { approvalId: approval.id, tgMessageId: sent.messageId, attempt, err: describeError(err) },
        'cannot persist approval tgMessageId',
      );
    }
  }

  // БД не приняла tgMessageId: заявка жива и нажимается, правка карточки по итогу
  // не сработает. Возвращаем строку с tgMessageId в памяти, чтобы вызывающий не
  // считал создание неудачным и не задублировал карточку.
  return { ...approval, tgMessageId };
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
  // Раньше политики: `null` здесь означает «применяй сам», и для неисполнимой пары
  // это отправило бы вызывающего прямо в отказ площадки.
  assertActionExecutable(action);
  if (!matchApprovalRule(action)) return null;
  return createApproval(action, opts);
}
