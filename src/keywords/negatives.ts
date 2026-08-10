import { z } from 'zod';

import { loadPrompt } from '@/ai/prompt-loader.js';
import { DIRECT_KEYWORD_MAX_WORDS, isValidKeyword } from '@/campaigns/limits.js';
import { runAgent, type AgentRun, type RunAgentOptions } from '@/clients/llm/index.js';
import { KEYWORDS_AGENT } from '@/keywords/expand.js';
import {
  canonicalKey,
  crudeStem,
  normalisePhrase,
  significantWords,
} from '@/keywords/normalise.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'keywords:negatives' });

/**
 * Предиктивные минус-слова (ТЗ §13.8, шаг 6: «пишет минус-слова заранее»).
 *
 * Отличие от правила `add-negative-keyword` в оптимизаторе: то правило реактивное —
 * оно ждёт, пока запрос наберёт больше пяти кликов с CTR ниже 0.5%, то есть пока
 * клиент заплатит за доказательство. Здесь порогов по расходу нет: «реферат» и
 * «вакансии» не станут покупателями ни при каком CTR, и отсекать их надо до первого
 * показа. Два механизма не конфликтуют — они работают на разных горизонтах.
 *
 * Оба пути пишут одно и то же: строки `Keyword` с `matchType: NEGATIVE`.
 */

export type NegativeSource = 'dictionary' | 'model';

export interface NegativeCandidate {
  /** Нормализованное минус-слово или короткая фраза. */
  phrase: string;
  /** Человекочитаемое обоснование: уезжает в ChangeLog и в карточку апрува. */
  reason: string;
  source: NegativeSource;
  /** Запросы, в которых оно встретилось. Пусто у чисто предиктивных предложений модели. */
  queries: string[];
}

interface NegativeMarker {
  /** Слово или фраза в нормализованном виде. */
  marker: string;
  reason: string;
}

/**
 * Словарь заведомо нецелевых маркеров.
 *
 * Правило отбора было одно: слово попадает сюда, только если оно нецелевое в любой
 * нише. Поэтому здесь нет «отзывов» (горячий спрос), «цены» (горячий спрос) и
 * «работы» — «работа с возражениями» и «работа с текстом» вполне себе коммерческие
 * запросы, а одно неудачное минус-слово выключает больше трафика, чем десять удачных
 * экономят.
 *
 * Список — умолчание: `findDictionaryNegatives` принимает свой набор маркеров.
 */
export const NEGATIVE_MARKERS: readonly NegativeMarker[] = [
  { marker: 'бесплатно', reason: 'ищут бесплатное' },
  { marker: 'бесплатный', reason: 'ищут бесплатное' },
  { marker: 'бесплатные', reason: 'ищут бесплатное' },
  { marker: 'даром', reason: 'ищут бесплатное' },
  { marker: 'халява', reason: 'ищут бесплатное' },
  { marker: 'скачать', reason: 'ищут файл, а не услугу' },
  { marker: 'торрент', reason: 'ищут пиратскую копию' },
  { marker: 'вакансии', reason: 'ищут работу, а не услугу' },
  { marker: 'вакансия', reason: 'ищут работу, а не услугу' },
  { marker: 'резюме', reason: 'ищут работу, а не услугу' },
  { marker: 'зарплата', reason: 'ищут работу, а не услугу' },
  { marker: 'подработка', reason: 'ищут работу, а не услугу' },
  { marker: 'реферат', reason: 'учебная работа' },
  { marker: 'курсовая', reason: 'учебная работа' },
  { marker: 'дипломная', reason: 'учебная работа' },
  { marker: 'своими руками', reason: 'сделают сами, не купят' },
  { marker: 'самостоятельно', reason: 'сделают сами, не купят' },
  { marker: 'википедия', reason: 'информационный спрос' },
  { marker: 'вики', reason: 'информационный спрос' },
  { marker: 'что такое', reason: 'информационный спрос' },
  { marker: 'своими силами', reason: 'сделают сами, не купят' },
];

/** Сколько минус-слов имеет смысл держать на группу. Больше — режем живой спрос. */
export const MAX_NEGATIVES_PER_GROUP = 50;

function matchesMarker(query: string, marker: string): boolean {
  const normalised = normalisePhrase(query);
  if (normalised === '') return false;
  if (marker.includes(' ')) return ` ${normalised} `.includes(` ${marker} `);
  return normalised.split(' ').includes(marker);
}

/**
 * Словарный проход по поисковым запросам. Ноль вызовов модели, ноль баллов API —
 * это первый и самый дешёвый фильтр, и он же самый предсказуемый.
 */
export function findDictionaryNegatives(
  queries: Iterable<string>,
  markers: readonly NegativeMarker[] = NEGATIVE_MARKERS,
): NegativeCandidate[] {
  const hits = new Map<string, NegativeCandidate>();

  for (const query of queries) {
    for (const { marker, reason } of markers) {
      if (!matchesMarker(query, marker)) continue;
      const existing = hits.get(marker);
      if (existing === undefined) {
        hits.set(marker, { phrase: marker, reason, source: 'dictionary', queries: [query] });
      } else if (!existing.queries.includes(query)) {
        existing.queries.push(query);
      }
    }
  }

  return [...hits.values()];
}

export const negativeSuggestionSchema = z.object({
  negatives: z
    .array(
      z.object({
        phrase: z.string().trim().min(2).max(100),
        reason: z.string().trim().min(3).max(200),
      }),
    )
    .max(100),
});

export type NegativeSuggestion = z.infer<typeof negativeSuggestionSchema>;

export type RunNegativesAgent = (
  opts: RunAgentOptions<NegativeSuggestion>,
) => Promise<AgentRun<NegativeSuggestion>>;

export interface SuggestNegativesOptions {
  clientId?: string | null;
  context?: string;
  /** Ключевые фразы ядра: модель обязана их видеть, чтобы не заминусовать саму рекламу. */
  phrases: readonly string[];
  queries: readonly string[];
  limit?: number;
  run?: RunNegativesAgent;
}

/**
 * Второй проход — модель. Задача маршрутизируется как `keywords.classify`, то есть
 * уходит на дешёвую модель: это классификация «целевое / нецелевое», а не рассуждение.
 */
export async function suggestNegatives(
  options: SuggestNegativesOptions,
): Promise<NegativeCandidate[]> {
  const limit = options.limit ?? MAX_NEGATIVES_PER_GROUP;
  if (options.queries.length === 0 && options.phrases.length === 0) return [];

  const prompt = loadPrompt('keywords-negatives', {
    context: options.context?.trim() || 'Дополнительных сведений нет.',
    phrases: bulletList(options.phrases),
    queries: bulletList(options.queries),
    limit,
    maxWords: DIRECT_KEYWORD_MAX_WORDS,
  });

  const run = options.run ?? (runAgent as RunNegativesAgent);
  const result = await run({
    agent: KEYWORDS_AGENT,
    task: 'keywords.classify',
    clientId: options.clientId ?? null,
    system: prompt.text,
    messages: 'Верни минус-слова по правилам выше.',
    schema: negativeSuggestionSchema,
    schemaName: 'keyword-negatives',
  });

  log.info(
    { suggested: result.data.negatives.length, queries: options.queries.length },
    'negatives suggested',
  );

  return result.data.negatives.map((item) => ({
    phrase: item.phrase,
    reason: item.reason,
    source: 'model' as const,
    queries: [],
  }));
}

export interface SelectNegativesOptions {
  candidates: readonly NegativeCandidate[];
  /** Ключевые фразы ядра. Минус-слово, попадающее в них, отбрасывается. */
  protectedPhrases: readonly string[];
  limit?: number;
}

export interface SelectedNegatives {
  negatives: NegativeCandidate[];
  /** Отброшенные кандидаты с причиной. Полезно в отчёте: видно, что предложила модель. */
  dropped: Array<{ phrase: string; reason: 'self-harm' | 'invalid' | 'duplicate' | 'over-limit' }>;
}

/**
 * Финальный фильтр перед записью.
 *
 * Самая дорогая ошибка здесь — минус-слово, слова которого целиком лежат внутри
 * ключевой фразы клиента: Директ в этом случае просто перестанет показывать
 * объявление по собственному ключу, и найти причину падения трафика будет нечем.
 * Поэтому пересечение с ядром проверяется всегда, независимо от источника кандидата.
 */
export function selectNegatives(options: SelectNegativesOptions): SelectedNegatives {
  const limit = options.limit ?? MAX_NEGATIVES_PER_GROUP;
  // Сравнение по основам, а не по словоформам: Директ минусует по лемме, и
  // минус-слово «английский» выключит ключ «курсы английского» ровно так же.
  const protectedSets = options.protectedPhrases.map(
    (phrase) => new Set(significantWords(phrase).map(crudeStem)),
  );

  const negatives: NegativeCandidate[] = [];
  const dropped: SelectedNegatives['dropped'] = [];
  const seen = new Set<string>();

  for (const candidate of options.candidates) {
    const phrase = normalisePhrase(candidate.phrase);
    if (!isValidKeyword(phrase)) {
      dropped.push({ phrase: candidate.phrase, reason: 'invalid' });
      continue;
    }

    const key = canonicalKey(phrase);
    if (seen.has(key)) {
      dropped.push({ phrase: candidate.phrase, reason: 'duplicate' });
      continue;
    }

    const words = significantWords(phrase).map(crudeStem);
    if (protectedSets.some((set) => words.every((word) => set.has(word)))) {
      dropped.push({ phrase: candidate.phrase, reason: 'self-harm' });
      continue;
    }

    if (negatives.length >= limit) {
      dropped.push({ phrase: candidate.phrase, reason: 'over-limit' });
      continue;
    }

    seen.add(key);
    negatives.push({ ...candidate, phrase });
  }

  return { negatives, dropped };
}

function bulletList(items: readonly string[]): string {
  if (items.length === 0) return '(пусто)';
  return items.map((item) => `- ${item}`).join('\n');
}
