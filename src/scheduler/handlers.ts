import type { Job, Processor } from 'bullmq';

import { expireApprovals } from '@/approval/index.js';
import { refreshExpiringTokens, runIngestion, runSearchQueryIngestion } from '@/ingestion/index.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { QUEUE_NAMES, type QueueName } from '@/scheduler/queues.js';

const log = logger.child({ scope: 'scheduler' });

/**
 * Заглушка на время сборки: заменяется реализацией соответствующего эпика.
 * Логируем на warn, чтобы незакрытая задача была заметна в проде.
 */
function notImplemented(name: QueueName): Processor {
  return async (job: Job) => {
    log.warn({ queue: name, jobId: job.id }, 'handler not implemented yet');
    return { skipped: true, reason: 'not implemented' };
  };
}

/** Что вернул обработчик. Уезжает в Redis, поэтому обязано быть JSON-сериализуемым. */
export type HandlerResult = Record<string, unknown>;

const running = new Map<QueueName, number>();

/**
 * Оборачивает обработчик защитой от наложения и логированием длительности.
 *
 * Часовой сбор статистики по десятку кабинетов иногда не укладывается в час, и
 * BullMQ спокойно поставит следующий тик поверх текущего. Записи идемпотентны,
 * так что пересечение не испортит данные, но два прогона подряд удвоят расход
 * баллов API — поэтому второй вызов в том же процессе просто уходит.
 */
function exclusive(name: QueueName, run: () => Promise<HandlerResult>): Processor {
  return async (job: Job): Promise<HandlerResult> => {
    const startedAt = running.get(name);
    if (startedAt !== undefined) {
      log.warn(
        { queue: name, jobId: job.id, runningForMs: Date.now() - startedAt },
        'previous run is still in progress, skipping this tick',
      );
      return { skipped: true, reason: 'already running' };
    }

    running.set(name, Date.now());
    const began = Date.now();
    try {
      const result = await run();
      log.info({ queue: name, jobId: job.id, ms: Date.now() - began }, 'job finished');
      return result;
    } catch (err) {
      // Пробрасываем: BullMQ должен увидеть падение и отработать backoff.
      log.error(
        { queue: name, jobId: job.id, ms: Date.now() - began, err: describeError(err) },
        'job failed',
      );
      throw err;
    } finally {
      running.delete(name);
    }
  };
}

export const handlers: Record<QueueName, Processor> = {
  [QUEUE_NAMES.fetchStats]: exclusive(QUEUE_NAMES.fetchStats, async () => ({
    ...(await runIngestion()),
  })),
  [QUEUE_NAMES.checkModeration]: notImplemented(QUEUE_NAMES.checkModeration),
  [QUEUE_NAMES.optimizeBids]: notImplemented(QUEUE_NAMES.optimizeBids),
  [QUEUE_NAMES.pauseLosers]: notImplemented(QUEUE_NAMES.pauseLosers),
  [QUEUE_NAMES.wordstatMine]: exclusive(QUEUE_NAMES.wordstatMine, async () => ({
    ...(await runSearchQueryIngestion()),
  })),
  [QUEUE_NAMES.dailyReport]: notImplemented(QUEUE_NAMES.dailyReport),
  [QUEUE_NAMES.weeklyReport]: notImplemented(QUEUE_NAMES.weeklyReport),
  [QUEUE_NAMES.refreshTokens]: exclusive(QUEUE_NAMES.refreshTokens, async () => ({
    ...(await refreshExpiringTokens()),
  })),
  [QUEUE_NAMES.expireApprovals]: exclusive(QUEUE_NAMES.expireApprovals, async () => ({
    ...(await expireApprovals()),
  })),
};
