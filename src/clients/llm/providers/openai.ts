import type { LlmProvider } from '../types.js';

import { createOpenAiCompatibleProvider } from './openai-compatible.js';

import { env } from '@/env.js';

/**
 * Запасной провайдер: используется там, где нужен второй мнение или где
 * у клиента нет доступа к Anthropic. Base URL дефолтный (api.openai.com).
 */
export function createOpenAiProvider(apiKey?: () => string | undefined): LlmProvider {
  return createOpenAiCompatibleProvider({
    name: 'openai',
    envVar: 'OPENAI_API_KEY',
    apiKey: apiKey ?? (() => env.OPENAI_API_KEY),
    // Семейство gpt-5 принимает только max_completion_tokens и отвергает temperature.
    maxTokensParam: 'max_completion_tokens',
    supportsTemperature: false,
  });
}

export const openAiProvider = createOpenAiProvider();
