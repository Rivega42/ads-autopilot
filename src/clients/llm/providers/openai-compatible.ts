import OpenAI, { APIConnectionError, APIError } from 'openai';

import { LlmApiError, LlmConfigError } from '../errors.js';
import type { LlmProvider, LlmProviderName, LlmRequest, LlmResponse } from '../types.js';

import { logger } from '@/logger.js';

const log = logger.child({ scope: 'llm:openai-compatible' });

/**
 * Общая реализация для всех провайдеров, говорящих на протоколе
 * `POST /v1/chat/completions`. DeepSeek с ним wire-совместим, поэтому свой клиент
 * ему не нужен — отличается только baseURL, имя переменной окружения и пара
 * особенностей параметров (см. флаги ниже). Копия этого файла под DeepSeek
 * означала бы два места, где чинить маппинг ошибок.
 */

export interface OpenAiCompatibleOptions {
  name: LlmProviderName;
  /** Что подсказать в ошибке конфигурации. */
  envVar: string;
  apiKey: () => string | undefined;
  baseURL?: string;
  /**
   * Семейство gpt-5 принимает только `max_completion_tokens`; DeepSeek и старые
   * модели OpenAI — только `max_tokens`. Угадывать по имени модели нельзя.
   */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** gpt-5 отвергает нестандартную temperature; DeepSeek её принимает. */
  supportsTemperature: boolean;
}

export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  let client: OpenAI | undefined;
  let clientKey: string | undefined;

  function getClient(): OpenAI {
    const apiKey = opts.apiKey();
    if (!apiKey) {
      throw new LlmConfigError(
        `${opts.envVar} is not set — cannot call the ${opts.name} provider`,
        { provider: opts.name },
      );
    }
    if (!client || clientKey !== apiKey) {
      // maxRetries: 0 — политика ретраев одна на проект (src/lib/retry.ts).
      client = new OpenAI({
        apiKey,
        maxRetries: 0,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
      clientKey = apiKey;
    }
    return client;
  }

  return {
    name: opts.name,

    isConfigured(): boolean {
      return Boolean(opts.apiKey());
    },

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const sdk = getClient();
      const maxTokens = req.maxTokens ?? req.model.maxTokens;

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      for (const m of req.messages) messages.push({ role: m.role, content: m.content });

      const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: req.model.model,
        messages,
      };
      if (opts.maxTokensParam === 'max_tokens') params.max_tokens = maxTokens;
      else params.max_completion_tokens = maxTokens;
      if (opts.supportsTemperature && req.temperature !== undefined) {
        params.temperature = req.temperature;
      }
      // JSON-режим включаем только по явной просьбе structured.ts: он требует,
      // чтобы слово "json" встречалось в промпте, иначе API вернёт 400.
      if (req.json) params.response_format = { type: 'json_object' };

      try {
        const completion = await sdk.chat.completions.create(params, {
          ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });

        const choice = completion.choices[0];
        const text = choice?.message.content ?? '';
        const usage = completion.usage;

        return {
          text,
          usage: {
            tokensIn: usage?.prompt_tokens ?? 0,
            tokensOut: usage?.completion_tokens ?? 0,
          },
          provider: opts.name,
          model: completion.model || req.model.model,
          stopReason: choice?.finish_reason ?? undefined,
        };
      } catch (err) {
        throw mapOpenAiError(err, opts.name, req.model.model);
      }
    },
  };
}

function mapOpenAiError(err: unknown, provider: LlmProviderName, model: string): unknown {
  if (err instanceof LlmApiError || err instanceof LlmConfigError) return err;

  if (err instanceof APIConnectionError) {
    return new LlmApiError(`${provider} connection failed`, {
      provider,
      model,
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    if (status === 401 || status === 403) {
      return new LlmConfigError(`${provider} rejected the API key (HTTP ${status})`, {
        provider,
        model,
      });
    }
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    log.warn({ status, model, provider, retryable }, 'openai-compatible api error');
    return new LlmApiError(`${provider} API error (HTTP ${status}): ${err.message}`, {
      provider,
      model,
      status,
      retryable,
      cause: err,
    });
  }

  return err;
}
