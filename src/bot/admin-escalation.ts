import type { PrismaClient } from '@prisma/client';

import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'bot.escalation' });

/**
 * «Человека уже позвали»: защита от письма на каждое сообщение клиента.
 *
 * Интервью отвечает `needs_human` не один раз, а на каждое обращение в остановленный
 * бриф: клиент пишет «ладно», «а почему?», «спасибо», завтра снова набирает
 * `/onboarding` — и Роман получает пять одинаковых писем «Онбординг встал». Реальные
 * эскалации в таком потоке тонут, а это единственный канал, которым такой клиент
 * доходит до человека.
 *
 * Дедупликация живёт здесь, а не в памяти процесса: бот перезапускается и может
 * работать в нескольких экземплярах, а «уже позвали» обязано пережить и то, и другое.
 * Хранилище — `IdempotencyKey`: у него ровно та же семантика («это уже делали, вот до
 * какого момента») и уже есть крон, вычищающий истёкшее.
 */

const SCOPE = 'onboarding.escalation';

/**
 * Сколько молчим по одному и тому же основанию.
 *
 * Сутки — это «одно письмо на одну застрявшую ситуацию в день»: клиент, который
 * пишет в паузу десять раз за вечер, даёт одно письмо, а не десять; клиент, чей
 * бриф так и не разобрали за сутки, честно напомнит о себе ещё раз. Основание
 * поменялось (в брифе не хватает уже другого) — письмо уходит сразу, окно тут ни при чём.
 */
export const ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * `idempotencyKey` — дедупликация, `errorLog` — след несработавшего канала.
 *
 * Обе модели, и ни одной сверх: тестам не нужен весь клиент. `errorLog` появился
 * здесь потому, что Telegram — единственная дорога до человека, и когда она не
 * работает, о непозванном человеке не знает никто: тревоги Роману собираются
 * из `ErrorLog` (`reporter/alerts.ts`), а строку pino не читает никто и никогда.
 */
export type EscalationStore = Pick<PrismaClient, 'idempotencyKey' | 'errorLog'>;

export interface EscalationDeps {
  db?: EscalationStore;
  now?: () => Date;
}

/** Одно и то же основание — один и тот же ключ у захвата и у возврата. */
function escalationKey(clientId: string, reason: string): string {
  return `${SCOPE}:${clientId}:${reason}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Право позвать человека, взятое этим ходом.
 *
 * Не просто «да/нет»: отпускать захват обязан тот, кто его взял, и по строке,
 * которую он сам и записал. `heldUntil` — метка владельца: срок, который этот
 * захват проставил в `IdempotencyKey`. Он известен ещё до обращения к базе,
 * поэтому есть у захвата всегда — в том числе у fail-open, где ответа хранилища
 * не было и есть ли строка, неизвестно.
 */
export interface EscalationClaim {
  readonly clientId: string;
  readonly reason: string;
  /** Срок, который этот захват записал (или пытался записать) в строку. */
  readonly heldUntil: Date;
}

/**
 * Захват права позвать человека.
 *
 * Захват (`EscalationClaim`) — письмо надо отправить; `null` — по этому основанию
 * человека уже позвали и окно ещё не вышло.
 *
 * Гонка здесь настоящая: апдейты обрабатываются параллельно, и два сообщения клиента
 * могут прийти в один момент. Поэтому не «прочитать и решить», а условный
 * `updateMany` по истёкшей строке плюс `create` с уникальным ключом: атомарность
 * обеспечивает Postgres, выигрывает ровно один вызов.
 *
 * @param clientId - клиент, из-за которого зовут человека
 * @param reason - основание; одинаковое основание в течение окна даёт одно письмо
 * @returns захват, если письмо по этому основанию сейчас нужно отправить
 */
export async function claimEscalation(
  clientId: string,
  reason: string,
  deps: EscalationDeps = {},
): Promise<EscalationClaim | null> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? ((): Date => new Date()))();
  const key = escalationKey(clientId, reason);
  const expiresAt = new Date(now.getTime() + ESCALATION_WINDOW_MS);

  try {
    // Строка могла остаться от прошлого раза: крон чистки ходит по расписанию, и
    // рассчитывать на то, что он уже добежал, нельзя — иначе окно станет вечным.
    const renewed = await db.idempotencyKey.updateMany({
      where: { key, expiresAt: { lte: now } },
      data: { expiresAt },
    });
    if (renewed.count > 0) return { clientId, reason, heldUntil: expiresAt };

    await db.idempotencyKey.create({
      data: { key, scope: SCOPE, entityType: 'Client', entityId: clientId, expiresAt },
    });
    return { clientId, reason, heldUntil: expiresAt };
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    // Сбой хранилища не повод потерять эскалацию: лишнее письмо человек переживёт,
    // а непозванный человек означает клиента, о котором никто не узнает. Срок в
    // захвате тот же самый: упавший вызов не говорит, что строки нет, — INSERT мог
    // закоммититься, а ответ не доехать, и тогда отпускать её придётся именно по нему.
    log.error({ clientId, reason, err: describeError(err) }, 'escalation dedup failed');
    return { clientId, reason, heldUntil: expiresAt };
  }
}

/**
 * Возврат права позвать человека.
 *
 * Захват берётся до отправки — иначе два сообщения клиента, пришедшие
 * одновременно, дадут человеку два одинаковых письма. Значит и отпускать его
 * обязан тот, у кого письмо не ушло: строка живёт сутки, и оставленная после
 * недоставленного письма она гасит все следующие поводы по этому клиенту. Роман
 * не получает ничего, а клиенту в тот же миг сказано «дальше подключится человек».
 *
 * Отпускается ровно своя строка, а не всё, что лежит под ключом: удаление по ключу
 * снесло бы живой захват соседнего хода, и Роман получил бы второе письмо о той же
 * ситуации. Своя строка узнаётся по сроку, который этот захват в неё и записал.
 *
 * Захват со сбоем хранилища (fail-open) отпускается наравне с остальными. Раньше он
 * выходил отсюда сразу — на том основании, что строки за ним нет. Основания не было:
 * упавший вызов означает «клиент бросил», а не «не записалось», и `INSERT` мог
 * закоммититься, потеряв по дороге ответ. Такая строка живёт сутки и гасит все
 * следующие поводы по клиенту, которому только что пообещали человека, — то есть
 * размен получался «лишнее письмо Роману» на «сутки тишины по клиенту», и не в ту
 * сторону. Остаточный риск честнее: если соседний захват попал ровно в ту же
 * миллисекунду, fail-open снимет его строку и человек получит второе письмо.
 *
 * `deleteMany`, а не `delete`: строки может не быть (её унесла чистка, её удалил
 * параллельный ход, её и правда не записалось), и отсутствие — не ошибка. Сбой
 * самого удаления проглатываем по той же причине, что и сбой захвата: ход клиента
 * ронять нельзя, ему уже ответили.
 */
export async function releaseEscalation(
  claim: EscalationClaim,
  deps: EscalationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  try {
    await db.idempotencyKey.deleteMany({
      where: { key: escalationKey(claim.clientId, claim.reason), expiresAt: claim.heldUntil },
    });
  } catch (err) {
    log.error(
      { clientId: claim.clientId, reason: claim.reason, err: describeError(err) },
      'cannot release escalation claim',
    );
  }
}

/** Scope записи в `ErrorLog`: по нему эскалации видно среди прочих отказов. */
export const ESCALATION_SCOPE = 'bot:onboarding-escalation';

export interface EscalationFailure {
  clientId: string;
  /** Основание, по которому звали человека, — оно же в ключе дедупликации. */
  reason: string;
  code: 'ESCALATION_UNDELIVERED' | 'ESCALATION_NO_ADMIN_CHAT';
  message: string;
}

/**
 * След несработавшего канала.
 *
 * Пишется в `ErrorLog`, потому что это единственное место, которое видно без
 * Telegram: и дашборд, и тревоги читают его. Клиенту в этот момент уже обещан
 * человек — и если письмо не ушло, а строки нет, то человека не позовёт ничто:
 * повтор случится, только если клиент напишет ещё раз, а ему только что сказали,
 * что писать больше не нужно.
 *
 * Сама запись ход не роняет: клиенту ответ уже отправлен.
 */
export async function recordEscalationFailure(
  failure: EscalationFailure,
  deps: EscalationDeps = {},
): Promise<void> {
  const db = deps.db ?? prisma;
  try {
    await db.errorLog.create({
      data: {
        clientId: failure.clientId,
        scope: ESCALATION_SCOPE,
        code: failure.code,
        message: failure.message,
        context: { reason: failure.reason },
      },
    });
  } catch (err) {
    log.error(
      { clientId: failure.clientId, err: describeError(err) },
      'cannot persist escalation failure to ErrorLog',
    );
  }
}
