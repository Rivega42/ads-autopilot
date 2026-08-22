/**
 * Имена задач, их расписание и период между запусками — отдельно от самих очередей.
 *
 * Файл намеренно не импортирует ничего: расписание нужно не только планировщику.
 * Тревоги выводят из периода своего крона глубину выборки, модерация — срок
 * зависшего захвата и отступ после упавшей починки; константа, живущая отдельно от
 * расписания, разъезжается с ним при первой же правке и молча. Поэтому `cronIntervalMinutes`
 * живёт здесь, рядом с `CRON_SCHEDULE`, а не в модуле, которому она понадобилась первой:
 * иначе выходит, что модерация зависит от отчётов. Тянуть ради двух объектов `bullmq` и
 * клиент Redis в модуль, который ни с тем ни с другим не работает, — цена, которой платить
 * незачем.
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

/**
 * Период крона в минутах: наибольший разрыв между соседними запусками.
 *
 * Разобраны расписания, которые ходят внутри часа, — краткие кроны именно такие.
 * Всё остальное считаем часовым: занизить период нельзя (из него выводят глубину
 * выборки и сроки жизни захватов, а заниженный период возвращает слепую зону и режет
 * чужую работу на ходу), а завысить безопасно — лишний период стоит только задержки.
 */
export function cronIntervalMinutes(expression: string | null): number {
  const HOUR_MINUTES = 60;
  if (expression === null) return HOUR_MINUTES;

  const fields = expression.trim().split(/\s+/);
  const [minuteField, ...rest] = fields;
  if (minuteField === undefined || rest.length !== 4 || rest.some((field) => field !== '*')) {
    return HOUR_MINUTES;
  }

  const minutes = expandCronMinutes(minuteField);
  if (minutes.length === 0) return HOUR_MINUTES;

  const firstMinute = minutes[0] as number;
  const lastMinute = minutes[minutes.length - 1] as number;
  let gap = firstMinute + HOUR_MINUTES - lastMinute;
  for (let i = 1; i < minutes.length; i += 1) {
    gap = Math.max(gap, (minutes[i] as number) - (minutes[i - 1] as number));
  }
  return Math.min(gap, HOUR_MINUTES);
}

/** Минутное поле крона в список минут часа. Непонятное поле — пустой список. */
function expandCronMinutes(field: string): number[] {
  const minutes = new Set<number>();

  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    if (range === undefined) return [];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return [];

    let from = 0;
    let to = 59;
    if (range !== '*') {
      const [fromText, toText] = range.split('-');
      from = Number(fromText);
      to = toText === undefined ? from : Number(toText);
      if (!Number.isInteger(from) || !Number.isInteger(to)) return [];
      if (from < 0 || to > 59 || from > to) return [];
    }
    for (let minute = from; minute <= to; minute += step) minutes.add(minute);
  }

  return [...minutes].sort((a, b) => a - b);
}
