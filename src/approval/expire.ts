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
  /** Сколько зависших APPROVED-заявок нашла сверка и показала человеку. */
  stuck: number;
}

/**
 * Через сколько минут после ответа человека застрявшая заявка считается зависшей.
 *
 * Применение с ретраями площадки укладывается в ~2 минуты; всё, что висит APPROVED
 * заметно дольше, — это оборванный процесс, а не медленный.
 */
export const STUCK_APPROVAL_MINUTES = 15;

/** Маркер в `error`: про эту заявку в чат уже написали, второй раз не шумим. */
export const STUCK_NOTIFIED_PREFIX = 'stuck:notified ';

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

  // Сверку зовём отсюда: `expire-approvals` — единственный крон, который есть у
  // approval-модуля, а зависшая заявка так же «не доведена до конца», как просроченная.
  const stuck = await reconcileStuckApprovals(now);

  if (expired > 0 || raced > 0 || stuck > 0) {
    log.info({ expired, raced, stuck }, 'approvals expired');
  }
  return { expired, raced, stuck };
}

/**
 * Сверка зависших заявок.
 *
 * Между захватом (APPROVED) и применением может пройти до двух минут реальной работы
 * с площадкой. Перезапуск пода в этом окне оставляет строку APPROVED навсегда:
 * крон экспирации смотрит только PENDING, кнопки в карточке молчат «уже обработана»,
 * и никто не знает, ушли деньги или нет.
 *
 * Автоматически такие заявки НЕ применяются: неизвестно, успел ли пройти запрос в
 * кабинет, и повторное применение стоит денег клиента. Наше дело — показать их человеку.
 *
 * @returns сколько заявок показали в этом прогоне.
 */
export async function reconcileStuckApprovals(now: Date = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - STUCK_APPROVAL_MINUTES * 60_000);
  const candidates = await prisma.pendingApproval.findMany({
    where: {
      status: ApprovalStatus.APPROVED,
      respondedAt: { lte: threshold },
      // Явная ветка `error: null`: LIKE по NULL даёт NULL, и строка без ошибки
      // в условие `not startsWith` не попала бы.
      OR: [{ error: null }, { error: { not: { startsWith: STUCK_NOTIFIED_PREFIX } } }],
    },
    take: 100,
    orderBy: { respondedAt: 'asc' },
  });

  let notified = 0;
  for (const approval of candidates) {
    // Тем же условным UPDATE: два воркера не должны написать про одну заявку дважды.
    const res = await prisma.pendingApproval.updateMany({
      where: {
        id: approval.id,
        status: ApprovalStatus.APPROVED,
        OR: [{ error: null }, { error: { not: { startsWith: STUCK_NOTIFIED_PREFIX } } }],
      },
      data: {
        error: `${STUCK_NOTIFIED_PREFIX}${now.toISOString()} | было: ${approval.error ?? '—'}`,
      },
    });
    if (res.count === 0) continue;
    notified += 1;

    log.error(
      { approvalId: approval.id, respondedAt: approval.respondedAt, err: approval.error },
      'approval stuck in APPROVED, apply outcome unknown',
    );
    await notifyStuck(approval.chatId, approval.summary, approval.respondedBy);
  }
  return notified;
}

async function notifyStuck(
  chatId: string,
  summary: string,
  respondedBy: string | null,
): Promise<void> {
  const who = respondedBy ? ` (${respondedBy})` : '';
  const what = summary.split('\n')[1] || summary;
  try {
    await getMessenger().sendMessage(
      chatId,
      `⚠️ Заявка одобрена${who} более ${STUCK_APPROVAL_MINUTES} минут назад, ` +
        'но результат применения неизвестен: процесс прервался.\n' +
        `${what}\n` +
        'Автоматически ничего не повторяем — проверьте кабинет вручную.',
    );
  } catch (err) {
    log.warn({ chatId, err: describeError(err) }, 'cannot notify about stuck approval');
  }
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
