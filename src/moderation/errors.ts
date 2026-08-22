import type { Provider } from '@prisma/client';

import { AppError, describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import type { ModerationDb } from '@/moderation/deps.js';

const log = logger.child({ scope: 'moderation' });

/**
 * Отказ по одному кабинету или одному объявлению.
 *
 * Форма плоская и JSON-безопасная: сводка прогона уезжает в Redis как результат
 * задачи BullMQ, а `BigInt` из `ErrorLog` там не сериализуется.
 */
export interface ModerationFailure {
  clientId: string;
  provider: Provider;
  /** `poll`, `repair:<adId>`, `escalate:<adId>`. */
  stage: string;
  code: string;
  message: string;
}

export function describeFailure(
  clientId: string,
  provider: Provider,
  stage: string,
  err: unknown,
): ModerationFailure {
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
 * Сама запись прогон не роняет: потерять остаток обхода кабинетов хуже, чем
 * потерять строку в журнале — про неё останется лог и алерт.
 */
export async function recordFailure(db: ModerationDb, failure: ModerationFailure): Promise<void> {
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
        scope: `moderation:${failure.stage}`,
        code: failure.code,
        message: failure.message,
        context: { stage: failure.stage },
      },
    });
  } catch (err) {
    log.error({ err: describeError(err) }, 'cannot persist moderation failure to ErrorLog');
  }
}
