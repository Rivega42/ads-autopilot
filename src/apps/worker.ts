import { Worker, type Processor } from 'bullmq';
import { createRedis } from '@/db/redis.js';
import { logger } from '@/lib/logger.js';
import { describeError } from '@/lib/errors.js';
import { onShutdown } from '@/lib/shutdown.js';
import { disconnectPrisma } from '@/db/prisma.js';
import {
  CRON_SCHEDULE,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  closeQueues,
  getQueue,
  type QueueName,
} from '@/scheduler/queues.js';
import { MSK } from '@/config/index.js';
import { handlers } from '@/scheduler/handlers.js';

const workers: Worker[] = [];

function startWorker(name: QueueName, processor: Processor): Worker {
  const worker = new Worker(name, processor, { connection: createRedis(), concurrency: 2 });
  worker.on('failed', (job, err) => {
    logger.error({ queue: name, jobId: job?.id, err: describeError(err) }, 'job failed');
  });
  worker.on('completed', (job) => {
    logger.info({ queue: name, jobId: job.id }, 'job completed');
  });
  workers.push(worker);
  return worker;
}

/** Регистрирует повторяющиеся задачи. BullMQ дедуплицирует их по имени, повторный запуск безопасен. */
async function scheduleRepeatables(): Promise<void> {
  for (const name of Object.values(QUEUE_NAMES)) {
    const pattern = CRON_SCHEDULE[name];
    if (!pattern) continue;
    await getQueue(name).add(
      name,
      {},
      { ...DEFAULT_JOB_OPTIONS, repeat: { pattern, tz: MSK }, jobId: `cron:${name}` },
    );
    logger.info({ queue: name, pattern, tz: MSK }, 'scheduled repeatable job');
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
    await disconnectPrisma();
  });

  logger.info({ queues: Object.values(QUEUE_NAMES) }, 'worker started');
}

main().catch((err) => {
  logger.fatal({ err: describeError(err) }, 'worker failed to start');
  process.exit(1);
});
