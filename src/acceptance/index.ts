/**
 * Приёмка ТЗ §9.6: «пройдено 3 полных цикла ежедневной оптимизации без ручного
 * вмешательства».
 *
 * Что считать циклом — `spec.ts` (выводится из `CRON_SCHEDULE`), как судить —
 * `cycle.ts` (чистая функция), откуда брать улики — `collect.ts`, как показать
 * человеку — `render.ts`. Точка входа для человека — `pnpm acceptance`
 * (`src/apps/acceptance.ts`), процедура — `docs/ACCEPTANCE.md`.
 */
export {
  DEFAULT_DAYS,
  DEV_INVOCATION,
  IMAGE_INVOCATION,
  acceptanceInvocation,
  parseArgs,
  resolveWindow,
  usageLines,
  type AcceptanceArgs,
} from '@/acceptance/args.js';
export {
  closeCycleConnections,
  collectCycleEvidence,
  type AcceptanceDb,
  type CollectOptions,
} from '@/acceptance/collect.js';
export {
  cycleWindow,
  dayBounds,
  judgeCycle,
  judgeDay,
  whenMsk,
  type CheckResult,
  type CheckStatus,
  type CronRun,
  type CycleEvidence,
  type CycleVerdict,
  type DayStatus,
  type DayVerdict,
  type DbEvidence,
  type QueueHistory,
} from '@/acceptance/cycle.js';
export { renderCycleMarkdown, renderCycleText } from '@/acceptance/render.js';
export {
  CYCLE_DAY_MINUTES,
  CYCLE_QUEUES,
  QUEUE_EXPECTATIONS,
  expectedRunsPerDay,
  type QueueExpectation,
} from '@/acceptance/spec.js';
