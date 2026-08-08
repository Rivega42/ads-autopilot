import type { Prisma } from '@prisma/client';

import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import type { ReporterDb } from '@/reporter/deps.js';

const log = logger.child({ scope: 'reporter:errors' });

export interface ReportFailure {
  clientId: string | null;
  /** Что именно не получилось: `daily`, `weekly`, `alerts`. */
  stage: string;
  message: string;
}

export function describeFailure(
  clientId: string | null,
  stage: string,
  err: unknown,
): ReportFailure {
  return { clientId, stage, message: describeError(err) };
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
        code: 'REPORT_FAILED',
        message: failure.message.slice(0, 2_000),
        context: { stage: failure.stage } satisfies Prisma.InputJsonObject,
      },
      select: { id: true },
    });
  } catch (err) {
    log.error({ err: describeError(err), failure }, 'failed to persist report failure');
  }
}

/** Отчёт посчитан и сохранён, но доставить его не удалось. */
export class ReportDeliveryError extends AppError {
  constructor(clientId: string, reportId: string, cause: unknown) {
    super(`Failed to deliver report ${reportId} for client ${clientId}`, {
      code: 'REPORT_DELIVERY_FAILED',
      retryable: true,
      context: { clientId, reportId },
      cause,
    });
  }
}
