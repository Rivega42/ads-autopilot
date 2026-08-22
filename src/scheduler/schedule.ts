/**
 * Имена задач и их расписание — отдельно от самих очередей.
 *
 * Файл намеренно не импортирует ничего: расписание нужно не только планировщику.
 * Тревоги, например, выводят глубину выборки из периода собственного крона —
 * константа, живущая отдельно от расписания, разъедется при первой же его правке.
 * Тянуть ради двух объектов `bullmq` и клиент Redis в модуль, который ни с тем ни
 * с другим не работает, — цена, которой платить незачем.
 */

/** Имена очередей = имена задач из TZ §3.4. Держим в одном месте, чтобы не расходились строки. */
export const QUEUE_NAMES = {
  fetchStats: 'fetch-stats-hourly',
  checkModeration: 'check-moderation',
  optimizeBids: 'optimize-bids',
  pauseLosers: 'pause-losers',
  wordstatMine: 'wordstat-mine',
  evaluateAbTests: 'evaluate-ab-tests',
  dailyReport: 'daily-report',
  weeklyReport: 'weekly-report',
  refreshTokens: 'refresh-tokens',
  expireApprovals: 'expire-approvals',
  alertScan: 'alert-scan',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Крон в МСК. BullMQ понимает tz, поэтому серверное время не важно.
 * Расписание — из TZ §3.4.
 */
export const CRON_SCHEDULE: Record<QueueName, string | null> = {
  [QUEUE_NAMES.fetchStats]: '0 * * * *',
  [QUEUE_NAMES.checkModeration]: '*/30 * * * *',
  [QUEUE_NAMES.optimizeBids]: '0 8 * * *',
  [QUEUE_NAMES.pauseLosers]: '0 3 * * *',
  [QUEUE_NAMES.wordstatMine]: '0 4 */3 * *',
  // Раз в сутки: решение принимается по накопленным показам, за час они картину не
  // меняют. В 5:00 — уже после ночного сбора статистики и до утреннего отчёта в 8:30,
  // чтобы карточка про победителя не пришла клиенту раньше цифр, из которых она выросла.
  [QUEUE_NAMES.evaluateAbTests]: '0 5 * * *',
  [QUEUE_NAMES.dailyReport]: '30 8 * * *',
  [QUEUE_NAMES.weeklyReport]: '0 10 * * 1',
  [QUEUE_NAMES.refreshTokens]: '0 */4 * * *',
  [QUEUE_NAMES.expireApprovals]: '*/5 * * * *',
  [QUEUE_NAMES.alertScan]: '*/5 * * * *',
};
