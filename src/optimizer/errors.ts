import type { PrismaClient, Provider } from '@prisma/client';

import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'optimizer' });

/**
 * Отказ на одном этапе прогона оптимизатора.
 *
 * Форма повторяет `ingestion/errors.ts` и `moderation/errors.ts` намеренно:
 * алерт `error_burst` (TZ §3.6) считает строки `ErrorLog` без разбора источника,
 * и третья форма записи заставила бы его считать по-разному.
 */
export interface OptimizerFailure {
  clientId: string;
  provider: Provider;
  campaignId: string;
  /** Что именно упало: `run`, `apply`, `approval`. */
  stage: string;
  code: string;
  message: string;
}

/**
 * Карточка апрува создана, но Telegram её не принял.
 *
 * Отдельная экспортируемая константа, потому что читает её не оптимизатор:
 * `reporter/alerts.ts` поднимает по этому коду отдельную тревогу — до порога
 * всплеска одна карточка не дотягивает никогда, а больше её показать негде.
 */
export const APPROVAL_NOT_DELIVERED_CODE = 'APPROVAL_NOT_DELIVERED';

export function describeFailure(
  clientId: string,
  provider: Provider,
  campaignId: string,
  stage: string,
  err: unknown,
): OptimizerFailure {
  return {
    clientId,
    provider,
    campaignId,
    stage,
    code: err instanceof AppError ? err.code : 'UNEXPECTED',
    message: describeError(err),
  };
}

/**
 * Потолок строк `ErrorLog` на один вызов `recordFailures`.
 *
 * Свернуть одинаковые причины в одну строку нельзя: `error_burst` считает именно
 * строки, и свёртка погасила бы тревогу ровно в том случае, ради которого она
 * заведена, — когда площадка отвергает всё подряд. Поэтому строка на отказ, но с
 * потолком: предохранитель по доле сущностей разрешает трогать 30% кампании за
 * прогон, то есть у крупной кампании это тысячи решений, а чистки `ErrorLog` в
 * проекте нет вовсе — таблица растёт навсегда.
 *
 * Значение обязано быть строго больше `ERROR_BURST_THRESHOLD` (10) из
 * `reporter/alerts.ts`: тревога срабатывает на «больше порога», и потолок ниже
 * него означал бы, что массовый отказ одной кампании никого не будит. Инвариант
 * проверяется тестом — константы живут в разных модулях и разъезжаются молча.
 *
 * Чего этот инвариант не покрывает: он про тревогу самого флудящего клиента.
 * Тревога соседа от него не зависит вовсе и держится на другом — на том, что
 * скан считает агрегатом, а не выборкой строк (`reporter/alerts.ts`,
 * `groupErrors`). Сравнением констант это не проверяется: нужен прогон, и он
 * лежит в `alerts.test.ts` («флуд одного кабинета не крадёт тревогу у
 * соседнего») и в `tests/e2e/optimization-failures.e2e.ts`.
 */
export const FAILURE_ROWS_PER_BATCH_CAP = 25;

/**
 * Пишет отказ оптимизатора в `ErrorLog`.
 *
 * До этого падения на путях, которые тратят деньги клиента, оставались только в
 * логе процесса: алерт про всплеск ошибок читает `ErrorLog` и потому молчал, а
 * runbook в этом месте отправлял человека к пустой таблице.
 *
 * Сама запись никогда не роняет прогон: потерять остаток оптимизации хуже, чем
 * потерять строку в журнале — про неё останется лог.
 */
export async function recordFailure(db: PrismaClient, failure: OptimizerFailure): Promise<void> {
  await recordFailures(db, [failure]);
}

/**
 * Пачка отказов одного этапа одной кампании — одним запросом.
 *
 * Пообъектные отказы площадки приходят десятками: `create` на каждый означал бы
 * столько же round-trip'ов там, где кабинет уже лёг. Сверх потолка строки не
 * теряются, а схлопываются в одну — с числом и разбивкой по кодам, чтобы масштаб
 * остался виден человеку, а не только счётчику тревоги.
 */
export async function recordFailures(
  db: PrismaClient,
  failures: readonly OptimizerFailure[],
): Promise<void> {
  if (failures.length === 0) return;

  const kept = failures.slice(0, FAILURE_ROWS_PER_BATCH_CAP);
  const dropped = failures.slice(FAILURE_ROWS_PER_BATCH_CAP);

  for (const failure of kept) {
    log.error(
      {
        clientId: failure.clientId,
        provider: failure.provider,
        campaignId: failure.campaignId,
        stage: failure.stage,
        code: failure.code,
      },
      failure.message,
    );
  }

  const rows = kept.map((failure) => toRow(failure, failure.message));
  const overflow = dropped[0];
  if (overflow) {
    log.error(
      { clientId: overflow.clientId, campaignId: overflow.campaignId, dropped: dropped.length },
      'optimizer failure rows over the per-batch cap',
    );
    rows.push({
      ...toRow(overflow, `и ещё ${dropped.length} таких же отказов: ${countByCode(dropped)}`),
      code: 'TRUNCATED',
    });
  }

  try {
    await db.errorLog.createMany({ data: rows });
  } catch (err) {
    log.error({ err: describeError(err) }, 'cannot persist optimizer failure to ErrorLog');
  }
}

interface ErrorLogRow {
  clientId: string;
  provider: Provider;
  scope: string;
  code: string;
  message: string;
  context: { stage: string; campaignId: string };
}

function toRow(failure: OptimizerFailure, message: string): ErrorLogRow {
  return {
    clientId: failure.clientId,
    provider: failure.provider,
    scope: `optimizer:${failure.stage}`,
    code: failure.code,
    message,
    context: { stage: failure.stage, campaignId: failure.campaignId },
  };
}

function countByCode(failures: readonly OptimizerFailure[]): string {
  const counts = new Map<string, number>();
  for (const failure of failures) {
    counts.set(failure.code, (counts.get(failure.code) ?? 0) + 1);
  }
  return [...counts]
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => `${code}: ${count}`)
    .join(', ');
}
