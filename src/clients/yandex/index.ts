/**
 * Клиент Яндекс Директ API v5 (EPIC-01).
 *
 * Точка входа для остального кода — адаптер: он реализует ChannelAdapter и
 * прячет units, очереди и асинхронные отчёты. Низкоуровневые модули экспортируются
 * для сценариев, где нужен прямой доступ (CLI, миграции, отладка в sandbox).
 */
export { YandexDirectAdapter, yandexDirectAdapter, type YandexAdapterOptions } from '@/clients/yandex/adapter.js';
export {
  buildAuthHeaders,
  buildAuthorizeUrl,
  ensureFreshCredentials,
  exchangeCodeForToken,
  isTokenNearExpiry,
  parseCredentials,
  prismaCredentialStore,
  refreshAccessToken,
  yandexCredentialsSchema,
  type CredentialStore,
  type YandexCredentials,
} from '@/clients/yandex/auth.js';
export {
  classifyErrorCode,
  mapHttpStatus,
  mapYandexError,
  shouldRetryYandex,
  YandexErrorCode,
  YANDEX_CHANNEL,
  type YandexErrorBehaviour,
} from '@/clients/yandex/errors.js';
export {
  createAxiosTransport,
  getKnownUnits,
  MAX_CONCURRENT_REQUESTS,
  MAX_REPORTS_IN_QUEUE,
  parseUnitsHeader,
  resetYandexRuntimeState,
  YandexHttpClient,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type UnitsLedgerWriter,
  type UnitsSnapshot,
} from '@/clients/yandex/http.js';
export {
  getAdGroups,
  getAds,
  getCampaigns,
  getKeywords,
  getSelfClient,
  MAX_PAGE_LIMIT,
} from '@/clients/yandex/entities.js';
export {
  fetchReport,
  parseReportTsv,
  reportNumber,
  splitTsvLine,
  type ParsedReport,
  type ReportSpec,
  type YandexReportType,
} from '@/clients/yandex/reports.js';
export {
  addCampaignNegativeKeywords,
  resume,
  setCampaignNegativeKeywords,
  setKeywordBids,
  suspend,
  updateAds,
  updateCampaigns,
  type ActionSummary,
  type AdTextUpdate,
  type CampaignUpdate,
  type KeywordBidUpdate,
} from '@/clients/yandex/writes.js';
export { fromMicros, toMicros } from '@/clients/yandex/schemas.js';
