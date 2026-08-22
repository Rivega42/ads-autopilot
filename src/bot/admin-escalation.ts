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

/** Только `idempotencyKey`: остальная БД дедупликации не нужна, а тестам — не нужен весь клиент. */
export type EscalationStore = Pick<PrismaClient, 'idempotencyKey'>;

export interface EscalationDeps {
  db?: EscalationStore;
  now?: () => Date;
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
 * Захват права позвать человека.
 *
 * `true` — письмо надо отправить, `false` — по этому основанию человека уже позвали
 * и окно ещё не вышло.
 *
 * Гонка здесь настоящая: апдейты обрабатываются параллельно, и два сообщения клиента
 * могут прийти в один момент. Поэтому не «прочитать и решить», а условный
 * `updateMany` по истёкшей строке плюс `create` с уникальным ключом: атомарность
 * обеспечивает Postgres, выигрывает ровно один вызов.
 *
 * @param clientId - клиент, из-за которого зовут человека
 * @param reason - основание; одинаковое основание в течение окна даёт одно письмо
 * @returns true, если письмо по этому основанию сейчас нужно отправить
 */
export async function claimEscalation(
  clientId: string,
  reason: string,
  deps: EscalationDeps = {},
): Promise<boolean> {
  const db = deps.db ?? prisma;
  const now = (deps.now ?? ((): Date => new Date()))();
  const key = `${SCOPE}:${clientId}:${reason}`;
  const expiresAt = new Date(now.getTime() + ESCALATION_WINDOW_MS);

  try {
    // Строка могла остаться от прошлого раза: крон чистки ходит по расписанию, и
    // рассчитывать на то, что он уже добежал, нельзя — иначе окно станет вечным.
    const renewed = await db.idempotencyKey.updateMany({
      where: { key, expiresAt: { lte: now } },
      data: { expiresAt },
    });
    if (renewed.count > 0) return true;

    await db.idempotencyKey.create({
      data: { key, scope: SCOPE, entityType: 'Client', entityId: clientId, expiresAt },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    // Сбой хранилища не повод потерять эскалацию: лишнее письмо человек переживёт,
    // а непозванный человек означает клиента, о котором никто не узнает.
    log.error({ clientId, reason, err: describeError(err) }, 'escalation dedup failed');
    return true;
  }
}
