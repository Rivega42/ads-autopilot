import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { createRedis } from '@/db/redis.js';
import { CRON_SCHEDULE, cronIntervalMinutes, type QueueName } from '@/scheduler/schedule.js';

// Реэкспорт: расписание живёт в модуле без зависимостей, но исторически его
// импортируют отсюда, и разводить два места импорта одного и того же ни к чему.
export { CRON_SCHEDULE, QUEUE_NAMES, type QueueName } from '@/scheduler/schedule.js';

/** Сколько суток истории прогонов держим в Redis. */
export const HISTORY_DAYS = 7;

/** Минимум записей у редких кронов: недельному отчёту семь штук — это семь недель. */
const MIN_RETAINED = 50;

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 200, age: HISTORY_DAYS * 24 * 3600 },
  removeOnFail: { count: 500 },
};

/**
 * Опции задач конкретной очереди: потолок хранения считается из её расписания.
 *
 * Общий `count: 200` объявлял намерение «держим неделю» (`age`), но исполнял его
 * только для редких кронов. У `alert-scan` и `expire-approvals` — 288 тиков в
 * сутки, и двести записей означали шестнадцать часов истории, а не неделю: любой
 * разбор «что происходило позавчера» упирался в подчищенные записи, и приёмка
 * §9.6 по трём суткам была по ним невыполнима в принципе. Считаем потолок из
 * периода крона, чтобы `age` и `count` говорили одно и то же.
 */
export function jobOptionsFor(name: QueueName): JobsOptions {
  const perDay = Math.ceil((24 * 60) / cronIntervalMinutes(CRON_SCHEDULE[name]));
  const count = Math.max(MIN_RETAINED, perDay * HISTORY_DAYS + 2);
  return { ...DEFAULT_JOB_OPTIONS, removeOnComplete: { count, age: HISTORY_DAYS * 24 * 3600 } };
}

const queues = new Map<QueueName, Queue>();
const connections = new Map<QueueName, Redis>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    const connection = createRedis();
    q = new Queue(name, { connection, defaultJobOptions: jobOptionsFor(name) });
    queues.set(name, q);
    connections.set(name, connection);
  }
  return q;
}

/**
 * Закрывает очереди вместе с их сокетами.
 *
 * `queue.close()` разрывает только те соединения, которые BullMQ завёл сам: у
 * переданного снаружи клиента ioredis он считает владельцем вызывающего и
 * оставляет его в состоянии `ready`. Демону это сходило с рук — воркер после
 * хуков зовёт `process.exit(0)`, — а разовой команде нет: она печатала вердикт
 * и не завершалась вовсе, потому что открытый сокет держит цикл событий.
 * Владелец здесь мы, значит и закрывать нам.
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await Promise.all([...connections.values()].map((c) => c.quit().catch(() => c.disconnect())));
  queues.clear();
  connections.clear();
}
