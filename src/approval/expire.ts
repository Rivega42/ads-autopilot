import { ApprovalDecision, type PendingApproval } from '@prisma/client';

import { applyApproval, editCard, type ApplyOutcome } from '@/approval/apply.js';
import { describeAction } from '@/approval/card.js';
import { getMessenger } from '@/approval/telegram.js';
import { approvalActionSchema } from '@/approval/types.js';
import { prisma } from '@/db/prisma.js';
import { APPROVAL_TTL_MINUTES } from '@/env.js';
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
  /** Сколько одобренных, но так и не начатых заявок сверка довела до конца. */
  resumed: number;
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

/** От чьего имени доводится применение, если решавшего в строке почему-то нет. */
const RECONCILE_ACTOR = 'сверка зависших заявок';

export interface StuckApprovalsResult {
  /** Одобрено человеком, применение не начиналось — довели до конца этим прогоном. */
  resumed: number;
  /** Показали человеку, ничего не применяя: APPLYING и просроченные одобренные. */
  notified: number;
}

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
  const { notified: stuck, resumed } = await reconcileStuckApprovals(now);

  if (expired > 0 || raced > 0 || stuck > 0 || resumed > 0) {
    log.info({ expired, raced, stuck, resumed }, 'approvals expired');
  }
  return { expired, raced, stuck, resumed };
}

/**
 * Сверка зависших заявок: ни одна не имеет права остаться в этом состоянии навсегда.
 *
 * Состояния два, и разбираются они по-разному, потому что означают разное.
 *
 * APPLYING — «шлюз применения захвачен»: между захватом и итогом проходит до двух
 * минут реальной работы с площадкой, и перезапуск пода в этом окне оставляет строку
 * APPLYING навсегда. Повторять нельзя: неизвестно, успел ли запрос уйти в кабинет, а
 * от второго списания защищает не сверка, а ключ идемпотентности той операции. Поэтому
 * такую заявку только показываем человеку — разбирать её руками.
 *
 * APPROVED — «человек сказал да, применение ещё не начиналось»: деньги на месте,
 * в кабинете ничего не менялось, и повтор здесь не повтор, а первая попытка. Такую
 * заявку сверка доводит до конца сама. Раньше её так же только показывали, и это
 * была дыра: строка оставалась APPROVED вечно, а вход в создание кампании считает
 * живую заявку жёстким стопом — клиент нажимал «да» и получал «план ждёт твоего
 * решения» до скончания века. Автоприменения тут нет: человек уже решил, доводится
 * ровно его решение, а захват делает тот же условный UPDATE внутри `applyApproval`,
 * поэтому два воркера не применят одно дважды.
 */
export async function reconcileStuckApprovals(
  now: Date = new Date(),
): Promise<StuckApprovalsResult> {
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

  const result: StuckApprovalsResult = { resumed: 0, notified: 0 };
  for (const approval of candidates) {
    if (approval.decision === ApprovalDecision.APPROVED) {
      await finishApproved(approval, now, result);
      continue;
    }
    if (await markNotified(approval, now)) {
      result.notified += 1;
      log.error(
        { approvalId: approval.id, decision: approval.decision, decidedAt: approval.decidedAt },
        'approval stuck after decision, apply outcome unknown',
      );
      await notifyStuck(approval);
    }
  }
  return result;
}

/**
 * Помечает заявку как показанную. Тем же условным UPDATE: два воркера не должны
 * написать про одну заявку дважды.
 *
 * @returns true, если пометку поставили именно мы.
 */
async function markNotified(approval: PendingApproval, now: Date): Promise<boolean> {
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
  return res.count > 0;
}

/**
 * Сколько времени после решения одобренную заявку ещё можно довести.
 *
 * Не отдельное число: `APPROVAL_TTL_MINUTES` — это срок, на который система сама
 * назначила цифры карточки действительными («между карточкой и применением проходит
 * до APPROVAL_TTL_MINUTES», create.ts). Раз столько ждать до применения считалось
 * допустимым, столько же можно и доводить прерванное. Дальше payload уже ничем не
 * подтверждён: применять его — значит списать деньги по цене вчерашнего дня.
 */
function tooLateToResume(decidedAt: Date, now: Date): boolean {
  return now.getTime() - decidedAt.getTime() > APPROVAL_TTL_MINUTES * 60_000;
}

/**
 * Доводит до конца заявку, одобренную человеком, но так и не начатую.
 *
 * Не возвращает наружу ни одной ошибки: сверка идёт по списку, и упавшая заявка не
 * должна уносить с собой остальные. Не удалось — строка остаётся APPROVED и попадёт
 * в следующий прогон крона: доведение безопасно повторять, в отличие от APPLYING.
 */
async function finishApproved(
  approval: PendingApproval,
  now: Date,
  result: StuckApprovalsResult,
): Promise<void> {
  const decidedAt = approval.decidedAt ?? approval.createdAt;
  if (tooLateToResume(decidedAt, now)) {
    if (await abandonApproved(approval, now)) result.notified += 1;
    return;
  }

  let outcome: ApplyOutcome;
  try {
    outcome = await applyApproval(approval.id, approval.respondedBy ?? RECONCILE_ACTOR);
  } catch (err) {
    log.error(
      { approvalId: approval.id, err: describeError(err) },
      'cannot resume approved approval, will retry next run',
    );
    return;
  }

  if (outcome.status === 'SKIPPED') {
    // Строку забрал кто-то другой между выборкой и захватом — его и итог.
    log.info({ approvalId: approval.id, reason: outcome.reason }, 'resume skipped');
    return;
  }

  result.resumed += 1;
  log.warn(
    { approvalId: approval.id, decidedAt, status: outcome.status },
    'approved approval never started, finished by reconcile',
  );
  await notifyResumed(approval, outcome);
}

/**
 * Одобрено слишком давно: применять уже нельзя, но и живой заявку оставлять нельзя —
 * именно этим вход в создание кампании и был заблокирован. FAILED, а не EXPIRED:
 * решение человека было, не состоялось применение, и строка обязана говорить правду.
 *
 * @returns true, если закрыли её мы.
 */
async function abandonApproved(approval: PendingApproval, now: Date): Promise<boolean> {
  const error =
    `применение не начиналось дольше ${APPROVAL_TTL_MINUTES} мин после решения: ` +
    `цифры карточки больше не подтверждены, доведение отменено (${now.toISOString()})`;
  const res = await prisma.pendingApproval.updateMany({
    where: { id: approval.id, decision: ApprovalDecision.APPROVED },
    data: { decision: ApprovalDecision.FAILED, error },
  });
  if (res.count === 0) return false;

  log.error(
    { approvalId: approval.id, decidedAt: approval.decidedAt },
    'approved approval abandoned',
  );
  await editCard(approval, {
    kind: 'failed',
    by: approval.respondedBy ?? RECONCILE_ACTOR,
    error,
  });
  const who = approval.respondedBy ? ` (${approval.respondedBy})` : '';
  await send(
    approval.chatId,
    `⚠️ Заявка одобрена${who}, но применение так и не началось, а цифры в карточке ` +
      `действительны только ${APPROVAL_TTL_MINUTES} мин после решения.\n` +
      `${firstAction(approval.summary)}\n` +
      'Ничего не применяли — в кабинете всё как было. Нужно то же изменение — запусти заново.',
  );
  return true;
}

/** Исход, который уже что-то говорит о кабинете: SKIPPED сюда не доходит. */
type FinishedOutcome = Extract<ApplyOutcome, { status: 'APPLIED' | 'FAILED' }>;

/** Итог доведённого применения человеческими словами. */
function resumedOutcomeText(outcome: FinishedOutcome): string {
  if (outcome.status === 'FAILED') return `применить не удалось: ${outcome.error}`;
  if (outcome.dryRun) return 'dry-run, в кабинет ничего не отправлено';
  if (outcome.noop === true) return 'менять было нечего, в кабинете всё уже так';
  return 'изменение применено';
}

async function notifyResumed(approval: PendingApproval, outcome: FinishedOutcome): Promise<void> {
  const who = approval.respondedBy ? ` (${approval.respondedBy})` : '';
  const mark = outcome.status === 'FAILED' ? '⚠️' : '✅';
  await send(
    approval.chatId,
    `${mark} Заявка одобрена${who} более ${STUCK_APPROVAL_MINUTES} минут назад, ` +
      'но применение так и не началось: процесс прервался.\n' +
      `${firstAction(approval.summary)}\n` +
      `Довёл до конца сейчас — ${resumedOutcomeText(outcome)}.`,
  );
}

async function notifyStuck(approval: PendingApproval): Promise<void> {
  const who = approval.respondedBy ? ` (${approval.respondedBy})` : '';
  await send(
    approval.chatId,
    `⚠️ Заявка одобрена${who} более ${STUCK_APPROVAL_MINUTES} минут назад, ` +
      'но результат применения неизвестен: процесс прервался.\n' +
      `${firstAction(approval.summary)}\n` +
      'Автоматически ничего не повторяем — проверьте кабинет вручную.',
  );
}

/** Сообщение в чат заявки. Молчит, если чата нет, и не роняет сверку, если Telegram лежит. */
async function send(chatId: string | null, text: string): Promise<void> {
  if (chatId === null) return;
  try {
    await getMessenger().sendMessage(chatId, text);
  } catch (err) {
    log.warn({ chatId, err: describeError(err) }, 'cannot notify about stuck approval');
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
