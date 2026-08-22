import { Queue, type JobsOptions } from 'bullmq';

import { createRedis } from '@/db/redis.js';
import type { QueueName } from '@/scheduler/schedule.js';

// Реэкспорт: расписание живёт в модуле без зависимостей, но исторически его
// импортируют отсюда, и разводить два места импорта одного и того же ни к чему.
export { CRON_SCHEDULE, QUEUE_NAMES, type QueueName } from '@/scheduler/schedule.js';
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
