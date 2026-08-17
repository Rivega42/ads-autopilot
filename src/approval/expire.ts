import { ApprovalDecision, type PendingApproval } from '@prisma/client';

import { editCard } from '@/approval/apply.js';
import { describeAction } from '@/approval/card.js';
import { getMessenger } from '@/approval/telegram.js';
import { approvalActionSchema } from '@/approval/types.js';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'approval:expire' });

export interface ExpireResult {
  /** Сколько заявок реально перешло в EXPIRED этим вызовом. */
  expired: number;
  /** Сколько было отобрано, но захвачено кем-то другим (ответ пришёл в ту же секунду). */
  raced: number;
  /** Сколько зависших после решения человека заявок нашла сверка и показала человеку. */
  stuck: number;
}

/**
 * Через сколько минут после ответа человека застрявшая заявка считается зависшей.
 *
 * Применение с ретраями площадки укладывается в ~2 минуты; всё, что висит без
 * итога заметно дольше, — это оборванный процесс, а не медленный.
 */
export const STUCK_APPROVAL_MINUTES = 15;

/** Маркер в `error`: про эту заявку в чат уже написали, второй раз не шумим. */
export const STUCK_NOTIFIED_PREFIX = 'stuck:notified ';

/** Решения, из которых заявка сама уже не выберется: применение оборвалось. */
const STUCK_DECISIONS = [ApprovalDecision.APPLYING, ApprovalDecision.APPROVED];

export type ExpiredApprovalHandler = (approval: PendingApproval) => Promise<void>;

const expiredHandlers = new Map<string, ExpiredApprovalHandler>();

/**
 * Что сделать с заявкой, когда её срок истёк.
 *
 * Нужно тем, кто перед созданием карточки занимает ключ идемпотентности: истёкшая
 * карточка означает, что решения не было и его надо предложить снова, а занятый ключ
 * заставляет систему молчать. Approval-модуль про чужие ключи ничего не знает и знать
 * не должен — поэтому не вызов конкретного модуля, а точка подписки; подписчиков
 * связывает планировщик (`scheduler/handlers.ts`), там же живёт и сам крон.
 *
 * Ключ — имя подписчика: регистрация повторяется при каждом импорте модуля, и
 * одноимённый обработчик обязан заменять прежний, а не добавляться к нему.
 */
export function registerExpiredApprovalHandler(
  name: string,
  handler: ExpiredApprovalHandler,
): void {
  expiredHandlers.set(name, handler);
}

/**
 * Обработчики истёкшей заявки.
 *
 * Падение одного не отменяет ни остальных, ни саму экспирацию: заявка уже переведена в
 * EXPIRED, и оставить её без уведомления человека из-за недоступной БД было бы хуже.
 */
async function runExpiredHandlers(approval: PendingApproval): Promise<void> {
  for (const [name, handler] of expiredHandlers) {
    try {
      await handler(approval);
    } catch (err) {
      log.error(
        { approvalId: approval.id, handler: name, err: describeError(err) },
        'expired approval handler failed',
      );
    }
  }
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
    where: { decision: ApprovalDecision.PENDING, expiresAt: { lte: now } },
    // Ограничение на всякий случай: если бот молчал сутки, не заваливаем чат за один тик.
    take: 100,
    orderBy: { expiresAt: 'asc' },
  });

  let expired = 0;
  let raced = 0;

  for (const approval of overdue) {
    const res = await prisma.pendingApproval.updateMany({
      where: { id: approval.id, decision: ApprovalDecision.PENDING },
      data: { decision: ApprovalDecision.EXPIRED, decidedAt: now },
    });
    if (res.count === 0) {
      raced += 1;
      continue;
    }
    expired += 1;

    await runExpiredHandlers(approval);
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
 * APPLYING означает «шлюз применения захвачен»: между захватом и итогом проходит до
 * двух минут реальной работы с площадкой, и перезапуск пода в этом окне оставляет
 * строку APPLYING навсегда. Крон экспирации смотрит только PENDING, кнопки в карточке
 * молчат «уже обработана», и никто не знает, ушли деньги или нет.
 *
 * Задержавшийся APPROVED — история спокойнее: применение не начиналось, деньги точно
 * на месте. Но и оно само не сдвинется, поэтому показываем обе, разным текстом.
 *
 * Автоматически такие заявки НЕ применяются: для APPLYING неизвестно, успел ли пройти
 * запрос в кабинет, а повторное применение стоит денег клиента.
 *
 * @returns сколько заявок показали в этом прогоне.
 */
export async function reconcileStuckApprovals(now: Date = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() - STUCK_APPROVAL_MINUTES * 60_000);
  const candidates = await prisma.pendingApproval.findMany({
    where: {
      decision: { in: STUCK_DECISIONS },
      decidedAt: { lte: threshold },
      // Явная ветка `error: null`: LIKE по NULL даёт NULL, и строка без ошибки
      // в условие `not startsWith` не попала бы.
      OR: [{ error: null }, { error: { not: { startsWith: STUCK_NOTIFIED_PREFIX } } }],
    },
    take: 100,
    orderBy: { decidedAt: 'asc' },
  });

  let notified = 0;
  for (const approval of candidates) {
    // Тем же условным UPDATE: два воркера не должны написать про одну заявку дважды.
    const res = await prisma.pendingApproval.updateMany({
      where: {
        id: approval.id,
        decision: approval.decision,
        OR: [{ error: null }, { error: { not: { startsWith: STUCK_NOTIFIED_PREFIX } } }],
      },
      data: {
        error: `${STUCK_NOTIFIED_PREFIX}${now.toISOString()} | было: ${approval.error ?? '—'}`,
      },
    });
    if (res.count === 0) continue;
    notified += 1;

    log.error(
      { approvalId: approval.id, decision: approval.decision, decidedAt: approval.decidedAt },
      'approval stuck after decision, apply outcome unknown',
    );
    await notifyStuck(approval);
  }
  return notified;
}

async function notifyStuck(approval: PendingApproval): Promise<void> {
  if (approval.chatId === null) return;
  const who = approval.respondedBy ? ` (${approval.respondedBy})` : '';
  const what = firstAction(approval.summary);
  const body =
    approval.decision === ApprovalDecision.APPLYING
      ? 'но результат применения неизвестен: процесс прервался.\n' +
        `${what}\n` +
        'Автоматически ничего не повторяем — проверьте кабинет вручную.'
      : 'но применение так и не началось: процесс прервался до записи в кабинет.\n' +
        `${what}\n` +
        'В кабинете ничего не менялось — дождитесь новой рекомендации оптимизатора.';
  try {
    await getMessenger().sendMessage(
      approval.chatId,
      `⚠️ Заявка одобрена${who} более ${STUCK_APPROVAL_MINUTES} минут назад, ${body}`,
    );
  } catch (err) {
    log.warn({ chatId: approval.chatId, err: describeError(err) }, 'cannot notify about stuck');
  }
}

/**
 * Отдельное сообщение помимо правки карточки: отредактированное сообщение
 * висит выше по истории и в занятом чате его никто не заметит.
 */
async function notifyExpired(
  chatId: string | null,
  payload: unknown,
  summary: string | null,
): Promise<void> {
  if (chatId === null) return;
  const parsed = approvalActionSchema.safeParse(payload);
  const what = parsed.success ? describeAction(parsed.data) : firstAction(summary);
  try {
    await getMessenger().sendMessage(
      chatId,
      `⏳ Истёк срок апрува, изменение не применено.\n${what}`,
    );
  } catch (err) {
    log.warn({ chatId, err: describeError(err) }, 'cannot notify about expired approval');
  }
}

/** Строка «Действие: …» из карточки — единственное, что стоит цитировать в алерте. */
function firstAction(summary: string | null): string {
  if (!summary) return 'детали заявки недоступны';
  return summary.split('\n')[1] || summary;
}
