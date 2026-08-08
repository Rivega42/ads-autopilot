import type { z } from 'zod';
import { scoped } from '@/lib/logger.js';
import { LlmSchemaError } from './errors.js';
import type { LlmMessage, LlmRequest, LlmResponse, LlmUsage } from './types.js';

const log = scoped('llm:structured');

/**
 * Типизированный ответ модели.
 *
 * Почему не нативный structured output провайдера: он есть у Anthropic
 * (`output_config.format`) и у OpenAI, но не у DeepSeek, куда уходит вся массовая
 * работа. Один общий механизм «попроси JSON → провалидируй zod → покажи модели её
 * же ошибки» работает у всех троих и не требует конвертера zod → JSON Schema.
 * Там, где провайдер умеет JSON-режим, он дополнительно включается флагом
 * `request.json` — это уменьшает, но не отменяет необходимость валидации.
 */

const JSON_INSTRUCTION = [
  'Формат ответа: верни ТОЛЬКО валидный JSON.',
  'Без markdown-обёртки, без ```json, без пояснений до или после.',
].join(' ');

export interface CompleteStructuredOptions<T> {
  /**
   * Как сходить к модели. Инжектится вызывающим (run.ts подставляет провайдера,
   * обёрнутого в withRetry), чтобы этот модуль ничего не знал ни о сети, ни о
   * реестре провайдеров, и тестировался без моков SDK.
   */
  call: (req: LlmRequest) => Promise<LlmResponse>;
  request: LlmRequest;
  schema: z.ZodType<T>;
  /** Сколько дополнительных попыток починки. 0 — валидируем один раз и сдаёмся. */
  repairAttempts?: number;
  /** Имя схемы для логов и текста ошибки. */
  schemaName?: string;
}

export interface StructuredResult<T> {
  value: T;
  /** Ответ последней (успешной) попытки. */
  response: LlmResponse;
  /** Токены, суммированные по всем попыткам: платим-то за все. */
  usage: LlmUsage;
  attempts: number;
  rawText: string;
}

/** Вытаскивает JSON из ответа: модели любят обернуть его в ```json или в прозу. */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const firstObj = body.indexOf('{');
  const firstArr = body.indexOf('[');
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return body;

  const closing = body[start] === '{' ? '}' : ']';
  const end = body.lastIndexOf(closing);
  return end > start ? body.slice(start, end + 1) : body.slice(start);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

export async function completeStructured<T>(
  opts: CompleteStructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const { call, schema, repairAttempts = 2, schemaName = 'response' } = opts;

  const system = opts.request.system
    ? `${opts.request.system}\n\n${JSON_INSTRUCTION}`
    : JSON_INSTRUCTION;

  const messages: LlmMessage[] = [...opts.request.messages];
  const total: LlmUsage = { tokensIn: 0, tokensOut: 0 };
  let lastProblem = '';
  let lastText = '';

  for (let attempt = 1; attempt <= repairAttempts + 1; attempt++) {
    const response = await call({ ...opts.request, system, messages, json: true });
    total.tokensIn += response.usage.tokensIn;
    total.tokensOut += response.usage.tokensOut;
    lastText = response.text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(response.text));
    } catch (err) {
      lastProblem = `Ответ не является валидным JSON: ${(err as Error).message}`;
      messages.push({ role: 'assistant', content: response.text });
      messages.push({ role: 'user', content: repairPrompt(lastProblem) });
      log.warn({ attempt, schemaName }, 'model returned non-JSON, asking for a repair');
      continue;
    }

    const result = schema.safeParse(parsed);
    if (result.success) {
      return {
        value: result.data,
        response,
        usage: total,
        attempts: attempt,
        rawText: response.text,
      };
    }

    // Возвращаем модели её собственный ответ и список расхождений: так она чинит
    // конкретное поле, а не переписывает всё заново (и не теряет уже верные части).
    lastProblem = `JSON разобран, но не соответствует схеме:\n${describeIssues(result.error)}`;
    messages.push({ role: 'assistant', content: response.text });
    messages.push({ role: 'user', content: repairPrompt(lastProblem) });
    log.warn({ attempt, schemaName, issues: result.error.issues.length }, 'schema mismatch');
  }

  throw new LlmSchemaError(
    `Model failed to produce a valid "${schemaName}" after ${repairAttempts + 1} attempts`,
    {
      schemaName,
      attempts: repairAttempts + 1,
      lastProblem,
      // Хвост ответа в контексте ошибки: без него отладка промпта превращается в гадание.
      lastText: lastText.slice(0, 2_000),
      usage: total,
    },
  );
}

function repairPrompt(problem: string): string {
  return [
    problem,
    '',
    'Исправь и пришли заново ТОЛЬКО валидный JSON целиком, без markdown и комментариев.',
  ].join('\n');
}
