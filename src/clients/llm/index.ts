/**
 * LLM-ядро (EPIC-03). Публичная поверхность для AI-агентов.
 *
 * Правило для вызывающих: звать `runAgent()`, не провайдеров напрямую —
 * только через него вызов попадает в AiRun и учитывается в бюджете клиента.
 */
export { runAgent, resolveModel, type AgentRun, type RunAgentOptions } from './run.js';
export {
  TASK_MODELS,
  type LlmEffort,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderName,
  type LlmRequest,
  type LlmResponse,
  type LlmTask,
  type LlmUsage,
  type ModelRef,
} from './types.js';
export {
  completeStructured,
  extractJson,
  type CompleteStructuredOptions,
  type StructuredResult,
} from './structured.js';
export {
  assertWithinMonthlyBudget,
  estimateCostUsd,
  getMonthlySpendUsd,
  monthStartMsk,
  DEFAULT_MONTHLY_BUDGET_USD,
  MODEL_PRICING,
  type AiRunStore,
  type BudgetStatus,
  type ModelPrice,
} from './cost.js';
export { LlmCache, llmCache, cacheKey, type CacheStats } from './cache.js';
export { LlmApiError, LlmBudgetError, LlmConfigError, LlmSchemaError } from './errors.js';
export { getProvider, PROVIDERS } from './providers/index.js';
