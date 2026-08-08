import { Queue, type JobsOptions } from 'bullmq';
import { createRedis } from '@/db/redis.js';

/** Имена очередей = имена задач из TZ §3.4. Держим в одном месте, чтобы не расходились строки. */
export const QUEUE_NAMES = {
  fetchStats: 'fetch-stats-hourly',
  checkModeration: 'check-moderation',
  optimizeBids: 'optimize-bids',
  pauseLosers: 'pause-losers',
  wordstatMine: 'wordstat-mine',
  dailyReport: 'daily-report',
  weeklyReport: 'weekly-report',
  refreshTokens: 'refresh-tokens',
  expireApprovals: 'expire-approvals',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Крон в МСК. BullMQ понимает tz, поэтому серверное время не важно.
 * Расписание — из TZ §3.4.
 */
export const CRON_SCHEDULE: Record<QueueName, string | null> = {
  [QUEUE_NAMES.fetchStats]: '0 * * * *',
  [QUEUE_NAMES.checkModeration]: '*/30 * * * *',
  [QUEUE_NAMES.optimizeBids]: '0 8 * * *',
  [QUEUE_NAMES.pauseLosers]: '0 3 * * *',
  [QUEUE_NAMES.wordstatMine]: '0 4 */3 * *',
  [QUEUE_NAMES.dailyReport]: '30 8 * * *',
  [QUEUE_NAMES.weeklyReport]: '0 10 * * 1',
  [QUEUE_NAMES.refreshTokens]: '0 */4 * * *',
  [QUEUE_NAMES.expireApprovals]: '*/5 * * * *',
};

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 200, age: 7 * 24 * 3600 },
  removeOnFail: { count: 500 },
};

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: createRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}
