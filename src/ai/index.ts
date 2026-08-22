/**
 * AI-агенты проекта (TZ §13). Пока реализован один — онбординг.
 *
 * Общее для всех: промпты лежат файлами в `src/ai/prompts`, версия промпта уезжает
 * в `AiRun` вместе с вызовом, а качество меряется eval-набором в `tests/ai-evals`.
 */
export {
  clearPromptCache,
  loadPrompt,
  promptHeader,
  renderTemplate,
  PromptError,
  PROMPT_VERSION,
  type LoadedPrompt,
  type PromptName,
  type PromptVars,
} from './prompt-loader.js';
export * from './onboarding/index.js';
