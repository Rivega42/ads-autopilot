import { QUEUE_EXPECTATIONS, expectedRunsPerDay } from '@/acceptance/spec.js';
import { formatMsk, lastNDaysMsk, mskDateToUtc } from '@/lib/dates.js';
import type { QueueName } from '@/scheduler/schedule.js';

/**
 * Вердикт по суткам работы системы (приёмка ТЗ §9.6).
 *
 * Модуль намеренно чистый: он ничего не читает и ничего не отправляет, ему
 * приносят снятые улики. Причина не в стиле, а в том, что проверять его надо на
 * тех состояниях, которые на живом стенде встречаются один раз и не по заказу:
 * пустая база, подчищенная история Redis, два крона из трёх.
 *
 * Три исхода, а не два. «Сорвано» и «нет данных» — разные ответы, и смешивать
 * их нельзя в обе стороны: молчащий Redis, объявленный срывом, отправит человека
 * чинить работающую систему, а недостача улик, объявленная успехом, засчитает
 * трое суток, которых не было.
 */

export type CheckStatus = 'pass' | 'fail' | 'unknown';
export type DayStatus = 'passed' | 'failed' | 'no-data';

export interface CheckResult {
  /** Устойчивый идентификатор проверки — по нему её ищут в выводе и в тестах. */
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface CronRun {
  queue: QueueName;
  jobId: string;
  /** Момент постановки задачи: по нему прогон относится к суткам, а не по finishedAt. */
  enqueuedAt: Date;
  finishedAt: Date | null;
  state: 'completed' | 'failed';
  /** Сводка обработчика. У упавшей задачи — null. */
  result: Record<string, unknown> | null;
  failedReason: string | null;
  attemptsMade: number;
}

export interface QueueHistory {
  queue: QueueName;
  /** Зарегистрировано ли расписание `cron:<queue>` в Redis. */
  scheduled: boolean;
  /** Самая старая задача, видимая в истории очереди. null — история пуста. */
  oldestSeen: Date | null;
  runs: readonly CronRun[];
}

export interface DbEvidence {
  activeClients: number;
  clientsWithCredentials: number;
  activeCampaigns: number;
  errors: number;
  errorSample: readonly string[];
  /** Записи журнала доступов, сделанные командой руками (`actor` вида `cli:*`). */
  manualTouches: readonly string[];
  humanApprovals: number;
  approvalsExpired: number;
  approvalsFailed: number;
  dailyReportsSent: number;
}

export interface CycleEvidence {
  /** Сутки по МСК, `yyyy-MM-dd`. */
  date: string;
  dayStart: Date;
  dayEnd: Date;
  queues: readonly QueueHistory[];
  db: DbEvidence;
}

export interface DayVerdict {
  date: string;
  status: DayStatus;
  checks: readonly CheckResult[];
  /** Замеченное, но не влияющее на вердикт: нажатия человека, наложения, ретраи. */
  notes: readonly string[];
}

export interface CycleVerdict {
  days: readonly DayVerdict[];
  required: number;
  passed: number;
  status: DayStatus;
}

/** Последние `days` полных суток по МСК, не включая сегодняшние. */
export function cycleWindow(days: number, now: Date = new Date()): string[] {
  const { from } = lastNDaysMsk(days, now);
  const start = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    return day.toISOString().slice(0, 10);
  });
}

/** Границы суток `yyyy-MM-dd` по МСК, выраженные в UTC. */
export function dayBounds(date: string): { dayStart: Date; dayEnd: Date } {
  const dayStart = mskDateToUtc(date);
  return { dayStart, dayEnd: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) };
}

export function judgeDay(evidence: CycleEvidence): DayVerdict {
  const { db } = evidence;
  const checks: CheckResult[] = [];
  const notes: string[] = [];

  /**
   * Есть ли вообще что обрабатывать. Пока этого нет, «крон отработал без отказов»
   * не означает ничего: обработчик без кабинетов возвращает нули и завершается
   * успехом. Поэтому холостой ход на пустой базе объявляется недостачей улик, а
   * на живой — срывом.
   */
  const baseReady = db.activeClients > 0 && db.clientsWithCredentials > 0 && db.activeCampaigns > 0;

  checks.push({
    id: 'db:clients',
    title: 'Клиенты и доступы',
    status: db.activeClients > 0 && db.clientsWithCredentials > 0 ? 'pass' : 'unknown',
    detail: `активных клиентов ${db.activeClients}, из них с доступами ${db.clientsWithCredentials}`,
  });
  checks.push({
    id: 'db:campaigns',
    title: 'Активные кампании',
    status: db.activeCampaigns > 0 ? 'pass' : 'unknown',
    detail: `${db.activeCampaigns} шт.`,
  });

  /**
   * Достаёт ли история Redis до начала суток хоть по одной очереди. Если да —
   * пустая история конкретной очереди означает, что она не работала. Если нет —
   * означает, что записи вычистили, и это не повод никого будить.
   */
  const historyCoversDay = evidence.queues.some(
    (q) => q.oldestSeen !== null && q.oldestSeen.getTime() <= evidence.dayStart.getTime(),
  );

  for (const queue of evidence.queues) {
    checks.push(judgeQueue(queue, { historyCoversDay, baseReady, notes }));
  }

  checks.push({
    id: 'db:errors',
    title: 'Журнал ошибок',
    status: db.errors === 0 ? 'pass' : 'fail',
    detail:
      db.errors === 0 ? 'пусто' : `${db.errors} записей: ${db.errorSample.slice(0, 3).join('; ')}`,
  });

  checks.push({
    id: 'db:manual',
    title: 'Ручное вмешательство',
    status: db.manualTouches.length === 0 ? 'pass' : 'fail',
    detail:
      db.manualTouches.length === 0
        ? 'команд руками не запускали'
        : db.manualTouches.slice(0, 5).join('; '),
  });

  checks.push({
    id: 'db:approvals',
    title: 'Применение решений человека',
    status: db.approvalsFailed === 0 ? 'pass' : 'fail',
    detail:
      db.approvalsFailed === 0
        ? 'сорванных применений нет'
        : `${db.approvalsFailed} карточек упало на применении`,
  });

  checks.push({
    id: 'db:report',
    title: 'Дневной отчёт доставлен',
    status: db.dailyReportsSent > 0 ? 'pass' : baseReady ? 'fail' : 'unknown',
    detail: `${db.dailyReportsSent} отчётов с отметкой sentAt`,
  });

  if (db.humanApprovals > 0) {
    notes.push(
      `нажатий по карточкам апрува: ${db.humanApprovals} — штатный ход (ТЗ §3.5), не вмешательство`,
    );
  }
  if (db.approvalsExpired > 0) {
    notes.push(`карточек истекло без ответа: ${db.approvalsExpired}`);
  }

  return { date: evidence.date, status: rollUp(checks), checks, notes };
}

interface QueueContext {
  historyCoversDay: boolean;
  baseReady: boolean;
  notes: string[];
}

function judgeQueue(queue: QueueHistory, ctx: QueueContext): CheckResult {
  const id = `cron:${queue.queue}`;
  const title = queue.queue;
  const expected = expectedRunsPerDay(queue.queue);

  /**
   * Можно ли вообще судить эту очередь.
   *
   * История BullMQ живёт в Redis и её чистят по потолку хранения, а расписания
   * теряются вместе с базой Redis целиком. Пока ни одна очередь не показала
   * задачи старше начала суток, «прогонов не было» неотличимо от «Redis подняли
   * вчера»: первое — срыв, второе — недостача улик, и путать их нельзя ни в одну
   * сторону. Поэтому знание о суточных границах берётся из всей истории сразу.
   */
  const knowable = ctx.historyCoversDay;

  if (!queue.scheduled) {
    return {
      id,
      title,
      status: knowable ? 'fail' : 'unknown',
      detail: knowable
        ? 'расписание не зарегистрировано в Redis'
        : 'расписания нет, истории тоже — воркер здесь ещё не работал',
    };
  }

  const failed = queue.runs.filter((run) => run.state === 'failed');
  if (failed.length > 0) {
    const reason = failed[0]?.failedReason ?? 'причина не сохранилась';
    return {
      id,
      title,
      status: 'fail',
      detail: `${failed.length} задач упало, первая: ${reason}`,
    };
  }

  // Наложение — это тик, который ничего не сделал: обработчик увидел незакрытый
  // предыдущий прогон и вышел. Считать его отработавшим нельзя, иначе сутки, где
  // сбор статистики отстал на полдня, читаются как полные.
  const overlapped = queue.runs.filter((run) => run.result?.['skipped'] === true);
  const done = queue.runs.filter(
    (run) => run.state === 'completed' && run.result?.['skipped'] !== true,
  );
  if (overlapped.length > 0) {
    ctx.notes.push(`${queue.queue}: ${overlapped.length} прогонов отложено наложением`);
  }
  const retried = done.filter((run) => run.attemptsMade > 1);
  if (retried.length > 0) {
    ctx.notes.push(`${queue.queue}: ${retried.length} прогонов прошло не с первой попытки`);
  }

  if (done.length < expected) {
    const detail = `отработало ${done.length} из ${expected} тиков`;
    return {
      id,
      title,
      status: knowable ? 'fail' : 'unknown',
      detail: knowable ? detail : `${detail}; история очереди не достаёт до начала суток`,
    };
  }

  const expectation = QUEUE_EXPECTATIONS[queue.queue];

  for (const run of done) {
    for (const field of expectation.zero) {
      const value = numberField(run.result, field);
      if (value !== null && value > 0) {
        return { id, title, status: 'fail', detail: `в прогоне ${run.jobId}: ${field} = ${value}` };
      }
    }
    for (const field of expectation.empty) {
      const value = run.result?.[field];
      if (Array.isArray(value) && value.length > 0) {
        return {
          id,
          title,
          status: 'fail',
          detail: `в прогоне ${run.jobId}: ${field} — ${value.length} записей`,
        };
      }
    }
  }

  const idle = expectation.positive.filter(
    (field) => !done.some((run) => (numberField(run.result, field) ?? 0) > 0),
  );
  if (idle.length > 0) {
    return {
      id,
      title,
      // На пустой базе холостой ход — следствие пустой базы, а не отказ системы.
      status: ctx.baseReady ? 'fail' : 'unknown',
      detail: `${expected} тиков прошло вхолостую: ${idle.join(', ')} ни разу не поднялось выше нуля`,
    };
  }

  return { id, title, status: 'pass', detail: `${done.length} из ${expected} тиков` };
}

function numberField(result: Record<string, unknown> | null, field: string): number | null {
  const value = result?.[field];
  return typeof value === 'number' ? value : null;
}

/** Отказ важнее недостачи улик: молчать о поломке из-за неполных данных нельзя. */
function rollUp(checks: readonly CheckResult[]): DayStatus {
  if (checks.some((c) => c.status === 'fail')) return 'failed';
  if (checks.some((c) => c.status === 'unknown')) return 'no-data';
  return 'passed';
}

export function judgeCycle(days: readonly DayVerdict[], required: number): CycleVerdict {
  const passed = days.filter((day) => day.status === 'passed').length;
  const status: DayStatus = days.some((day) => day.status === 'failed')
    ? 'failed'
    : passed >= required
      ? 'passed'
      : 'no-data';
  return { days, required, passed, status };
}

/** Момент для человека: `19.08 08:30`. */
export function whenMsk(at: Date): string {
  return formatMsk(at, 'dd.MM HH:mm');
}
