/**
 * AI-Wordstat — семантическое ядро (ТЗ §13.8).
 *
 * Пайплайн: seed-фраза → ~200 формулировок от модели → нормализация и схлопывание →
 * частоты из Wordstat → кластеризация → предиктивные минус-слова → снимок `KeywordSet`.
 *
 * Два места, где модуль намеренно говорит «не знаю» вместо правдоподобного числа:
 *  • частоты берутся только из `FrequencySource`; модель их не видит и не выдумывает;
 *  • кластеризация без провайдера эмбеддингов помечается `degraded: true`.
 *
 * Для крона `wordstat-mine` наружу торчит `runWeeklyKeywordRefresh`.
 */
export {
  clusterPhrases,
  cosineSimilarity,
  lexicalSimilarity,
  resolveEmbeddingProvider,
  CLUSTER_THRESHOLDS,
  MAX_CLUSTERS,
  type ClusteringMethod,
  type ClusteringResult,
  type ClusterPhrasesOptions,
  type EmbeddingProvider,
  type PhraseCluster,
} from '@/keywords/cluster.js';
export {
  buildKeywordCore,
  toStored,
  MIN_MONTHLY_IMPRESSIONS,
  type BuildKeywordCoreOptions,
  type KeywordCore,
} from '@/keywords/core.js';
export {
  expandSeed,
  keywordExpansionSchema,
  DEFAULT_EXPANSION_TARGET,
  KEYWORDS_AGENT,
  type ExpandSeedOptions,
  type KeywordExpansion,
  type RunExpandAgent,
  type SeedExpansion,
} from '@/keywords/expand.js';
export {
  fetchFrequencies,
  frequencyOf,
  unavailableFrequencySource,
  FrequencyUnavailableError,
  MAX_PHRASES_PER_FREQUENCY_REQUEST,
  type FetchFrequenciesOptions,
  type FrequencyLookup,
  type FrequencyRequest,
  type FrequencySource,
  type PhraseFrequency,
} from '@/keywords/frequency.js';
export {
  findDictionaryNegatives,
  negativeSuggestionSchema,
  protectedStems,
  selectNegatives,
  suggestNegatives,
  suppressesProtected,
  MAX_NEGATIVES_PER_GROUP,
  NEGATIVE_MARKERS,
  type NegativeCandidate,
  type NegativeSource,
  type NegativeSuggestion,
  type RunNegativesAgent,
  type SelectedNegatives,
  type SelectNegativesOptions,
  type SuggestNegativesOptions,
} from '@/keywords/negatives.js';
export {
  canonicalKey,
  dedupePhrases,
  normalisePhrase,
  significantWords,
  stripOperators,
  KEYWORD_STOP_WORDS,
  type DedupeResult,
  type PhraseGroup,
  type RejectedPhrase,
  type RejectionReason,
} from '@/keywords/normalise.js';
export {
  listRefreshTargets,
  runWeeklyKeywordRefresh,
  REFRESH_WINDOW_DAYS,
  type ClientRefreshResult,
  type KeywordRefreshFailure,
  type KeywordRefreshStore,
  type KeywordRefreshSummary,
  type RunKeywordRefreshOptions,
} from '@/keywords/refresh.js';
export {
  latestKeywordSet,
  saveKeywordSet,
  writeNegativeKeywords,
  KEYWORD_CORE_FORMAT,
  type KeywordSetStore,
  type LatestKeywordSet,
  type NegativeKeywordStore,
  type SaveKeywordSetInput,
  type StoredKeywordCore,
  type StoredPhrase,
  type WriteNegativesOptions,
  type WriteNegativesResult,
} from '@/keywords/store.js';
