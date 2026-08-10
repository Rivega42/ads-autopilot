import type { Job, Processor } from 'bullmq';

import { expireApprovals } from '@/approval/index.js';
import { env } from '@/env.js';
import { refreshExpiringTokens, runIngestion, runSearchQueryIngestion } from '@/ingestion/index.js';
import { runWeeklyKeywordRefresh } from '@/keywords/index.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { runModerationCheck } from '@/moderation/index.js';
import { runScheduledOptimization } from '@/optimizer/index.js';
import { runAlertScan, runDailyReports, runWeeklyReports } from '@/reporter/index.js';
import { QUEUE_NAMES, type QueueName } from '@/scheduler/queues.js';

const log = logger.child({ scope: 'scheduler' });

// Заглушки notImplemented больше нет намеренно: тип Record<QueueName, Processor>
// не даст добавить очередь без обработчика, и компилятор поймает это раньше
// любого теста. Прежняя заглушка позволяла новой очереди молча ничего не делать.

/** Что вернул обработчик. Уезжает в Redis, поэтому обязано быть JSON-сериализуемым. */
export type HandlerResult = Record<string, unknown>;

const running = new Map<string, number>();

/**
 * Ключ замка. optimize-bids и pause-losers исполняют одну и ту же работу по
 * разным расписаниям, поэтому им нужен общий ключ: с раздельными они
 * пересекались бы, и одно и то же изменение ставки применилось бы дважды.
 */
const LOCK_KEY: Partial<Record<QueueName, string>> = {
  [QUEUE_NAMES.optimizeBids]: 'optimization',
  [QUEUE_NAMES.pauseLosers]: 'optimization',
};

/**
 * Оборачивает обработчик защитой от наложения и логированием длительности.
 *
 * Часовой сбор статистики по десятку кабинетов иногда не укладывается в час, и
 * BullMQ спокойно поставит следующий тик поверх текущего. Записи идемпотентны,
 * так что пересечение не испортит данные, но два прогона подряд удвоят расход
 * баллов API — поэтому второй вызов в том же процессе просто уходит.
 */
function exclusive(name: QueueName, run: () => Promise<HandlerResult>): Processor {
  const lock = LOCK_KEY[name] ?? name;
  return async (job: Job): Promise<HandlerResult> => {
    const startedAt = running.get(lock);
    if (startedAt !== undefined) {
      log.warn(
        { queue: name, jobId: job.id, runningForMs: Date.now() - startedAt },
        'previous run is still in progress, skipping this tick',
      );
      return { skipped: true, reason: 'already running' };
    }

    running.set(lock, Date.now());
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
      running.delete(lock);
    }
  };
}

export const handlers: Record<QueueName, Processor> = {
  [QUEUE_NAMES.fetchStats]: exclusive(QUEUE_NAMES.fetchStats, async () => ({
    ...(await runIngestion()),
  })),
  [QUEUE_NAMES.checkModeration]: exclusive(QUEUE_NAMES.checkModeration, async () => ({
    ...(await runModerationCheck()),
  })),
  [QUEUE_NAMES.optimizeBids]: exclusive(QUEUE_NAMES.optimizeBids, async () => ({
    ...(await runScheduledOptimization({ dryRun: env.DRY_RUN })),
  })),
  // Отдельной ветки нет: пауза убыточных — одно из четырёх правил, и движок
  // сам решает, что применить. Разные расписания дают два прохода в сутки.
  [QUEUE_NAMES.pauseLosers]: exclusive(QUEUE_NAMES.pauseLosers, async () => ({
    ...(await runScheduledOptimization({ dryRun: env.DRY_RUN })),
  })),
  [QUEUE_NAMES.wordstatMine]: exclusive(QUEUE_NAMES.wordstatMine, async () => {
    // Сбор запросов обязан идти первым: пересбор ядра читает SearchQueryStat,
    // и на устаревших данных он предложит минус-слова по прошлой неделе.
    const queries = await runSearchQueryIngestion();
    const core = await runWeeklyKeywordRefresh();
    return { queries, core };
  }),
  [QUEUE_NAMES.dailyReport]: exclusive(QUEUE_NAMES.dailyReport, async () => ({
    ...(await runDailyReports()),
  })),
  [QUEUE_NAMES.weeklyReport]: exclusive(QUEUE_NAMES.weeklyReport, async () => ({
    ...(await runWeeklyReports()),
  })),
  [QUEUE_NAMES.refreshTokens]: exclusive(QUEUE_NAMES.refreshTokens, async () => ({
    ...(await refreshExpiringTokens()),
  })),
  [QUEUE_NAMES.expireApprovals]: exclusive(QUEUE_NAMES.expireApprovals, async () => ({
    ...(await expireApprovals()),
  })),
  [QUEUE_NAMES.alertScan]: exclusive(QUEUE_NAMES.alertScan, async () => ({
    ...(await runAlertScan()),
  })),
};
