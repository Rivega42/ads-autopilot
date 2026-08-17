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
  try {
    await db.errorLog.create({
      data: {
        clientId: failure.clientId,
        provider: failure.provider,
        scope: `optimizer:${failure.stage}`,
        code: failure.code,
        message: failure.message,
        context: { stage: failure.stage, campaignId: failure.campaignId },
      },
    });
  } catch (err) {
    log.error({ err: describeError(err) }, 'cannot persist optimizer failure to ErrorLog');
  }
}
