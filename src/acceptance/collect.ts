import { ApprovalDecision, ChangeActor, ReportKind } from '@prisma/client';
import type { Job } from 'bullmq';

import {
  dayBounds,
  whenMsk,
  type CronRun,
  type CycleEvidence,
  type DbEvidence,
  type QueueHistory,
} from '@/acceptance/cycle.js';
import { CYCLE_QUEUES, expectedRunsPerDay } from '@/acceptance/spec.js';
import { prisma } from '@/db/prisma.js';
import { closeQueues, getQueue } from '@/scheduler/queues.js';
import type { QueueName } from '@/scheduler/schedule.js';

/**
 * Снятие улик за сутки: история очередей из Redis и следы в Postgres.
 *
 * Улики берутся из двух источников намеренно. История BullMQ отвечает на вопрос
 * «крон отработал», и только она: ни одна таблица не заполняется от самого факта
 * прогона — обработчик, которому нечего делать, не пишет ничего. Postgres
 * отвечает на другой вопрос — «работа оставила след»; сверять их друг с другом
 * и есть смысл проверки.
 */

/** Клиент БД: ровно те модели, которые читает сбор. */
export type AcceptanceDb = Pick<
  typeof prisma,
  | 'client'
  | 'credential'
  | 'campaign'
  | 'errorLog'
  | 'auditLog'
  | 'changeLog'
  | 'pendingApproval'
  | 'report'
>;

export interface CollectOptions {
  /** Сутки по МСК, `yyyy-MM-dd`, по возрастанию. */
  dates: readonly string[];
  db?: AcceptanceDb;
  queues?: readonly QueueName[];
  /** Сколько строк ErrorLog показать человеку. Остальные только считаются. */
  errorSampleSize?: number;
}

export async function collectCycleEvidence(options: CollectOptions): Promise<CycleEvidence[]> {
  const db = options.db ?? prisma;
  const queues = options.queues ?? CYCLE_QUEUES;
  const dates = [...options.dates].sort();
  const first = dates[0];
  if (first === undefined) return [];

  const windowStart = dayBounds(first).dayStart;
  const histories = new Map<QueueName, QueueHistory>();
  for (const name of queues) {
    histories.set(name, await readQueueHistory(name, windowStart, dates.length));
  }

  const evidence: CycleEvidence[] = [];
  for (const date of dates) {
    const { dayStart, dayEnd } = dayBounds(date);
    evidence.push({
      date,
      dayStart,
      dayEnd,
      queues: queues.map((name) => sliceDay(histories.get(name), name, dayStart, dayEnd)),
      db: await readDbEvidence(db, dayStart, dayEnd, options.errorSampleSize ?? 3),
    });
  }
  return evidence;
}

/** Закрыть соединения, открытые сбором. Отдельно — чтобы вызвать один раз в конце. */
export async function closeCycleConnections(): Promise<void> {
  await closeQueues();
}

/**
 * История очереди из Redis.
 *
 * Глубина выборки считается из расписания: у крона раз в пять минут за трое суток
 * набегает 864 записи, и фиксированное «последние двести» отрезало бы первые
 * двое суток окна молча. Запас в один день сверх окна нужен, чтобы было видно,
 * достаёт ли история до его начала: без этого «прогонов не было» и «записи
 * подчистили» неразличимы, а это разные вердикты.
 */
async function readQueueHistory(
  name: QueueName,
  windowStart: Date,
  days: number,
): Promise<QueueHistory> {
  const limit = expectedRunsPerDay(name) * (days + 1) + 50;
  const queue = getQueue(name);

  const [completed, failed, schedulers] = await Promise.all([
    queue.getCompleted(0, limit - 1),
    queue.getFailed(0, limit - 1),
    queue.getJobSchedulers(),
  ]);

  const runs = [
    ...completed.map((job) => toRun(name, job, 'completed')),
    ...failed.map((job) => toRun(name, job, 'failed')),
  ].sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());

  const oldest = runs[0]?.enqueuedAt ?? null;
  return {
    queue: name,
    scheduled: schedulers.some((s) => s.key === `cron:${name}` || s.name === name),
    // Записей нет вовсе — история пуста; иначе самая старая видимая задача.
    oldestSeen: oldest,
    runs: runs.filter((run) => run.enqueuedAt.getTime() >= windowStart.getTime()),
  };
}

function toRun(queue: QueueName, job: Job, state: CronRun['state']): CronRun {
  const result =
    state === 'completed' && job.returnvalue !== null && typeof job.returnvalue === 'object'
      ? (job.returnvalue as Record<string, unknown>)
      : null;
  return {
    queue,
    jobId: job.id ?? '—',
    enqueuedAt: new Date(job.timestamp),
    finishedAt: job.finishedOn === undefined ? null : new Date(job.finishedOn),
    state,
    result,
    failedReason: state === 'failed' ? job.failedReason || 'причина не сохранилась' : null,
    attemptsMade: job.attemptsMade,
  };
}

function sliceDay(
  history: QueueHistory | undefined,
  name: QueueName,
  dayStart: Date,
  dayEnd: Date,
): QueueHistory {
  if (!history) return { queue: name, scheduled: false, oldestSeen: null, runs: [] };
  return {
    ...history,
    runs: history.runs.filter(
      (run) =>
        run.enqueuedAt.getTime() >= dayStart.getTime() &&
        run.enqueuedAt.getTime() < dayEnd.getTime(),
    ),
  };
}

/**
 * Следы суток в Postgres.
 *
 * `AuditLog` с актором вида `cli:*` — единственное место, где ручной запуск
 * команды виден в базе. Полным этот признак не назвать: `pnpm cli optimize` и
 * `pnpm cli ingest` ходят в кабинет под теми же акторами, что и крон
 * (`optimizer`, `ingestion`), и в журнале доступов от кроновых не отличаются.
 * Такой запуск ловится не здесь, а недобором тиков и лишними строками в
 * `ChangeLog` — и это записано в docs/ACCEPTANCE.md как известная дыра, а не
 * выдано за проверку.
 */
/*
 * Клиенты, доступы и кампании считаются на момент проверки, а не «какими они были
 * в те сутки»: истории статусов система не ведёт. Для приёмки этого достаточно —
 * стенд за трое суток не переразворачивают, — но при разборе задним числом об
 * этом надо помнить, поэтому оно написано здесь, а не подразумевается.
 */
async function readDbEvidence(
  db: AcceptanceDb,
  dayStart: Date,
  dayEnd: Date,
  sampleSize: number,
): Promise<DbEvidence> {
  const within = { gte: dayStart, lt: dayEnd };

  const [
    activeClients,
    credentialed,
    activeCampaigns,
    errors,
    errorRows,
    manual,
    humanApprovals,
    approvalsExpired,
    approvalsFailed,
    dailyReportsSent,
  ] = await Promise.all([
    db.client.count({ where: { status: 'ACTIVE' } }),
    db.credential.findMany({
      where: { client: { status: 'ACTIVE' } },
      select: { clientId: true },
      distinct: ['clientId'],
    }),
    db.campaign.count({ where: { status: 'ACTIVE', client: { status: 'ACTIVE' } } }),
    db.errorLog.count({ where: { createdAt: within } }),
    db.errorLog.findMany({
      where: { createdAt: within },
      select: { scope: true, code: true, message: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: sampleSize,
    }),
    db.auditLog.findMany({
      where: { createdAt: within, actor: { startsWith: 'cli:' } },
      select: { actor: true, action: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    }),
    db.changeLog.count({ where: { appliedAt: within, actor: ChangeActor.USER } }),
    db.pendingApproval.count({
      where: { decidedAt: within, decision: ApprovalDecision.EXPIRED },
    }),
    db.pendingApproval.count({ where: { decidedAt: within, decision: ApprovalDecision.FAILED } }),
    db.report.count({ where: { sentAt: within, kind: ReportKind.DAILY } }),
  ]);

  return {
    activeClients,
    clientsWithCredentials: credentialed.length,
    activeCampaigns,
    errors,
    errorSample: errorRows.map(
      (row) =>
        `${whenMsk(row.createdAt)} ${row.scope}${row.code ? `/${row.code}` : ''}: ${row.message}`,
    ),
    manualTouches: manual.map((row) => `${whenMsk(row.createdAt)} ${row.actor} · ${row.action}`),
    humanApprovals,
    approvalsExpired,
    approvalsFailed,
    dailyReportsSent,
  };
}
