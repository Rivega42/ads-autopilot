import { ReportKind } from '@prisma/client';

import { STATS_WINDOW_DAYS } from '@/ingestion/window.js';
import { logger } from '@/logger.js';
import {
  detectAnomalies,
  DEFAULT_THRESHOLDS,
  type Anomaly,
  type AnomalyThresholds,
} from '@/reporter/anomalies.js';
import { spendLeadsChartUrl } from '@/reporter/chart.js';
import { resolveDeps, type ReporterDeps } from '@/reporter/deps.js';
import { describeFailure, recordFailure, ReportDeliveryError } from '@/reporter/errors.js';
import {
  formatInt,
  formatMoney,
  formatPctChange,
  formatRatio,
  trendArrow,
  truncate,
} from '@/reporter/format.js';
import { md, mdBold, mdEscape, mdJoin, mdLink, type Markdown } from '@/reporter/markdown.js';
import {
  activeCampaigns,
  attributionNote,
  bySpendDesc,
  collectPeriodMetrics,
  compareTotals,
  coverageNote,
  type PeriodMetrics,
} from '@/reporter/metrics.js';
import {
  formatPeriod,
  previousPeriod,
  shiftYmd,
  yesterdayPeriod,
  type ReportPeriod,
} from '@/reporter/period.js';
import { listReportRecipients, type ReportRecipient } from '@/reporter/recipients.js';
import { findReport, markReportSent, saveReport, toJsonObject } from '@/reporter/store.js';
import { clampMarkdown } from '@/reporter/telegram.js';

/**
 * Дневной отчёт (`daily-report`, 08:30 МСК, ТЗ §3.4 и пункт приёмки §9.2).
 *
 * Порядок шагов важнее их содержания: посчитать → сохранить в `Report` →
 * отправить → отметить `sentAt`. Отвалившийся Telegram не должен уносить с
 * собой посчитанный отчёт, а повторный запуск того же дня обязан переиспользовать
 * сохранённый текст, а не пересчитывать его заново.
 */

const log = logger.child({ scope: 'reporter:daily' });

/** Сколько дней показываем на графике. */
export const CHART_DAYS = 14;

/** Больше пяти проблем в утреннем сообщении никто не читает. */
export const MAX_PROBLEMS = 5;

export const MAX_CAMPAIGN_ROWS = 7;

/**
 * Пороги для суток. Дневные суммы на порядок меньше недельных, поэтому общий
 * `DEFAULT_THRESHOLDS` с его 1 000 ₽ на день отсекал бы половину кампаний.
 */
export const DAILY_THRESHOLDS: AnomalyThresholds = {
  ...DEFAULT_THRESHOLDS,
  minSpend: 300,
  minImpressions: 200,
};

/** «21 день» в родительном падеже: «до 21 дня», но «до 22 дней». */
function daysGenitive(days: number): string {
  const tail = days % 100;
  return tail % 10 === 1 && tail !== 11 ? `${days} дня` : `${days} дней`;
}

/**
 * Конверсии из Метрики доезжают до 21 дня (ТЗ §2.1) — вчерашний CPA ещё
 * изменится. Отчёт обязан это проговаривать: иначе клиент считает цифру
 * окончательной и принимает по ней решения.
 */
export const PROVISIONAL_NOTE = `Конверсии из Метрики дозаезжают до ${daysGenitive(STATS_WINDOW_DAYS)} — вчерашние лиды и CPA предварительные.`;

/**
 * Текст на случай, когда за период нет ни одной строки статистики.
 *
 * Отчёт с нулями здесь недопустим: он читается как «расход обвалился до нуля»,
 * и рациональная реакция на него — остановить рекламу и звонить площадке —
 * ровно обратна нужной. Причину («не открутилось» или «не загрузилось») по
 * самим данным различить нельзя, поэтому её и не называем.
 */
export const NO_DATA_NOTE =
  'Статистики за этот период в базе нет ни по одной кампании. Это не нулевой расход: ' +
  'мы не знаем, ничего не откручивалось или не доехала загрузка, — поэтому цифр и ' +
  'сравнения с прошлым периодом ниже нет.';

export interface DailyReportContent {
  body: Markdown;
  chartUrl: string | null;
  metrics: PeriodMetrics;
  previous: PeriodMetrics;
  anomalies: Anomaly[];
}

export interface DailyReportOptions extends Partial<ReporterDeps> {
  /** Отчёт по одному клиенту вместо всех активных. */
  clientId?: string;
  /** Явный период; по умолчанию — вчерашние сутки по МСК. */
  period?: ReportPeriod;
  /** Пересчитать и отправить заново, даже если отчёт за период уже ушёл. */
  force?: boolean;
  thresholds?: AnomalyThresholds;
}

export interface DailyReportOutcome {
  clientId: string;
  period: ReportPeriod;
  reportId: string;
  sent: boolean;
  /** Текст взят из БД, а не посчитан заново: повторный запуск после сбоя доставки. */
  reused: boolean;
  skipped: 'already_sent' | null;
  chartUrl: string | null;
}

export interface DailyRunSummary {
  period: ReportPeriod;
  clients: number;
  sent: number;
  skipped: number;
  failures: Array<{ clientId: string; message: string }>;
}

/** Собирает текст отчёта. Ничего не пишет и не отправляет — так его удобно тестировать. */
export async function buildDailyReport(
  recipient: ReportRecipient,
  period: ReportPeriod,
  options: DailyReportOptions = {},
): Promise<DailyReportContent> {
  const deps = resolveDeps(options);
  const thresholds = options.thresholds ?? DAILY_THRESHOLDS;

  const current = await collectPeriodMetrics(deps.db, recipient.clientId, period);
  const previous = await collectPeriodMetrics(deps.db, recipient.clientId, previousPeriod(period));
  const chartWindow: ReportPeriod = {
    from: shiftYmd(period.to, -(CHART_DAYS - 1)),
    to: period.to,
  };
  const chartSeries = await collectPeriodMetrics(deps.db, recipient.clientId, chartWindow);

  const anomalies = detectAnomalies(current, previous, thresholds);
  // Без данных за период график — это картинка про чужие дни рядом с текстом
  // «данных нет»; ссылку не даём вовсе.
  const chartUrl = current.coverage.hasData ? spendLeadsChartUrl(chartSeries.byDate) : null;

  return {
    body: renderDaily(recipient, current, previous, anomalies, chartUrl),
    chartUrl,
    metrics: current,
    previous,
    anomalies,
  };
}

export function renderDaily(
  recipient: ReportRecipient,
  current: PeriodMetrics,
  previous: PeriodMetrics,
  anomalies: readonly Anomaly[],
  chartUrl: string | null,
): Markdown {
  const cmp = compareTotals(current.totals, previous.totals);
  const wasLabel = formatPeriod(previous.period);

  const header = md`📊 ${mdBold(`Отчёт за ${formatPeriod(current.period)}`)} — ${mdEscape(recipient.name)}`;

  if (!current.coverage.hasData) {
    return clampMarkdown(
      mdJoin([
        header,
        md``,
        md`${mdEscape(`⚠️ ${NO_DATA_NOTE}`)}`,
        md``,
        md`${mdEscape(PROVISIONAL_NOTE)}`,
      ]),
    );
  }

  // База не измерена — процент к ней был бы выдумкой, а «было 0» ложью.
  const noBase = !previous.coverage.hasData;
  const spendTail = noBase
    ? `(за ${wasLabel} данных нет)`
    : `${trendArrow(cmp.spend.changePct)} ${formatPctChange(cmp.spend.changePct)} к ${wasLabel}`;
  const leadsTail = noBase
    ? `(за ${wasLabel} данных нет)`
    : `${trendArrow(cmp.conversions.changePct)} ${formatPctChange(cmp.conversions.changePct)} (было ${formatInt(previous.totals.conversions)})`;
  const cpaTail = noBase
    ? `(за ${wasLabel} данных нет)`
    : `(было ${formatMoney(previous.totals.cpa)})`;

  const totals = [
    md`Расход: ${mdBold(formatMoney(current.totals.spend))} ${mdEscape(spendTail)}`,
    md`Лиды: ${mdBold(formatInt(current.totals.conversions))} ${mdEscape(leadsTail)}`,
    md`CPA: ${mdBold(formatMoney(current.totals.cpa))} ${mdEscape(cpaTail)}`,
    md`Клики: ${mdEscape(formatInt(current.totals.clicks))} · CTR ${mdEscape(formatRatio(current.totals.ctr))}`,
  ];

  const gaps = coverageNote(current.coverage);

  const rows = bySpendDesc(activeCampaigns(current)).slice(0, MAX_CAMPAIGN_ROWS);
  const campaigns =
    rows.length === 0
      ? [md`${mdEscape('Ни одна кампания за период не откручивалась.')}`]
      : [
          md`${mdBold('По кампаниям')}`,
          ...rows.map(
            (row) =>
              md`• ${mdEscape(truncate(row.name, 38))} — ${mdEscape(formatMoney(row.spend))}, лидов ${mdEscape(formatInt(row.conversions))}, CPA ${mdEscape(formatMoney(row.cpa))}`,
          ),
        ];

  const problems =
    anomalies.length === 0
      ? [md`${mdBold('Проблемы')}`, md`${mdEscape('Ничего требующего внимания не нашлось.')}`]
      : [
          md`${mdBold('Топ проблем')}`,
          ...anomalies
            .slice(0, MAX_PROBLEMS)
            .map((item) => md`${mdEscape(`${severityIcon(item)} ${item.text}`)}`),
        ];

  const chart = chartUrl === null ? null : mdLink(`📈 График за ${CHART_DAYS} дней`, chartUrl);

  // Спокойная подпись живёт в сносках рядом с оговоркой про дозаезд: читателю
  // достаточно знать её один раз. Смешение моделей — не подпись, а причина не
  // верить цифрам выше, поэтому оно стоит сразу под ними, как и пробелы в данных.
  const attribution = attributionNote(current.attribution);
  const mixed = current.attribution.mixed && attribution !== null;

  const caveats = [
    ...(gaps === null ? [] : [md``, md`${mdEscape(`⚠️ ${gaps}`)}`]),
    ...(mixed ? [md``, md`${mdEscape(`⚠️ ${attribution ?? ''}`)}`] : []),
  ];

  return clampMarkdown(
    mdJoin([
      header,
      md``,
      ...totals,
      ...caveats,
      md``,
      ...campaigns,
      md``,
      ...problems,
      chart === null ? null : md``,
      chart,
      md``,
      attribution === null || mixed ? null : md`${mdEscape(attribution)}`,
      md`${mdEscape(PROVISIONAL_NOTE)}`,
    ]),
  );
}

function severityIcon(anomaly: Anomaly): string {
  return anomaly.severity === 'critical' ? '🔴' : '⚠️';
}

/**
 * Считает, сохраняет и отправляет отчёт одному клиенту.
 *
 * Повторный вызов за тот же период не создаёт вторую строку в `Report`
 * (составной уникальный ключ) и не шлёт второе сообщение, если первое уже ушло.
 */
export async function sendDailyReport(
  recipient: ReportRecipient,
  options: DailyReportOptions = {},
): Promise<DailyReportOutcome> {
  const deps = resolveDeps(options);
  const period = options.period ?? yesterdayPeriod(deps.now());
  const force = options.force ?? false;

  const existing = await findReport(deps.db, recipient.clientId, ReportKind.DAILY, period);

  if (existing?.sentAt && !force) {
    log.info({ clientId: recipient.clientId, ...period }, 'daily report already sent, skipping');
    return {
      clientId: recipient.clientId,
      period,
      reportId: existing.id,
      sent: false,
      reused: true,
      skipped: 'already_sent',
      chartUrl: null,
    };
  }

  // Отчёт есть, но не доставлен — это ретрай после сбоя Telegram. Пересчёт дал бы
  // другой текст (статистика докрутилась) и стоил бы лишних запросов в БД.
  const reuse = existing !== null && !force;
  const content = reuse ? null : await buildDailyReport(recipient, period, options);

  const stored =
    content === null
      ? existing
      : await saveReport(deps.db, {
          clientId: recipient.clientId,
          kind: ReportKind.DAILY,
          period,
          body: content.body,
          metrics: toJsonObject({
            kind: 'daily',
            totals: content.metrics.totals,
            previousTotals: content.previous.totals,
            campaigns: content.metrics.campaigns,
            anomalies: content.anomalies,
            chartUrl: content.chartUrl,
          }),
        });

  if (!stored) throw new Error('daily report row disappeared between read and write');

  try {
    await deps.messenger().sendMarkdown(recipient.chatId, stored.body, { linkPreview: true });
  } catch (err) {
    // Тело уже в БД: следующий прогон возьмёт его отсюда и просто отправит.
    throw new ReportDeliveryError(recipient.clientId, stored.id, err);
  }

  await markReportSent(deps.db, stored.id, deps.now());

  return {
    clientId: recipient.clientId,
    period,
    reportId: stored.id,
    sent: true,
    reused: reuse,
    skipped: null,
    chartUrl: content?.chartUrl ?? null,
  };
}

/**
 * Точка входа очереди `daily-report`.
 *
 * Клиенты обходятся независимо: отвалившийся кабинет одного не должен оставить
 * без отчёта остальных, поэтому отказ пишется в `ErrorLog` и попадает в сводку.
 */
export async function runDailyReports(options: DailyReportOptions = {}): Promise<DailyRunSummary> {
  const deps = resolveDeps(options);
  const period = options.period ?? yesterdayPeriod(deps.now());
  const recipients = await listReportRecipients(deps.db, options.clientId);

  const summary: DailyRunSummary = {
    period,
    clients: recipients.length,
    sent: 0,
    skipped: 0,
    failures: [],
  };

  for (const recipient of recipients) {
    try {
      const outcome = await sendDailyReport(recipient, { ...options, ...deps, period });
      if (outcome.sent) summary.sent += 1;
      else summary.skipped += 1;
    } catch (err) {
      const failure = describeFailure(recipient.clientId, 'daily', err);
      summary.failures.push({ clientId: recipient.clientId, message: failure.message });
      await recordFailure(deps.db, failure);
    }
  }

  log.info(
    { ...period, clients: summary.clients, sent: summary.sent, failures: summary.failures.length },
    'daily reports finished',
  );
  return summary;
}
