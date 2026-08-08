import { ReportKind } from '@prisma/client';
import { z } from 'zod';

import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import { runAgent } from '@/clients/llm/index.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import {
  detectAnomalies,
  DEFAULT_THRESHOLDS,
  type Anomaly,
  type AnomalyThresholds,
} from '@/reporter/anomalies.js';
import { spendLeadsChartUrl } from '@/reporter/chart.js';
import { PROVISIONAL_NOTE } from '@/reporter/daily.js';
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
  bySpendDesc,
  collectPeriodMetrics,
  compareTotals,
  type PeriodMetrics,
} from '@/reporter/metrics.js';
import {
  formatPeriod,
  lastWeekPeriod,
  previousPeriod,
  type ReportPeriod,
} from '@/reporter/period.js';
import { listReportRecipients, type ReportRecipient } from '@/reporter/recipients.js';
import { findReport, markReportSent, saveReport, toJsonObject } from '@/reporter/store.js';
import { clampMarkdown } from '@/reporter/telegram.js';
import { WEEKLY_PROMPT_VERSION, WEEKLY_SYSTEM_PROMPT } from '@/reporter/weekly-prompt.js';

/**
 * Недельный AI-разбор (`weekly-report`, понедельник; ТЗ §13.6).
 *
 * Разделение труда: цифры, сравнение с прошлой неделей и поиск аномалий — код;
 * объяснение и план — модель. Модель получает факты уже посчитанными и не
 * видит сырой таблицы, поэтому «придумать тренд» ей не из чего.
 *
 * Вызов идёт через `runAgent` с задачей `analytics.weekly`: только так стоимость
 * попадает в `AiRun` и учитывается в месячном бюджете клиента.
 */

const log = logger.child({ scope: 'reporter:weekly' });

export const WEEKLY_AGENT_NAME = 'analytics-weekly';

/** Сколько кампаний показываем модели: остальные — хвост, который только тратит токены. */
export const MAX_CAMPAIGNS_IN_FACTS = 12;

export const weeklyReviewSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  worked: z.array(z.string().trim().min(1).max(300)).max(4),
  sagging: z
    .array(
      z.object({
        problem: z.string().trim().min(1).max(300),
        proposal: z.string().trim().min(1).max(300),
      }),
    )
    .max(4),
  nextSteps: z.array(z.string().trim().min(1).max(300)).min(1).max(3),
});

export type WeeklyReview = z.infer<typeof weeklyReviewSchema>;

/** Тот же вызов, что делает `runAgent`, но не генерик — так его проще подменить в тестах. */
export type RunWeeklyReview = (
  opts: RunAgentOptions<WeeklyReview>,
) => Promise<AgentRun<WeeklyReview>>;

export interface WeeklyFacts {
  period: { from: string; to: string; label: string };
  previousPeriod: { from: string; to: string; label: string };
  totals: {
    spend: number;
    conversions: number;
    clicks: number;
    impressions: number;
    cpa: number | null;
    ctr: number | null;
  };
  previousTotals: WeeklyFacts['totals'];
  changes: {
    spendPct: number | null;
    conversionsPct: number | null;
    cpaPct: number | null;
  };
  campaigns: Array<{
    name: string;
    provider: string;
    spend: number;
    conversions: number;
    cpa: number | null;
    targetCpa: number | null;
    previousSpend: number;
    previousConversions: number;
    previousCpa: number | null;
  }>;
  /** Найдено кодом, а не моделью. */
  anomalies: Array<Pick<Anomaly, 'kind' | 'severity' | 'text'>>;
  notes: string[];
}

export interface WeeklyReportContent {
  body: Markdown;
  chartUrl: string | null;
  facts: WeeklyFacts;
  review: WeeklyReview | null;
  metrics: PeriodMetrics;
  previous: PeriodMetrics;
  anomalies: Anomaly[];
  /** null — модель не отвечала (упала или не звалась). */
  aiRunId: string | null;
}

export interface WeeklyReportOptions extends Partial<ReporterDeps> {
  clientId?: string;
  period?: ReportPeriod;
  force?: boolean;
  thresholds?: AnomalyThresholds;
  /** Подменяется в тестах; в проде — `runAgent`. */
  run?: RunWeeklyReview;
}

export interface WeeklyReportOutcome {
  clientId: string;
  period: ReportPeriod;
  reportId: string;
  sent: boolean;
  reused: boolean;
  skipped: 'already_sent' | null;
  /** true — разбор собран без модели: она упала, а отчёт всё равно должен уйти. */
  degraded: boolean;
}

export interface WeeklyRunSummary {
  period: ReportPeriod;
  clients: number;
  sent: number;
  skipped: number;
  degraded: number;
  failures: Array<{ clientId: string; message: string }>;
}

/**
 * Факты для модели.
 *
 * Формируются здесь, а не в промпте: то, что модель увидит, должно быть
 * ровно тем, что проверено тестом.
 */
export function buildWeeklyFacts(
  current: PeriodMetrics,
  previous: PeriodMetrics,
  anomalies: readonly Anomaly[],
): WeeklyFacts {
  const cmp = compareTotals(current.totals, previous.totals);
  const past = new Map(previous.campaigns.map((c) => [c.campaignId, c]));

  return {
    period: { ...current.period, label: formatPeriod(current.period) },
    previousPeriod: { ...previous.period, label: formatPeriod(previous.period) },
    totals: pickTotals(current),
    previousTotals: pickTotals(previous),
    changes: {
      spendPct: round(cmp.spend.changePct),
      conversionsPct: round(cmp.conversions.changePct),
      cpaPct: round(cmp.cpa.changePct),
    },
    campaigns: bySpendDesc(activeCampaigns(current))
      .slice(0, MAX_CAMPAIGNS_IN_FACTS)
      .map((campaign) => {
        const before = past.get(campaign.campaignId);
        return {
          name: campaign.name,
          provider: campaign.provider,
          spend: round2(campaign.spend) ?? 0,
          conversions: campaign.conversions,
          cpa: round2(campaign.cpa),
          targetCpa: round2(campaign.targetCpa),
          previousSpend: round2(before?.spend ?? 0) ?? 0,
          previousConversions: before?.conversions ?? 0,
          previousCpa: round2(before?.cpa ?? null),
        };
      }),
    anomalies: anomalies.map((a) => ({ kind: a.kind, severity: a.severity, text: a.text })),
    notes: [PROVISIONAL_NOTE],
  };
}

function pickTotals(metrics: PeriodMetrics): WeeklyFacts['totals'] {
  return {
    spend: round2(metrics.totals.spend) ?? 0,
    conversions: metrics.totals.conversions,
    clicks: metrics.totals.clicks,
    impressions: metrics.totals.impressions,
    cpa: round2(metrics.totals.cpa),
    ctr: metrics.totals.ctr === null ? null : Math.round(metrics.totals.ctr * 10_000) / 10_000,
  };
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

function round2(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export async function buildWeeklyReport(
  recipient: ReportRecipient,
  period: ReportPeriod,
  options: WeeklyReportOptions = {},
): Promise<WeeklyReportContent> {
  const deps = resolveDeps(options);
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const run = options.run ?? runAgent;

  const current = await collectPeriodMetrics(deps.db, recipient.clientId, period);
  const previous = await collectPeriodMetrics(deps.db, recipient.clientId, previousPeriod(period));

  const anomalies = detectAnomalies(current, previous, thresholds);
  const facts = buildWeeklyFacts(current, previous, anomalies);
  const chartUrl = spendLeadsChartUrl(current.byDate);

  let review: WeeklyReview | null = null;
  let aiRunId: string | null = null;

  try {
    const result = await run({
      agent: WEEKLY_AGENT_NAME,
      task: 'analytics.weekly',
      clientId: recipient.clientId,
      system: WEEKLY_SYSTEM_PROMPT,
      messages: JSON.stringify(facts),
      schema: weeklyReviewSchema,
      schemaName: `weekly-review@${WEEKLY_PROMPT_VERSION}`,
    });
    review = result.data;
    aiRunId = result.aiRunId;
  } catch (err) {
    // Разбор без модели хуже, чем с моделью, но лучше, чем молчание в понедельник:
    // цифры и аномалии посчитаны здесь и от LLM не зависят.
    log.error(
      { clientId: recipient.clientId, err: describeError(err) },
      'weekly review LLM call failed, falling back to numbers only',
    );
  }

  return {
    body: renderWeekly(recipient, current, previous, anomalies, review, chartUrl),
    chartUrl,
    facts,
    review,
    metrics: current,
    previous,
    anomalies,
    aiRunId,
  };
}

export function renderWeekly(
  recipient: ReportRecipient,
  current: PeriodMetrics,
  previous: PeriodMetrics,
  anomalies: readonly Anomaly[],
  review: WeeklyReview | null,
  chartUrl: string | null,
): Markdown {
  const cmp = compareTotals(current.totals, previous.totals);

  const header = md`📈 ${mdBold(`Недельный разбор (${formatPeriod(current.period)})`)} — ${mdEscape(recipient.name)}`;

  const totals = [
    md`Расход: ${mdBold(formatMoney(current.totals.spend))} ${mdEscape(`${trendArrow(cmp.spend.changePct)} ${formatPctChange(cmp.spend.changePct)} к прошлой`)}`,
    md`Лиды: ${mdBold(formatInt(current.totals.conversions))} ${mdEscape(`${trendArrow(cmp.conversions.changePct)} ${formatPctChange(cmp.conversions.changePct)} (было ${formatInt(previous.totals.conversions)})`)}`,
    md`CPA: ${mdBold(formatMoney(current.totals.cpa))} ${mdEscape(`(было ${formatMoney(previous.totals.cpa)}, ${formatPctChange(cmp.cpa.changePct)})`)}`,
    md`Клики: ${mdEscape(formatInt(current.totals.clicks))} · CTR ${mdEscape(formatRatio(current.totals.ctr))}`,
  ];

  const worked =
    review && review.worked.length > 0
      ? [
          md``,
          md`${mdBold('Что сработало')}`,
          ...review.worked.map((item) => md`${mdEscape(`✅ ${item}`)}`),
        ]
      : [];

  const sagging =
    review && review.sagging.length > 0
      ? [
          md``,
          md`${mdBold('Что проседает')}`,
          ...review.sagging.flatMap((item) => [
            md`${mdEscape(`⚠️ ${item.problem}`)}`,
            md`   ${mdEscape(`→ ${item.proposal}`)}`,
          ]),
        ]
      : [];

  // Без модели список аномалий — единственное содержательное, что есть.
  const rawAnomalies =
    review === null && anomalies.length > 0
      ? [
          md``,
          md`${mdBold('На что смотреть')}`,
          ...anomalies.slice(0, 5).map((item) => md`${mdEscape(`⚠️ ${item.text}`)}`),
        ]
      : [];

  const campaigns = bySpendDesc(activeCampaigns(current)).slice(0, 5);
  const table =
    campaigns.length === 0
      ? []
      : [
          md``,
          md`${mdBold('Кампании недели')}`,
          ...campaigns.map(
            (row) =>
              md`• ${mdEscape(truncate(row.name, 38))} — ${mdEscape(formatMoney(row.spend))}, лидов ${mdEscape(formatInt(row.conversions))}, CPA ${mdEscape(formatMoney(row.cpa))}`,
          ),
        ];

  const plan =
    review && review.nextSteps.length > 0
      ? [
          md``,
          md`${mdBold('Планы на след. неделю')}`,
          ...review.nextSteps.map((item, i) => md`${mdEscape(`${i + 1}. ${item}`)}`),
        ]
      : [md``, md`${mdEscape('AI-разбор недоступен — ниже только цифры и аномалии.')}`];

  const summary = review === null ? [] : [md``, md`${mdEscape(review.summary)}`];

  return clampMarkdown(
    mdJoin([
      header,
      md``,
      ...totals,
      ...summary,
      ...worked,
      ...sagging,
      ...rawAnomalies,
      ...table,
      ...plan,
      md``,
      chartUrl === null ? null : mdLink('📊 График по дням', chartUrl),
      md``,
      md`${mdEscape(PROVISIONAL_NOTE)}`,
    ]),
  );
}

export async function sendWeeklyReport(
  recipient: ReportRecipient,
  options: WeeklyReportOptions = {},
): Promise<WeeklyReportOutcome> {
  const deps = resolveDeps(options);
  const period = options.period ?? lastWeekPeriod(deps.now());
  const force = options.force ?? false;

  const existing = await findReport(deps.db, recipient.clientId, ReportKind.WEEKLY, period);

  if (existing?.sentAt && !force) {
    return {
      clientId: recipient.clientId,
      period,
      reportId: existing.id,
      sent: false,
      reused: true,
      skipped: 'already_sent',
      degraded: false,
    };
  }

  // Ключевое отличие от дневного отчёта: пересчёт стоит денег в LLM. Сохранённый,
  // но не доставленный разбор переотправляем как есть.
  const reuse = existing !== null && !force;
  const content = reuse ? null : await buildWeeklyReport(recipient, period, options);

  const stored =
    content === null
      ? existing
      : await saveReport(deps.db, {
          clientId: recipient.clientId,
          kind: ReportKind.WEEKLY,
          period,
          body: content.body,
          metrics: toJsonObject({
            kind: 'weekly',
            facts: content.facts,
            review: content.review,
            chartUrl: content.chartUrl,
            aiRunId: content.aiRunId,
            promptVersion: WEEKLY_PROMPT_VERSION,
          }),
        });

  if (!stored) throw new Error('weekly report row disappeared between read and write');

  try {
    await deps.messenger().sendMarkdown(recipient.chatId, stored.body, { linkPreview: true });
  } catch (err) {
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
    degraded: content !== null && content.review === null,
  };
}

/** Точка входа очереди `weekly-report`. */
export async function runWeeklyReports(
  options: WeeklyReportOptions = {},
): Promise<WeeklyRunSummary> {
  const deps = resolveDeps(options);
  const period = options.period ?? lastWeekPeriod(deps.now());
  const recipients = await listReportRecipients(deps.db, options.clientId);

  const summary: WeeklyRunSummary = {
    period,
    clients: recipients.length,
    sent: 0,
    skipped: 0,
    degraded: 0,
    failures: [],
  };

  for (const recipient of recipients) {
    try {
      const outcome = await sendWeeklyReport(recipient, { ...options, ...deps, period });
      if (outcome.sent) summary.sent += 1;
      else summary.skipped += 1;
      if (outcome.degraded) summary.degraded += 1;
    } catch (err) {
      const failure = describeFailure(recipient.clientId, 'weekly', err);
      summary.failures.push({ clientId: recipient.clientId, message: failure.message });
      await recordFailure(deps.db, failure);
    }
  }

  log.info(
    {
      ...period,
      clients: summary.clients,
      sent: summary.sent,
      degraded: summary.degraded,
      failures: summary.failures.length,
    },
    'weekly reports finished',
  );
  return summary;
}
