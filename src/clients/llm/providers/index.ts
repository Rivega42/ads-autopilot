import type { LlmProvider, LlmProviderName } from '../types.js';

import { anthropicProvider } from './anthropic.js';
import { deepSeekProvider } from './deepseek.js';
import { openAiProvider } from './openai.js';

/**
 * Реестр провайдеров. Сознательно без всякой логики выбора «кто доступен»:
 * маршрутизацию задаёт таблица TASK_MODELS, а отсутствие ключа обязано
 * приводить к явной ошибке в момент вызова, а не к молчаливой подмене модели —
 * иначе стратег однажды ответит дешёвой моделью, и никто этого не заметит.
 */
export const PROVIDERS: Readonly<Record<LlmProviderName, LlmProvider>> = {
  anthropic: anthropicProvider,
  openai: openAiProvider,
  deepseek: deepSeekProvider,
};

export function getProvider(name: LlmProviderName): LlmProvider {
  return PROVIDERS[name];
}

export { createAnthropicProvider } from './anthropic.js';
export { createOpenAiProvider } from './openai.js';
export { createDeepSeekProvider, DEEPSEEK_BASE_URL } from './deepseek.js';
export { createOpenAiCompatibleProvider } from './openai-compatible.js';
