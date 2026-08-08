import { Worker, type Processor } from 'bullmq';

import { MSK } from '@/constants.js';
import { prisma } from '@/db/prisma.js';
import { createRedis } from '@/db/redis.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { handlers } from '@/scheduler/handlers.js';
import {
  CRON_SCHEDULE,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  closeQueues,
  getQueue,
  type QueueName,
} from '@/scheduler/queues.js';
import { onShutdown } from '@/shutdown.js';

const log = logger.child({ scope: 'worker' });
const workers: Worker[] = [];

function startWorker(name: QueueName, processor: Processor): Worker {
  const worker = new Worker(name, processor, { connection: createRedis(), concurrency: 2 });
  worker.on('failed', (job, err) => {
    log.error({ queue: name, jobId: job?.id, err: describeError(err) }, 'job failed');
  });
  worker.on('completed', (job) => {
    log.info({ queue: name, jobId: job.id }, 'job completed');
  });
  workers.push(worker);
  return worker;
}

/**
 * upsertJobScheduler идемпотентен по идентификатору расписания, поэтому
 * перезапуск воркера не плодит дубли крон-задач. В BullMQ 6 опция repeat
 * у add() убрана — расписания живут только здесь.
 */
async function scheduleRepeatables(): Promise<void> {
  for (const name of Object.values(QUEUE_NAMES)) {
    const pattern = CRON_SCHEDULE[name];
    if (!pattern) continue;
    await getQueue(name).upsertJobScheduler(
      `cron:${name}`,
      { pattern, tz: MSK },
      { name, opts: DEFAULT_JOB_OPTIONS },
    );
    log.info({ queue: name, pattern, tz: MSK }, 'scheduled repeatable job');
  }
}

async function main(): Promise<void> {
  for (const name of Object.values(QUEUE_NAMES)) {
    startWorker(name, handlers[name]);
  }
  await scheduleRepeatables();

  onShutdown(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await prisma.$disconnect();
  });

  log.info({ queues: Object.values(QUEUE_NAMES) }, 'worker started');
}

main().catch((err) => {
  log.fatal({ err: describeError(err) }, 'worker failed to start');
  process.exit(1);
});
