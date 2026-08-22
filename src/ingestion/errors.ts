import type { PrismaClient, Provider } from '@prisma/client';

import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'ingestion' });

/**
 * Отказ по одному клиенту или одному этапу. Форма намеренно плоская и
 * JSON-безопасная: результат обработчика уезжает в Redis, а `BigInt` из
 * `ErrorLog` там не сериализуется.
 */
export interface IngestionFailure {
  clientId: string;
  provider: Provider;
  /** Что именно упало: `entities`, `stats:campaign`, `metrika`, … */
  stage: string;
  code: string;
  message: string;
}

export function describeFailure(
  clientId: string,
  provider: Provider,
  stage: string,
  err: unknown,
): IngestionFailure {
  return {
    clientId,
    provider,
    stage,
    code: err instanceof AppError ? err.code : 'UNEXPECTED',
    message: describeError(err),
  };
}

/**
 * Пишет отказ в `ErrorLog`.
 *
 * Сама запись никогда не роняет прогон: если БД недоступна, потерять остаток
 * загрузки хуже, чем потерять строку в журнале — про неё останется лог.
 */
export async function recordFailure(db: PrismaClient, failure: IngestionFailure): Promise<void> {
  log.error(
    {
      clientId: failure.clientId,
      provider: failure.provider,
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
        scope: `ingestion:${failure.stage}`,
        code: failure.code,
        message: failure.message,
        context: { stage: failure.stage },
      },
    });
  } catch (err) {
    log.error({ err: describeError(err) }, 'cannot persist ingestion failure to ErrorLog');
  }
}
