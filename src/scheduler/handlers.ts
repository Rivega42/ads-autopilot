import type { Job, Processor } from 'bullmq';
import { QUEUE_NAMES, type QueueName } from '@/scheduler/queues.js';
import { scoped } from '@/lib/logger.js';

const log = scoped('scheduler');

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

export const handlers: Record<QueueName, Processor> = {
  [QUEUE_NAMES.fetchStats]: notImplemented(QUEUE_NAMES.fetchStats),
  [QUEUE_NAMES.checkModeration]: notImplemented(QUEUE_NAMES.checkModeration),
  [QUEUE_NAMES.optimizeBids]: notImplemented(QUEUE_NAMES.optimizeBids),
  [QUEUE_NAMES.pauseLosers]: notImplemented(QUEUE_NAMES.pauseLosers),
  [QUEUE_NAMES.wordstatMine]: notImplemented(QUEUE_NAMES.wordstatMine),
  [QUEUE_NAMES.dailyReport]: notImplemented(QUEUE_NAMES.dailyReport),
  [QUEUE_NAMES.weeklyReport]: notImplemented(QUEUE_NAMES.weeklyReport),
  [QUEUE_NAMES.refreshTokens]: notImplemented(QUEUE_NAMES.refreshTokens),
  [QUEUE_NAMES.expireApprovals]: notImplemented(QUEUE_NAMES.expireApprovals),
};
