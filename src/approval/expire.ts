import { ApprovalStatus } from '@prisma/client';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { editCard } from '@/approval/apply.js';
import { describeAction } from '@/approval/card.js';
import { getMessenger } from '@/approval/telegram.js';
import { approvalActionSchema } from '@/approval/types.js';

const log = scoped('approval:expire');

export interface ExpireResult {
  /** Сколько заявок реально перешло в EXPIRED этим вызовом. */
  expired: number;
  /** Сколько было отобрано, но захвачено кем-то другим (ответ пришёл в ту же секунду). */
  raced: number;
}

/**
 * Гасит просроченные заявки и сообщает об этом в чат (TZ §5, Milestone 5).
 *
 * Вешается на крон `expire-approvals`. Переход делается тем же условным UPDATE,
 * что и в обработчике кнопок: человек может нажать «Одобрить» ровно в момент
 * прогона крона, и выиграть должен ровно один из них.
 */
export async function expireApprovals(now: Date = new Date()): Promise<ExpireResult> {
  const overdue = await prisma.pendingApproval.findMany({
    where: { status: ApprovalStatus.PENDING, expiresAt: { lte: now } },
    // Ограничение на всякий случай: если бот молчал сутки, не заваливаем чат за один тик.
    take: 100,
    orderBy: { expiresAt: 'asc' },
  });

  let expired = 0;
  let raced = 0;

  for (const approval of overdue) {
    const res = await prisma.pendingApproval.updateMany({
      where: { id: approval.id, status: ApprovalStatus.PENDING },
      data: { status: ApprovalStatus.EXPIRED, respondedAt: now },
    });
    if (res.count === 0) {
      raced += 1;
      continue;
    }
    expired += 1;

    await editCard(approval, { kind: 'expired' });
    await notifyExpired(approval.chatId, approval.payload, approval.summary);
  }

  if (expired > 0 || raced > 0) {
    log.info({ expired, raced }, 'approvals expired');
  }
  return { expired, raced };
}

/**
 * Отдельное сообщение помимо правки карточки: отредактированное сообщение
 * висит выше по истории и в занятом чате его никто не заметит.
 */
async function notifyExpired(chatId: string, payload: unknown, summary: string): Promise<void> {
  const parsed = approvalActionSchema.safeParse(payload);
  const what = parsed.success ? describeAction(parsed.data) : summary.split('\n')[1] || summary;
  try {
    await getMessenger().sendMessage(
      chatId,
      `⏳ Истёк срок апрува, изменение не применено.\n${what}`,
    );
  } catch (err) {
    log.warn({ chatId, err: describeError(err) }, 'cannot notify about expired approval');
  }
}
