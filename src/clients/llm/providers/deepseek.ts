import type { LlmProvider } from '../types.js';

import { createOpenAiCompatibleProvider } from './openai-compatible.js';

import { env } from '@/env.js';

/** OpenAI-совместимый эндпоинт DeepSeek (https://api-docs.deepseek.com, сверено 2026-08-08). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

/**
 * Провайдер массовых дешёвых задач (TZ, EPIC-03.1): классификация отказов
 * модерации, генерация сотен формулировок ключей. Реализации своей не имеет —
 * протокол тот же, что у OpenAI, отличается base URL и то, что здесь ещё
 * работают max_tokens и temperature.
 */
export function createDeepSeekProvider(apiKey?: () => string | undefined): LlmProvider {
  return createOpenAiCompatibleProvider({
    name: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    apiKey: apiKey ?? (() => env.DEEPSEEK_API_KEY),
    baseURL: DEEPSEEK_BASE_URL,
    maxTokensParam: 'max_tokens',
    supportsTemperature: true,
  });
}

export const deepSeekProvider = createDeepSeekProvider();
