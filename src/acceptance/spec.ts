import type { AbEvaluationSummary } from '@/creatives/scheduled.js';
import type { IngestionRunSummary, TokenRefreshResult } from '@/ingestion/index.js';
import type { ModerationRunSummary } from '@/moderation/run.js';
import type { ScheduledOptimizationSummary } from '@/optimizer/scheduled.js';
import type { DailyRunSummary } from '@/reporter/daily.js';
import {
  CRON_SCHEDULE,
  QUEUE_NAMES,
  cronIntervalMinutes,
  type QueueName,
} from '@/scheduler/schedule.js';

/**
 * Что считать «полным циклом ежедневной оптимизации» (приёмка ТЗ §9.6).
 *
 * Определение выведено из `CRON_SCHEDULE`, а не написано словами рядом с ним:
 * список, набранный руками, разъезжается с расписанием при первой же правке и
 * молча — ровно тот класс, из-за которого `cronIntervalMinutes` живёт рядом с
 * самим расписанием. Поэтому суточным считается любой крон, который расписание
 * обязывает сработать хотя бы раз в сутки, а сколько именно раз — тоже считается
 * из расписания.
 */

/** Сутки в минутах: граница между «суточным» кроном и всем, что реже. */
export const CYCLE_DAY_MINUTES = 1440;

/**
 * Очереди, из которых состоит суточный цикл.
 *
 * `weekly-report` (раз в неделю) и `wordstat-mine` (раз в трое суток) сюда не
 * попадают по построению: требовать их внутри суток — значит объявить сорванным
 * каждый вторник.
 */
export const CYCLE_QUEUES: readonly QueueName[] = Object.values(QUEUE_NAMES).filter(
  (name) => cronIntervalMinutes(CRON_SCHEDULE[name]) <= CYCLE_DAY_MINUTES,
);

/** Сколько раз расписание обязывает очередь сработать за сутки. */
export function expectedRunsPerDay(name: QueueName): number {
  return Math.floor(CYCLE_DAY_MINUTES / cronIntervalMinutes(CRON_SCHEDULE[name]));
}

/**
 * Чем прогон отчитывается о том, что он действительно работал.
 *
 * Без `positive` вся проверка сводится к «крон не упал», а не упасть проще всего
 * на пустой базе: `runIngestion` без единого кабинета возвращает
 * `{ targets: 0, failures: [] }` и выглядит как успешные сутки. Этот класс ошибки
 * в проекте ловили уже несколько раз, поэтому холостой ход объявляется отдельно
 * от отказа и так же громко.
 */
export interface QueueExpectation {
  /** Числовые поля сводки, обязанные быть нулём в каждом прогоне. */
  readonly zero: readonly string[];
  /** Поля-массивы, обязанные быть пустыми в каждом прогоне. */
  readonly empty: readonly string[];
  /** Поля, обязанные быть больше нуля хотя бы в одном прогоне за сутки. */
  readonly positive: readonly string[];
}

/**
 * Имена полей сверяются с типом сводки обработчика прямо компилятором.
 *
 * Не тестом: опечатка в имени поля даёт не красный тест, а зелёную проверку —
 * `run.result['faliures']` это `undefined`, то есть «отказов не было». Проверка,
 * которая от опечатки становится мягче, хуже отсутствующей, а поля сводок будут
 * переименовывать ещё не раз.
 */
function expectation<T>(spec: {
  zero?: readonly (keyof T & string)[];
  empty?: readonly (keyof T & string)[];
  positive?: readonly (keyof T & string)[];
}): QueueExpectation {
  return { zero: spec.zero ?? [], empty: spec.empty ?? [], positive: spec.positive ?? [] };
}

const NOTHING: QueueExpectation = { zero: [], empty: [], positive: [] };

const OPTIMIZATION = expectation<ScheduledOptimizationSummary>({
  zero: ['failed', 'applyFailed', 'approvalsFailed', 'approvalsUndelivered', 'localStateFailed'],
  positive: ['campaigns'],
});

export const QUEUE_EXPECTATIONS: Record<QueueName, QueueExpectation> = {
  [QUEUE_NAMES.fetchStats]: expectation<IngestionRunSummary>({
    empty: ['failures'],
    positive: ['targets'],
  }),
  [QUEUE_NAMES.checkModeration]: expectation<ModerationRunSummary>({
    empty: ['failures'],
    positive: ['targets'],
  }),
  // Оба крона зовут один и тот же `runScheduledOptimization` — сводка у них общая.
  [QUEUE_NAMES.optimizeBids]: OPTIMIZATION,
  [QUEUE_NAMES.pauseLosers]: OPTIMIZATION,
  [QUEUE_NAMES.evaluateAbTests]: expectation<AbEvaluationSummary>({
    zero: ['failed', 'approvalsFailed', 'unbuildable'],
    // Групп-экспериментов может не быть вовсе: система тестирует только свои
    // варианты, и кабинет без LLM-креативов даёт честный ноль.
  }),
  [QUEUE_NAMES.dailyReport]: expectation<DailyRunSummary>({
    empty: ['failures'],
    positive: ['clients', 'sent'],
  }),
  [QUEUE_NAMES.refreshTokens]: expectation<TokenRefreshResult>({
    empty: ['failures'],
    positive: ['checked'],
  }),
  // Гигиена: свои отказы эти двое не считают, а срыв по ним виден по недобору
  // тиков и по строкам в `ErrorLog`.
  [QUEUE_NAMES.expireApprovals]: NOTHING,
  [QUEUE_NAMES.alertScan]: NOTHING,
  // Не суточные: в `CYCLE_QUEUES` не попадают, здесь стоят ради полноты записи.
  [QUEUE_NAMES.wordstatMine]: NOTHING,
  [QUEUE_NAMES.weeklyReport]: NOTHING,
};
