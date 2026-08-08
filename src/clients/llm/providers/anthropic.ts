import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { env } from '@/config/index.js';
import { scoped } from '@/lib/logger.js';
import { LlmApiError, LlmConfigError } from '../errors.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../types.js';

const log = scoped('llm:anthropic');

/**
 * Основной провайдер. Работает через официальный @anthropic-ai/sdk — не через axios:
 * SDK сам следит за версией протокола и типами блоков контента, а они меняются
 * от релиза к релизу (thinking, output_config, refusal-блоки).
 *
 * Отключаем встроенные ретраи SDK (maxRetries: 0): политика повторов у нас одна
 * на весь проект — src/lib/retry.ts. Иначе получаем 3×3 попытки и непредсказуемое
 * время выполнения задачи в очереди.
 */

/** Выше этого потолка ответ гоняем стримом, иначе можно поймать HTTP-таймаут SDK. */
const STREAM_THRESHOLD_TOKENS = 16_000;

/**
 * @param apiKey резолвер ключа — функция, а не строка: .env может подгрузиться
 *   позже импорта, а ключ в проде ротируется без рестарта процесса.
 */
export function createAnthropicProvider(
  apiKey?: () => string | undefined,
  opts: { baseURL?: string } = {},
): LlmProvider {
  const readKey = apiKey ?? (() => env.ANTHROPIC_API_KEY);
  let client: Anthropic | undefined;
  let clientKey: string | undefined;

  function getClient(): Anthropic {
    const apiKey = readKey();
    if (!apiKey) {
      // Честная деградация: не подменяем провайдера и не выдумываем ответ.
      throw new LlmConfigError(
        'ANTHROPIC_API_KEY is not set — cannot call the Anthropic provider',
        { provider: 'anthropic' },
      );
    }
    // Пересоздаём клиент только при смене ключа (ротация в проде).
    if (!client || clientKey !== apiKey) {
      client = new Anthropic({
        apiKey,
        maxRetries: 0,
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
      clientKey = apiKey;
    }
    return client;
  }

  return {
    name: 'anthropic',

    isConfigured(): boolean {
      return Boolean(readKey());
    },

    async complete(req: LlmRequest): Promise<LlmResponse> {
      const sdk = getClient();
      const maxTokens = req.maxTokens ?? req.model.maxTokens;

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model.model,
        max_tokens: maxTokens,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (req.system) params.system = req.system;
      // thinking и effort шлём только если модель их поддерживает: на Haiku 4.5
      // любой из этих параметров даёт 400.
      if (req.model.adaptiveThinking) params.thinking = { type: 'adaptive' };
      if (req.model.effort) params.output_config = { effort: req.model.effort };
      // temperature/top_p сняты на моделях 4.7+ и возвращают 400 — req.temperature
      // здесь сознательно игнорируется, поведение задаётся промптом.

      const requestOptions = {
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      };

      try {
        const message =
          maxTokens > STREAM_THRESHOLD_TOKENS
            ? await sdk.messages.stream(params, requestOptions).finalMessage()
            : await sdk.messages.create(params, requestOptions);

        if (message.stop_reason === 'refusal') {
          // Классификатор безопасности отказал. Ответа нет — притворяться, что он
          // есть, нельзя, и ретрай тем же промптом ничего не изменит.
          throw new LlmApiError('Anthropic refused the request', {
            provider: 'anthropic',
            model: req.model.model,
            retryable: false,
          });
        }

        const text = message.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        const usage = message.usage;
        return {
          text,
          usage: {
            // Кеш-чтения prompt caching учитываем как обычный вход: сейчас мы
            // cache_control не выставляем, но если начнём — счёт останется верным
            // (с запасом в большую сторону).
            tokensIn:
              usage.input_tokens +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0),
            tokensOut: usage.output_tokens,
          },
          provider: 'anthropic',
          model: message.model,
          stopReason: message.stop_reason ?? undefined,
        };
      } catch (err) {
        throw mapAnthropicError(err, req.model.model);
      }
    },
  };
}

/** Приводит ошибки SDK к нашей иерархии, чтобы withRetry понимал, что ретраить. */
function mapAnthropicError(err: unknown, model: string): unknown {
  if (err instanceof LlmApiError || err instanceof LlmConfigError) return err;

  if (err instanceof APIConnectionError) {
    return new LlmApiError('Anthropic connection failed', {
      provider: 'anthropic',
      model,
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof APIError) {
    const status = err.status ?? 0;
    // 401/403 — проблема конфигурации, а не сети: ретрай только сожжёт время.
    if (status === 401 || status === 403) {
      return new LlmConfigError(`Anthropic rejected the API key (HTTP ${status})`, {
        provider: 'anthropic',
        model,
      });
    }
    const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
    const retryAfterMs = parseRetryAfterMs(err.headers);
    log.warn({ status, model, retryable }, 'anthropic api error');
    return new LlmApiError(`Anthropic API error (HTTP ${status}): ${err.message}`, {
      provider: 'anthropic',
      model,
      status,
      retryable,
      retryAfterMs,
      cause: err,
    });
  }

  return err;
}

function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export const anthropicProvider = createAnthropicProvider();
