import { z } from 'zod';

import { loadPrompt } from '@/ai/prompt-loader.js';
import { DIRECT_KEYWORD_MAX_CHARS, DIRECT_KEYWORD_MAX_WORDS } from '@/campaigns/limits.js';
import { runAgent, type AgentRun, type RunAgentOptions } from '@/clients/llm/index.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'keywords:expand' });

/** Имя агента в AiRun. По нему считается, сколько стоит семантика одного клиента. */
export const KEYWORDS_AGENT = 'ai-wordstat';

/** ТЗ §13.8: «LLM генерит 200 семантически близких формулировок». */
export const DEFAULT_EXPANSION_TARGET = 200;

/**
 * Схема ответа расширения — намеренно **только строки**.
 *
 * Это не стилистика, а защита от главной ошибки этого агента: модель, которую
 * попросили «подобрать ключи», охотно приписывает к ним частоты, и такое число
 * выглядит достоверно ровно до момента, когда по нему выставят ставку. Схема без
 * единого числового поля делает выдуманную частоту невыразимой: объект с
 * `{ phrase, frequency }` её не пройдёт, и `completeStructured` попросит переделать.
 *
 * Верхняя граница длины строки — с запасом к лимиту Директа: слишком длинные фразы
 * отсеет `dedupePhrases`, чинить их вызовом модели дороже, чем выбросить.
 */
export const keywordExpansionSchema = z.object({
  phrases: z
    .array(
      z
        .string()
        .trim()
        .min(2)
        .max(DIRECT_KEYWORD_MAX_CHARS * 2),
    )
    .min(1)
    .max(600),
});

export type KeywordExpansion = z.infer<typeof keywordExpansionSchema>;

export type RunExpandAgent = (
  opts: RunAgentOptions<KeywordExpansion>,
) => Promise<AgentRun<KeywordExpansion>>;

export interface ExpandSeedOptions {
  seed: string;
  /** null для системных прогонов: бюджет LLM тогда не привязан к клиенту. */
  clientId?: string | null;
  /** Что известно о клиенте: продукт, аудитория, УТП. Уезжает в промпт как есть. */
  context?: string;
  target?: number;
  run?: RunExpandAgent;
}

export interface SeedExpansion {
  seed: string;
  /** Сырые формулировки от модели: не нормализованы и не схлопнуты. */
  phrases: string[];
  /** `keywords-expand@1.0.0` — попадает в KeywordSet и в отчёт. */
  prompt: string;
  costUsd: number | null;
  aiRunId: string | null;
}

/**
 * Seed-фраза → список формулировок (ТЗ §13.8, шаг 2).
 *
 * Задача маршрутизируется как `keywords.expand`, то есть уходит на дешёвую массовую
 * модель: здесь нужен объём и знание языка, а не рассуждение. Ставить сюда Opus —
 * платить в тридцать раз больше за список синонимов.
 */
export async function expandSeed(options: ExpandSeedOptions): Promise<SeedExpansion> {
  const seed = options.seed.trim();
  if (seed === '') {
    throw new Error('expandSeed: seed phrase is empty');
  }

  const target = options.target ?? DEFAULT_EXPANSION_TARGET;
  const prompt = loadPrompt('keywords-expand', {
    seed,
    target,
    maxWords: DIRECT_KEYWORD_MAX_WORDS,
    context: options.context?.trim() || 'Дополнительных сведений нет.',
  });

  const run = options.run ?? (runAgent as RunExpandAgent);
  const result = await run({
    agent: KEYWORDS_AGENT,
    task: 'keywords.expand',
    clientId: options.clientId ?? null,
    system: prompt.text,
    messages: `Собери около ${target} формулировок для seed-фразы «${seed}».`,
    schema: keywordExpansionSchema,
    schemaName: 'keyword-expansion',
  });

  log.info(
    { seed, returned: result.data.phrases.length, target, costUsd: result.costUsd },
    'seed expanded',
  );

  return {
    seed,
    phrases: result.data.phrases,
    prompt: `${prompt.name}@${prompt.version}`,
    costUsd: result.costUsd,
    aiRunId: result.aiRunId,
  };
}
