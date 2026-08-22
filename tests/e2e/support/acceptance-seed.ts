import { Queue, Worker } from 'bullmq';

import { dayBounds } from '@/acceptance/cycle.js';
import { CYCLE_QUEUES, expectedRunsPerDay } from '@/acceptance/spec.js';
import { prisma } from '@/db/prisma.js';
import { createRedis } from '@/db/redis.js';
import { getQueue, type QueueName } from '@/scheduler/queues.js';

/**
 * Подкладка улик для сценария приёмки §9.6.
 *
 * История прогонов пишется настоящими задачами BullMQ, а не подделкой ключей в
 * Redis: проверка читает `returnvalue`, `timestamp` и состояние задачи, то есть
 * ровно те поля, которые расставляет сам BullMQ. Подделай мы их руками — сценарий
 * проверял бы согласованность нашей же выдумки.
 */

/** Момент внутри суток `date`, `slot`-й по счёту из `total`. */
function slotAt(date: string, slot: number, total: number): number {
  const { dayStart } = dayBounds(date);
  const step = (24 * 60 * 60 * 1000) / Math.max(total, 1);
  return dayStart.getTime() + Math.floor(step * slot) + 1_000;
}

export interface SeedRunsOptions {
  /** Сколько тиков положить. По умолчанию — сколько обязано быть по расписанию. */
  count?: number;
  /** Что вернёт обработчик. `null` — задача обязана упасть. */
  result?: Record<string, unknown> | null;
  /** Причина падения, если `result` = null. */
  failWith?: string;
}

/**
 * Прогоняет через настоящую очередь `count` задач с проставленными задним числом
 * временными метками и ждёт, пока все они закончатся.
 */
export async function seedRuns(
  name: QueueName,
  date: string,
  options: SeedRunsOptions = {},
): Promise<void> {
  const count = options.count ?? expectedRunsPerDay(name);
  if (count === 0) return;
  const result = options.result === undefined ? {} : options.result;

  const queue = new Queue(name, { connection: createRedis() });
  const worker = new Worker(
    name,
    async () => {
      if (result === null) throw new Error(options.failWith ?? 'сценарий: отказ площадки');
      return result;
    },
    { connection: createRedis(), concurrency: 16 },
  );

  try {
    let finished = 0;
    const done = new Promise<void>((resolve) => {
      const tick = (): void => {
        finished += 1;
        if (finished >= count) resolve();
      };
      worker.on('completed', tick);
      worker.on('failed', tick);
    });

    for (let i = 0; i < count; i += 1) {
      await queue.add(
        name,
        {},
        // `attempts: 1` — сценарию нужен ровно один исход на задачу, а не три
        // попытки с экспоненциальной паузой между ними.
        {
          timestamp: slotAt(date, i, count),
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    }
    await done;
  } finally {
    await worker.close();
    await queue.close();
  }
}

/** Чистит истории всех суточных очередей вместе с их расписаниями. */
export async function obliterateCycleQueues(): Promise<void> {
  for (const name of CYCLE_QUEUES) {
    const queue = new Queue(name, { connection: createRedis() });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
}

/** Регистрирует расписание так же, как это делает воркер на старте. */
export async function registerSchedules(names: readonly QueueName[]): Promise<void> {
  for (const name of names) {
    await getQueue(name).upsertJobScheduler(`cron:${name}`, { pattern: '0 4 * * *' }, { name });
  }
}

export interface AcceptanceFixture {
  clientId: string;
  campaignId: string;
}

/** Минимально живая база: активный клиент с доступами и одна активная кампания. */
export async function seedLiveBase(): Promise<AcceptanceFixture> {
  const client = await prisma.client.create({
    data: { tgUserId: BigInt(880001), name: 'Стенд приёмки', status: 'ACTIVE' },
  });
  await prisma.credential.create({
    data: {
      clientId: client.id,
      provider: 'YANDEX_DIRECT',
      encryptedPayload: Buffer.from('x'),
      iv: Buffer.from('y'),
      tag: Buffer.from('z'),
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      clientId: client.id,
      externalId: '990001',
      provider: 'YANDEX_DIRECT',
      name: 'Поиск — приёмка',
      status: 'ACTIVE',
      dailyBudget: 1000,
    },
  });
  return { clientId: client.id, campaignId: campaign.id };
}

/** Дневной отчёт с отметкой доставки внутри проверяемых суток. */
export async function seedDeliveredReport(clientId: string, date: string): Promise<void> {
  const { dayStart } = dayBounds(date);
  await prisma.report.create({
    data: {
      clientId,
      kind: 'DAILY',
      periodFrom: new Date(`${date}T00:00:00.000Z`),
      periodTo: new Date(`${date}T00:00:00.000Z`),
      body: 'отчёт сценария',
      sentAt: new Date(dayStart.getTime() + 11 * 60 * 60 * 1000),
    },
  });
}

/**
 * Запуск `pnpm acceptance` настоящим процессом.
 *
 * Импортом нельзя: `src/apps/acceptance.ts` — точка входа, она начинает работу
 * прямо на импорте. А проверять надо именно процесс: код возврата — это половина
 * ответа, и в сценарии, где вердикт читает crontab, единственная.
 */
export async function runAcceptance(args: readonly string[]): Promise<{
  stdout: string;
  code: number;
}> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const run = promisify(execFile);
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY, E2E_REDIS_URL } = await import('./config.js');

  const childEnv = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    REDIS_URL: E2E_REDIS_URL,
    CREDENTIALS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  };

  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/apps/acceptance.ts', ...args],
      { cwd: repoRoot, env: childEnv },
    );
    return { stdout, code: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? '', code: failure.code ?? 1 };
  }
}
