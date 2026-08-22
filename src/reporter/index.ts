/**
 * Отчёты и алерты (issue #7, ТЗ §3.4, §9.2, §13.6).
 *
 * Наружу торчат три сценария для планировщика:
 *  • `runDailyReports`  — крон `daily-report`, 08:30 МСК;
 *  • `runWeeklyReports` — крон `weekly-report`, понедельник;
 *  • `runAlertScan`     — частый крон: всплеск ошибок, 401, units, расход.
 *
 * Всё остальное экспортируется ради тестов, дашборда и команды `/report`.
 */
export {
  cronIntervalMinutes,
  detectAlerts,
  renderAlert,
  runAlertScan,
  ALERT_SCAN_INTERVAL_MINUTES,
  ERROR_BURST_THRESHOLD,
  ERROR_LOOKBACK_JITTER_MINUTES,
  ERROR_LOOKBACK_MINUTES,
  ERROR_LOOKBACK_OVERLAP_MINUTES,
  ERROR_WINDOW_MINUTES,
  MAX_ALERTS_PER_RUN,
  MAX_ERROR_ROWS,
  PROVIDER_BURST_MIN_CLIENTS,
  PROVIDER_BURST_THRESHOLD,
  SPEND_ALERT_COOLDOWN_MS,
  SPEND_BASELINE_DAYS,
  SPEND_SCAN_INTERVAL_MS,
  type Alert,
  type AlertKind,
  type AlertOptions,
  type AlertRunSummary,
  type AlertSeverity,
} from '@/reporter/alerts.js';
export {
  detectAnomalies,
  detectSpendOutlier,
  DEFAULT_THRESHOLDS,
  type Anomaly,
  type AnomalyKind,
  type AnomalySeverity,
  type AnomalyThresholds,
  type SpendOutlier,
} from '@/reporter/anomalies.js';
export {
  spendLeadsChartUrl,
  MAX_CHART_POINTS,
  MAX_CHART_URL_LENGTH,
  type ChartOptions,
} from '@/reporter/chart.js';
export {
  buildDailyReport,
  renderDaily,
  runDailyReports,
  sendDailyReport,
  CHART_DAYS,
  DAILY_THRESHOLDS,
  NO_DATA_NOTE,
  PROVISIONAL_NOTE,
  type DailyReportContent,
  type DailyReportOptions,
  type DailyReportOutcome,
  type DailyRunSummary,
} from '@/reporter/daily.js';
export { resolveDeps, type ReporterDb, type ReporterDeps } from '@/reporter/deps.js';
export {
  describeFailure,
  recordFailure,
  ReportDeliveryError,
  type ReportFailure,
} from '@/reporter/errors.js';
export {
  activeCampaigns,
  attributionNote,
  bySpendDesc,
  collectPeriodMetrics,
  compareTotals,
  coverageNote,
  emptyCoverage,
  indexByCampaign,
  type CampaignMetrics,
  type DailyPoint,
  type MetricTotals,
  type PeriodCoverage,
  type PeriodMetrics,
  type TotalsComparison,
} from '@/reporter/metrics.js';
export {
  eachDay,
  formatPeriod,
  lastWeekPeriod,
  periodDays,
  periodFilter,
  previousPeriod,
  shiftYmd,
  trailingPeriod,
  yesterdayPeriod,
  type ReportPeriod,
} from '@/reporter/period.js';
export { alertLimiter, CooldownLimiter, DEFAULT_COOLDOWN_MS } from '@/reporter/rate-limit.js';
export { listReportRecipients, type ReportRecipient } from '@/reporter/recipients.js';
export {
  findReport,
  markReportSent,
  saveReport,
  toJsonObject,
  type StoredReport,
} from '@/reporter/store.js';
export {
  clampMarkdown,
  createApiReportMessenger,
  getReportMessenger,
  setReportMessenger,
  TELEGRAM_MESSAGE_LIMIT,
  type ReportMessenger,
  type SendOptions,
  type SendResult,
} from '@/reporter/telegram.js';
export {
  buildWeeklyFacts,
  buildWeeklyReport,
  renderWeekly,
  runWeeklyReports,
  sendWeeklyReport,
  weeklyReviewSchema,
  WEEKLY_AGENT_NAME,
  type RunWeeklyReview,
  type WeeklyFacts,
  type WeeklyReportContent,
  type WeeklyReportOptions,
  type WeeklyReportOutcome,
  type WeeklyReview,
  type WeeklyReviewStatus,
  type WeeklyRunSummary,
} from '@/reporter/weekly.js';
export { WEEKLY_PROMPT_VERSION, WEEKLY_SYSTEM_PROMPT } from '@/reporter/weekly-prompt.js';
