/**
 * Публичный фасад загрузки данных из рекламных кабинетов (issue #6).
 *
 * Наружу торчат три сценария:
 *  • `runIngestion` — крон `fetch-stats-hourly`: сущности, статистика, конверсии;
 *  • `runSearchQueryIngestion` — крон `wordstat-mine`: поисковые запросы;
 *  • `refreshExpiringTokens` — крон `refresh-tokens`.
 */
export { resolveDeps, type IngestionDeps } from '@/ingestion/deps.js';
export { describeFailure, recordFailure, type IngestionFailure } from '@/ingestion/errors.js';
export { syncEntities, type EntitySyncResult, type LevelSyncCount } from '@/ingestion/entities.js';
export {
  syncStats,
  STAT_LEVELS,
  type LevelStatsResult,
  type StatsSyncResult,
  type SyncStatsOptions,
} from '@/ingestion/stats.js';
export {
  syncSearchQueries,
  type SearchQuerySyncResult,
  type SyncSearchQueriesOptions,
} from '@/ingestion/search-queries.js';
export {
  directCampaignId,
  readMetrikaSettings,
  syncMetrikaConversions,
  type MetrikaSettings,
  type MetrikaSource,
  type MetrikaSyncResult,
} from '@/ingestion/metrika.js';
export { refreshExpiringTokens, type TokenRefreshResult } from '@/ingestion/tokens.js';
export {
  listIngestionTargets,
  runIngestion,
  runSearchQueryIngestion,
  type IngestionRunSummary,
  type IngestionTarget,
  type RunIngestionOptions,
  type SearchQueryRunSummary,
} from '@/ingestion/run.js';
export { trailingWindowMsk, ymdToDateColumn, STATS_WINDOW_DAYS } from '@/ingestion/window.js';
