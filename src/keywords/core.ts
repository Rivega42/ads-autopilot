import {
  clusterPhrases,
  type ClusteringResult,
  type EmbeddingProvider,
  type PhraseCluster,
} from '@/keywords/cluster.js';
import { expandSeed, type RunExpandAgent } from '@/keywords/expand.js';
import {
  fetchFrequencies,
  unavailableFrequencySource,
  type FrequencySource,
} from '@/keywords/frequency.js';
import {
  findDictionaryNegatives,
  selectNegatives,
  suggestNegatives,
  type NegativeCandidate,
  type RunNegativesAgent,
} from '@/keywords/negatives.js';
import { dedupePhrases, type RejectedPhrase } from '@/keywords/normalise.js';
import {
  saveKeywordSet,
  KEYWORD_CORE_FORMAT,
  type KeywordSetStore,
  type StoredKeywordCore,
  type StoredPhrase,
} from '@/keywords/store.js';
import { logger } from '@/logger.js';

const log = logger.child({ scope: 'keywords:core' });

/**
 * Сборка семантического ядра (ТЗ §13.8) целиком: seed → формулировки → частоты →
 * кластеры → минус-слова → снимок в БД.
 *
 * Разделение труда такое же, как у планировщика кампаний: модель отвечает за язык,
 * код — за цифры и лимиты. Ни одна частота в результате не может прийти от модели —
 * только из `FrequencySource` или `null`.
 */

/**
 * Порог отсечения по частоте (E14.06: «фразы с прогнозом < 5 показов/мес отсеиваются»).
 * Применяется, только когда частоты реально получены: без данных отсекать нечем, и
 * трактовать «неизвестно» как ноль означало бы выбросить всё ядро.
 */
export const MIN_MONTHLY_IMPRESSIONS = 5;

export interface KeywordCore {
  clientId: string | null;
  seed: string;
  generatedAt: string;
  phrases: StoredPhrase[];
  clusters: PhraseCluster[];
  clustering: Pick<ClusteringResult, 'method' | 'degraded' | 'note'>;
  negatives: NegativeCandidate[];
  frequencies: { available: boolean; source: string; requests: number; phrasesRequested: number };
  /** Фразы, не прошедшие лимиты Директа (в первую очередь — больше семи слов). */
  rejected: RejectedPhrase[];
  /** Сколько запросов к API частот сэкономила дедупликация. */
  duplicates: number;
  /** Отсеяно по нижней границе частоты. Ноль, когда частот нет. */
  lowVolume: number;
  prompts: string[];
  /** id строки KeywordSet; null, если сохранение не запрашивали. */
  keywordSetId: string | null;
}

export interface BuildKeywordCoreOptions {
  seed: string;
  clientId?: string | null;
  /** Описание клиента для промптов: продукт, аудитория, УТП. */
  context?: string;
  /** Готовые формулировки вместо вызова модели. Нужны пересборке и офлайн-прогонам. */
  phrases?: readonly string[];
  target?: number;
  /** Поисковые запросы для предиктивных минус-слов. */
  searchQueries?: readonly string[];
  frequencySource?: FrequencySource;
  regionIds?: readonly number[];
  minImpressions?: number;
  embeddings?: EmbeddingProvider | null;
  maxClusters?: number;
  maxNegatives?: number;
  /** false — модель для минус-слов не зовём, обходимся словарём. */
  useModelNegatives?: boolean;
  runExpand?: RunExpandAgent;
  runNegatives?: RunNegativesAgent;
  /** Передан — снимок сохраняется в KeywordSet. */
  db?: KeywordSetStore;
  now?: () => Date;
}

export async function buildKeywordCore(options: BuildKeywordCoreOptions): Promise<KeywordCore> {
  const now = options.now ?? ((): Date => new Date());
  const seed = options.seed.trim();
  const clientId = options.clientId ?? null;
  const prompts: string[] = [];

  const raw = options.phrases ?? (await expandViaModel(options, prompts));

  // Шаг 1. Схлопывание. Обязательно до частот: каждая группа — один запрос в API,
  // и сорок переставленных формулировок одной фразы стоили бы сорок запросов.
  const deduped = dedupePhrases(raw);

  // Шаг 2. Частоты. Только из источника — модель к этим числам не прикасается.
  const source = options.frequencySource ?? unavailableFrequencySource;
  const lookup = await fetchFrequencies(
    source,
    deduped.groups,
    options.regionIds ? { regionIds: options.regionIds } : {},
  );

  const minImpressions = options.minImpressions ?? MIN_MONTHLY_IMPRESSIONS;
  const kept = deduped.groups.filter((group) => {
    if (!lookup.available) return true;
    const frequency = lookup.byKey.get(group.key);
    // null — «частота неизвестна». Оставляем: отсутствие данных не доказывает отсутствие спроса.
    return frequency === null || frequency === undefined || frequency >= minImpressions;
  });
  const lowVolume = deduped.groups.length - kept.length;

  // Шаг 3. Кластеризация. Метод и его слабость едут в результат, а не теряются в логе.
  const clustering = await clusterPhrases(
    kept.map((group) => group.phrase),
    {
      provider: options.embeddings ?? null,
      ...(options.maxClusters === undefined ? {} : { maxClusters: options.maxClusters }),
    },
  );

  const clusterByPhrase = new Map<string, number>();
  for (const cluster of clustering.clusters) {
    for (const phrase of cluster.phrases) clusterByPhrase.set(phrase, cluster.id);
  }

  const phrases: StoredPhrase[] = kept.map((group) => ({
    phrase: group.phrase,
    key: group.key,
    frequency: lookup.byKey.get(group.key) ?? null,
    clusterId: clusterByPhrase.get(group.phrase) ?? 0,
    variants: group.variants,
  }));

  // Шаг 4. Минус-слова: сначала бесплатный словарь, затем — если разрешено — модель.
  const corePhrases = phrases.map((item) => item.phrase);
  const searchQueries = options.searchQueries ?? [];
  const candidates: NegativeCandidate[] = findDictionaryNegatives(searchQueries);

  if (options.useModelNegatives !== false) {
    try {
      candidates.push(
        ...(await suggestNegatives({
          clientId,
          ...(options.context === undefined ? {} : { context: options.context }),
          phrases: corePhrases,
          queries: searchQueries,
          ...(options.maxNegatives === undefined ? {} : { limit: options.maxNegatives }),
          ...(options.runNegatives === undefined ? {} : { run: options.runNegatives }),
        })),
      );
      prompts.push('keywords-negatives@1.0.0');
    } catch (err) {
      // Ядро без предложенных моделью минус-слов лучше, чем отсутствие ядра:
      // словарный проход уже дал самое очевидное.
      log.warn({ err: String(err), seed }, 'negative suggestion failed, keeping dictionary only');
    }
  }

  const selected = selectNegatives({
    candidates,
    protectedPhrases: corePhrases,
    ...(options.maxNegatives === undefined ? {} : { limit: options.maxNegatives }),
  });

  const core: KeywordCore = {
    clientId,
    seed,
    generatedAt: now().toISOString(),
    phrases,
    clusters: clustering.clusters,
    clustering: {
      method: clustering.method,
      degraded: clustering.degraded,
      note: clustering.note,
    },
    negatives: selected.negatives,
    frequencies: {
      available: lookup.available,
      source: lookup.source,
      requests: lookup.requests,
      phrasesRequested: lookup.phrasesRequested,
    },
    rejected: deduped.rejected,
    duplicates: deduped.duplicates,
    lowVolume,
    prompts,
    keywordSetId: null,
  };

  if (options.db && clientId !== null) {
    core.keywordSetId = await saveKeywordSet(options.db, {
      clientId,
      seed,
      core: toStored(core),
      negatives: core.negatives,
    });
  }

  log.info(
    {
      seed,
      clientId,
      input: deduped.input,
      phrases: phrases.length,
      duplicates: deduped.duplicates,
      rejected: deduped.rejected.length,
      lowVolume,
      clusters: clustering.clusters.length,
      clustering: clustering.method,
      negatives: selected.negatives.length,
      apiRequests: lookup.requests,
    },
    'keyword core built',
  );

  return core;
}

/** Снимок для колонки `KeywordSet.phrases`. */
export function toStored(core: KeywordCore): StoredKeywordCore {
  return {
    format: KEYWORD_CORE_FORMAT,
    generatedAt: core.generatedAt,
    items: core.phrases,
    clusters: core.clusters,
    clustering: core.clustering,
    frequencies: core.frequencies,
    rejected: core.rejected,
    duplicates: core.duplicates,
    prompts: core.prompts,
  };
}

async function expandViaModel(
  options: BuildKeywordCoreOptions,
  prompts: string[],
): Promise<string[]> {
  const expansion = await expandSeed({
    seed: options.seed,
    clientId: options.clientId ?? null,
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.runExpand === undefined ? {} : { run: options.runExpand }),
  });
  prompts.push(expansion.prompt);
  return expansion.phrases;
}
