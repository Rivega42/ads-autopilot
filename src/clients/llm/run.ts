import type { z } from 'zod';
import { prisma } from '@/db/prisma.js';
import { describeError } from '@/lib/errors.js';
import { scoped } from '@/lib/logger.js';
import { withRetry } from '@/lib/retry.js';
import { cacheKey, llmCache, type LlmCache } from './cache.js';
import { assertWithinMonthlyBudget, estimateCostUsd, type AiRunStore } from './cost.js';
import { getProvider } from './providers/index.js';
import { completeStructured } from './structured.js';
import {
  TASK_MODELS,
  type LlmMessage,
  type LlmProviderName,
  type LlmRequest,
  type LlmResponse,
  type LlmTask,
  type LlmUsage,
  type ModelRef,
} from './types.js';

const log = scoped('llm:run');

/**
 * Единственная дверь к моделям для всего проекта.
 *
 * Любой AI-агент из TZ §13 — онбординг, стратег, креативы, модератор, оптимизатор,
 * аналитик, разведка, wordstat — ходит сюда и только сюда. Здесь собраны все
 * сквозные требования, которые иначе пришлось бы восемь раз копировать:
 * выбор модели по типу задачи, проверка месячного бюджета клиента, кеш,
 * ретраи, валидация схемы и запись строки в AiRun с деньгами и латентностью.
 *
 * Инвариант: у каждого вызова есть ровно одна строка в AiRun — и у успешного,
 * и у упавшего. Иначе «куда ушли деньги» превращается в вопрос без ответа.
 */

/** Длина текста, которую сохраняем в AiRun.input. Полные промпты раздувают БД. */
const STORED_TEXT_LIMIT = 4_000;

export interface RunAgentOptions<T = string> {
  /** Имя агента для AiRun.agent: onboarding | strategist | creatives | ... */
  agent: string;
  task: LlmTask;
  /** null для системных прогонов, не привязанных к клиенту (бюджет тогда не проверяется). */
  clientId?: string | null;
  system?: string;
  /** Строка = один пользовательский ход. */
  messages: string | LlmMessage[];
  /** Если задана — вернём валидированный объект вместо строки. */
  schema?: z.ZodType<T>;
  /** Отличает разные схемы с одинаковым промптом в кеше и в логах. */
  schemaName?: string;
  /** Явная модель в обход таблицы задач. Нужна для A/B и для форс-мажора. */
  model?: ModelRef;
  maxTokens?: number;
  temperature?: number;
  /** Кеш одинаковых промптов. По умолчанию включён. */
  cache?: boolean;
  /** Месячный лимит клиента, USD. По умолчанию DEFAULT_MONTHLY_BUDGET_USD. */
  budgetUsd?: number;
  /** Сетевые попытки (429/5xx/обрыв). */
  attempts?: number;
  /** Починки ответа под схему. */
  repairAttempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Подмена зависимостей в тестах и в CLI с другим соединением. */
  db?: AiRunStore;
  cacheStore?: LlmCache;
}

export interface AgentRun<T> {
  /** Валидированный объект (если была схема) или текст ответа. */
  data: T;
  text: string;
  provider: LlmProviderName;
  model: string;
  usage: LlmUsage;
  /** null, если модели нет в прайс-листе — лучше пусто, чем выдуманный ноль. */
  costUsd: number | null;
  latencyMs: number;
  cached: boolean;
  /** id строки AiRun; null, если запись в БД не удалась. */
  aiRunId: string | null;
}

/** Модель для задачи. Отдельная функция, чтобы её можно было проверить в тестах. */
export function resolveModel(task: LlmTask, override?: ModelRef): ModelRef {
  return override ?? TASK_MODELS[task];
}

/**
 * Одна сигнатура вместо перегрузок: без `schema` параметр T разрешается в `string`
 * по умолчанию, со `schema: z.ZodType<X>` — выводится в X. Перегрузки читались бы
 * чуть лучше, но базовое правило no-redeclare в ESLint их не понимает.
 */
export async function runAgent<T = string>(opts: RunAgentOptions<T>): Promise<AgentRun<T>> {
  const startedAt = Date.now();
  const db = opts.db ?? prisma;
  const cacheStore = opts.cacheStore ?? llmCache;
  const model = resolveModel(opts.task, opts.model);
  const provider = getProvider(model.provider);

  const messages: LlmMessage[] =
    typeof opts.messages === 'string' ? [{ role: 'user', content: opts.messages }] : opts.messages;

  const request: LlmRequest = {
    model,
    system: opts.system,
    messages,
    maxTokens: opts.maxTokens ?? model.maxTokens,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs ?? 120_000,
    signal: opts.signal,
  };

  const key = cacheKey(request, `${opts.schemaName ?? (opts.schema ? 'schema' : 'text')}`);
  const useCache = opts.cache !== false;

  let usage: LlmUsage = { tokensIn: 0, tokensOut: 0 };
  let responseModel = model.model;

  try {
    // Бюджет проверяем до вызова: постфактум деньги уже потрачены.
    if (opts.clientId) {
      await assertWithinMonthlyBudget(opts.clientId, db, {
        limitUsd: opts.budgetUsd,
      });
    }

    const cached = useCache ? cacheStore.get(key) : undefined;
    let text: string;
    let data: T;

    if (cached) {
      // Без схемы T разрешается в string (значение по умолчанию параметра),
      // но компилятор об этом здесь не знает — отсюда приведение.
      const reused: CachedParse<T> = opts.schema
        ? parseCached(opts.schema, cached, key, cacheStore)
        : { ok: true, value: cached.text as unknown as T };

      if (reused.ok) {
        const latencyMs = Date.now() - startedAt;
        log.debug({ agent: opts.agent, task: opts.task }, 'served from llm cache');
        // Строку в AiRun пишем и на попадании: иначе в истории клиента возникнут
        // дыры, и «сколько раз агент отработал» разойдётся со «сколько мы заплатили».
        // Токены и стоимость — нули, второй раз за тот же ответ никто не платит.
        const aiRunId = await recordRun(db, {
          opts,
          model,
          responseModel: cached.model,
          usage,
          costUsd: 0,
          latencyMs,
          output: opts.schema ? (reused.value as unknown) : { text: cached.text },
          error: null,
          cached: true,
        });
        return {
          data: reused.value,
          text: cached.text,
          provider: model.provider,
          model: cached.model,
          usage,
          costUsd: 0,
          latencyMs,
          cached: true,
          aiRunId,
        };
      }
      cacheStore.delete(key);
    }

    const call = (req: LlmRequest): Promise<LlmResponse> =>
      withRetry(() => provider.complete(req), {
        attempts: opts.attempts ?? 3,
        label: `llm:${model.provider}:${opts.agent}`,
        signal: opts.signal,
      });

    let finalResponse: LlmResponse;

    if (opts.schema) {
      const structured = await completeStructured({
        call,
        request,
        schema: opts.schema,
        repairAttempts: opts.repairAttempts ?? 2,
        schemaName: opts.schemaName ?? `${opts.agent}.${opts.task}`,
      });
      data = structured.value;
      text = structured.rawText;
      usage = structured.usage;
      finalResponse = structured.response;
    } else {
      finalResponse = await call(request);
      // Тот же случай: без схемы T === string.
      data = finalResponse.text as unknown as T;
      text = finalResponse.text;
      usage = finalResponse.usage;
    }

    responseModel = finalResponse.model;
    const costUsd = estimateCostUsd(responseModel, usage.tokensIn, usage.tokensOut);
    const latencyMs = Date.now() - startedAt;

    if (useCache) cacheStore.set(key, { ...finalResponse, text });

    const aiRunId = await recordRun(db, {
      opts,
      model,
      responseModel,
      usage,
      costUsd,
      latencyMs,
      output: opts.schema ? (data as unknown) : { text },
      error: null,
    });

    return {
      data,
      text,
      provider: model.provider,
      model: responseModel,
      usage,
      costUsd,
      latencyMs,
      cached: false,
      aiRunId,
    };
  } catch (err) {
    // Упавший вызов тоже стоил денег и времени — он обязан оставить след.
    const latencyMs = Date.now() - startedAt;
    await recordRun(db, {
      opts,
      model,
      responseModel,
      usage,
      costUsd: estimateCostUsd(responseModel, usage.tokensIn, usage.tokensOut),
      latencyMs,
      output: null,
      error: describeError(err),
    });
    throw err;
  }
}

type CachedParse<T> = { ok: true; value: T } | { ok: false };

function parseCached<T>(
  schema: z.ZodType<T>,
  cached: LlmResponse,
  key: string,
  store: LlmCache,
): CachedParse<T> {
  // Схема могла поменяться с деплоем, а кеш пережить его в памяти воркера:
  // тогда честнее сходить в модель заново, чем вернуть устаревшую форму.
  const parsed = safeJson(cached.text);
  if (parsed === undefined) return { ok: false };
  const result = schema.safeParse(parsed);
  if (!result.success) {
    log.warn({ key: key.slice(0, 12) }, 'cached response no longer matches schema, dropping');
    store.delete(key);
    return { ok: false };
  }
  return { ok: true, value: result.data };
}

function safeJson(text: string): unknown {
  try {
    // Тот же извлекатель, что и в structured.ts: в кеше лежит сырой текст модели.
    return JSON.parse(stripFences(text));
  } catch {
    return undefined;
  }
}

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text.trim());
  return (fenced?.[1] ?? text).trim();
}

interface RecordArgs {
  opts: RunAgentOptions<unknown>;
  model: ModelRef;
  responseModel: string;
  usage: LlmUsage;
  costUsd: number | null;
  latencyMs: number;
  output: unknown;
  error: string | null;
  cached?: boolean;
}

/** Запись в AiRun. Падение самой записи не должно ронять полезную работу агента. */
async function recordRun(db: AiRunStore, args: RecordArgs): Promise<string | null> {
  const { opts } = args;
  try {
    const row = await db.aiRun.create({
      data: {
        clientId: opts.clientId ?? null,
        agent: opts.agent,
        model: args.responseModel,
        input: {
          task: opts.task,
          provider: args.model.provider,
          cached: args.cached ?? false,
          system: truncate(opts.system),
          messages:
            typeof opts.messages === 'string'
              ? [{ role: 'user', content: truncate(opts.messages) }]
              : opts.messages.map((m) => ({ role: m.role, content: truncate(m.content) })),
        },
        output: (args.output ?? undefined) as never,
        tokensIn: args.usage.tokensIn,
        tokensOut: args.usage.tokensOut,
        costUsd: args.costUsd,
        latencyMs: args.latencyMs,
        error: args.error,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    log.error(
      { agent: opts.agent, task: opts.task, err: describeError(err) },
      'failed to persist AiRun',
    );
    return null;
  }
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > STORED_TEXT_LIMIT ? `${value.slice(0, STORED_TEXT_LIMIT)}…` : value;
}
