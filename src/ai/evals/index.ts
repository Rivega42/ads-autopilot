/**
 * Инфраструктура evals для AI-агентов (CLAUDE.md §8).
 *
 * Код здесь, а наборы кейсов — в `tests/ai-evals/`: так harness типизируется и
 * покрывается `pnpm typecheck`, а фикстуры остаются данными, которые можно
 * перезаписать прогоном по живой модели.
 */
export {
  createMemoryBriefStore,
  createMemoryClientStore,
  type MemoryBriefRow,
  type MemoryBriefStore,
  type MemoryClientStore,
} from './memory-store.js';
export { runEvalCase, type ReplayOptions } from './replay.js';
export {
  aggregateScore,
  buildBaseline,
  compareToBaseline,
  jsonEqual,
  scoreCase,
  type BaselineComparison,
  type CaseScore,
  type EvalBaseline,
  type EvalCheck,
  type Regression,
} from './score.js';
export type { EvalCase, EvalExpectation, EvalRunResult, ScriptedTurn } from './types.js';
