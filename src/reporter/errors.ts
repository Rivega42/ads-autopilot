import type { Prisma } from '@prisma/client';

import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import type { ReporterDb } from '@/reporter/deps.js';

const log = logger.child({ scope: 'reporter:errors' });

/**
 * Коды отказа отчётности в `ErrorLog`.
 *
 * Их два, и разница между ними — разное действие человека. `REPORT_FAILED` —
 * отчёт не собрался: считать нечего или расчёт упал, и повтор без разбора
 * причины ничего не даст. `REPORT_DELIVERY_FAILED` — отчёт собран, лежит в БД и
 * не доехал до клиента: разбираться надо с каналом, а текст уйдёт сам следующим
 * прогоном.
 *
 * Набор объявлен здесь, рядом с записью, и отсюда же его читают тревоги.
 * Раньше он был продублирован в `alerts.ts`, и дубликат разъехался с
 * реальностью: `recordFailure` писала только `REPORT_FAILED`, а тревоги ждали
 * ещё и `REPORT_DELIVERY_FAILED`, которого не писал никто. Ветка выглядела
 * защитой, не будучи ею.
 */
export const REPORT_FAILURE_CODES = {
  /** Отчёт не собрался. */
  build: 'REPORT_FAILED',
  /** Отчёт собран, но не доставлен. */
  delivery: 'REPORT_DELIVERY_FAILED',
} as const;

export type ReportFailureCode = (typeof REPORT_FAILURE_CODES)[keyof typeof REPORT_FAILURE_CODES];

export const REPORT_FAILURE_CODE_VALUES: ReadonlySet<string> = new Set(
  Object.values(REPORT_FAILURE_CODES),
);

/** Отчёт посчитан и сохранён, но доставить его не удалось. */
export class ReportDeliveryError extends AppError {
  constructor(clientId: string, reportId: string, cause: unknown) {
    super(`Failed to deliver report ${reportId} for client ${clientId}`, {
      code: REPORT_FAILURE_CODES.delivery,
      retryable: true,
      context: { clientId, reportId },
      cause,
    });
  }
}

export interface ReportFailure {
  clientId: string | null;
  /** Что именно не получилось: `daily`, `weekly`, `alerts`. */
  stage: string;
  /** Собрался отчёт или не доехал — см. `REPORT_FAILURE_CODES`. */
  code: ReportFailureCode;
  message: string;
}

export function describeFailure(
  clientId: string | null,
  stage: string,
  err: unknown,
): ReportFailure {
  return { clientId, stage, code: failureCode(err), message: describeError(err) };
}

/**
 * Код отказа по самой ошибке.
 *
 * Ориентируемся на код `AppError`, а не на `instanceof`: ошибка доставки может
 * приехать и завёрнутой, а этап (`daily`/`weekly`) про причину не знает ничего —
 * дневной отчёт одинаково падает и на расчёте, и на отправке.
 */
function failureCode(err: unknown): ReportFailureCode {
  return err instanceof AppError && err.code === REPORT_FAILURE_CODES.delivery
    ? REPORT_FAILURE_CODES.delivery
    : REPORT_FAILURE_CODES.build;
}

/**
 * Отказ отчёта в `ErrorLog`.
 *
 * Пишем и здесь тоже, хотя это же место читают алерты: не отправленный отчёт —
 * такой же инцидент, как отвалившийся кабинет, и он обязан быть виден в общем
 * журнале, а не только в логах воркера. Само падение записи наружу не летит:
 * ронять из-за журнала прогон по остальным клиентам бессмысленно.
 */
export async function recordFailure(db: ReporterDb, failure: ReportFailure): Promise<void> {
  try {
    await db.errorLog.create({
      data: {
        clientId: failure.clientId,
        scope: `reporter:${failure.stage}`,
        code: failure.code,
        message: failure.message.slice(0, 2_000),
        context: { stage: failure.stage } satisfies Prisma.InputJsonObject,
      },
      select: { id: true },
    });
  } catch (err) {
    log.error({ err: describeError(err), failure }, 'failed to persist report failure');
  }
}
