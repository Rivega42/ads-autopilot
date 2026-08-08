import type { Provider } from '@prisma/client';

import { env } from '@/env.js';
import { formatMsk } from '@/lib/dates.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { detectSpendOutlier } from '@/reporter/anomalies.js';
import { resolveDeps, type ReporterDeps } from '@/reporter/deps.js';
import { formatMoney, formatPctMagnitude, truncate } from '@/reporter/format.js';
import { md, mdBold, mdEscape, mdJoin, type Markdown } from '@/reporter/markdown.js';
import { collectPeriodMetrics } from '@/reporter/metrics.js';
import { trailingPeriod } from '@/reporter/period.js';
import { alertLimiter, type CooldownLimiter } from '@/reporter/rate-limit.js';
import { listReportRecipients } from '@/reporter/recipients.js';

/**
 * Алерты Роману (ТЗ §3.6, CLAUDE.md §9).
 *
 * Четыре повода: всплеск ошибок, протухший токен, кончившиеся units и
 * аномальный расход. Все, кроме последнего, читаются из `ErrorLog` — туда их
 * уже пишут клиенты площадок и загрузка, так что отдельного канала событий не
 * нужно и алерты не зависят от того, какой процесс поймал ошибку.
 *
 * Каждый повод проходит через ограничитель повторов: см. `rate-limit.ts`.
 */

const log = logger.child({ scope: 'reporter:alerts' });

export type AlertKind = 'error_burst' | 'auth_error' | 'out_of_units' | 'spend_anomaly';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** Ключ подавления повторов: одна поломка — один ключ. */
  key: string;
  clientId: string | null;
  provider: Provider | null;
  title: string;
  lines: string[];
}

/** ТЗ §3.6: больше 10 ошибок за 5 минут — алерт. */
export const ERROR_BURST_THRESHOLD = 10;
export const ERROR_WINDOW_MINUTES = 5;

/** Сколько дней истории берём под аномальный расход. */
export const SPEND_BASELINE_DAYS = 8;

/** Больше пяти сообщений за прогон — это уже флуд, остальное схлопываем в строку. */
export const MAX_ALERTS_PER_RUN = 5;

const AUTH_CODES = new Set(['AUTH_FAILED', 'UNAUTHORIZED', '401']);
const UNITS_CODES = new Set(['OUT_OF_UNITS', '52']);

export interface AlertOptions extends Partial<ReporterDeps> {
  /** Куда слать. По умолчанию — админский чат из окружения. */
  chatId?: string;
  clientId?: string;
  windowMinutes?: number;
  burstThreshold?: number;
  /** Свой ограничитель — нужен тестам, чтобы не делить состояние между кейсами. */
  limiter?: CooldownLimiter;
  /** Отключает проверку расхода: она ходит в статистику и в частом кроне избыточна. */
  checkSpend?: boolean;
}

export interface AlertRunSummary {
  detected: number;
  sent: number;
  /** Подавлено ограничителем повторов. */
  suppressed: number;
  /** Не влезло в лимит одного прогона. */
  truncated: number;
  alerts: Alert[];
}

interface ErrorRow {
  clientId: string | null;
  provider: Provider | null;
  scope: string;
  code: string | null;
  message: string;
  createdAt: Date;
}

function bucketKey(row: { clientId: string | null; provider: Provider | null }): string {
  return `${row.clientId ?? 'system'}:${row.provider ?? 'none'}`;
}

/**
 * Ищет поводы для алерта. Ничего не отправляет и не трогает ограничитель —
 * так набор правил проверяется тестом без Telegram.
 */
export async function detectAlerts(options: AlertOptions = {}): Promise<Alert[]> {
  const deps = resolveDeps(options);
  const now = deps.now();
  const windowMinutes = options.windowMinutes ?? ERROR_WINDOW_MINUTES;
  const threshold = options.burstThreshold ?? ERROR_BURST_THRESHOLD;
  const since = new Date(now.getTime() - windowMinutes * 60_000);

  const rows: ErrorRow[] = await deps.db.errorLog.findMany({
    where: {
      createdAt: { gte: since },
      ...(options.clientId ? { clientId: options.clientId } : {}),
    },
    select: {
      clientId: true,
      provider: true,
      scope: true,
      code: true,
      message: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const alerts: Alert[] = [];
  const buckets = new Map<string, ErrorRow[]>();
  for (const row of rows) {
    const key = bucketKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  for (const [key, bucket] of buckets) {
    const first = bucket[0];
    if (!first) continue;

    if (bucket.length > threshold) {
      alerts.push({
        kind: 'error_burst',
        severity: 'critical',
        key: `error_burst:${key}`,
        clientId: first.clientId,
        provider: first.provider,
        title: `${bucket.length} ошибок за ${windowMinutes} мин`,
        lines: [
          `Кабинет: ${describeScope(first)}`,
          `Первая: ${formatMsk(first.createdAt, 'HH:mm')} — ${truncate(first.message, 160)}`,
          ...topCodes(bucket).map(([code, count]) => `${code}: ${count}`),
        ],
      });
    }

    const auth = bucket.find((row) => row.code !== null && AUTH_CODES.has(row.code));
    if (auth) {
      alerts.push({
        kind: 'auth_error',
        severity: 'critical',
        key: `auth_error:${key}`,
        clientId: auth.clientId,
        provider: auth.provider,
        title: 'Токен не принят площадкой',
        lines: [
          `Кабинет: ${describeScope(auth)}`,
          truncate(auth.message, 200),
          'Ретрай бесполезен — нужна переавторизация.',
        ],
      });
    }

    const units = bucket.find((row) => row.code !== null && UNITS_CODES.has(row.code));
    if (units) {
      alerts.push({
        kind: 'out_of_units',
        severity: 'warning',
        key: `out_of_units:${key}`,
        clientId: units.clientId,
        provider: units.provider,
        title: 'Кончились units API',
        lines: [`Кабинет: ${describeScope(units)}`, 'Задачи по этому кабинету отложены.'],
      });
    }
  }

  if (options.checkSpend !== false) {
    alerts.push(...(await detectSpendAlerts(options)));
  }

  return alerts;
}

async function detectSpendAlerts(options: AlertOptions): Promise<Alert[]> {
  const deps = resolveDeps(options);
  const period = trailingPeriod(SPEND_BASELINE_DAYS, deps.now());
  const recipients = await listReportRecipients(deps.db, options.clientId);
  const alerts: Alert[] = [];

  for (const recipient of recipients) {
    const metrics = await collectPeriodMetrics(deps.db, recipient.clientId, period);
    const outlier = detectSpendOutlier(metrics.byDate);
    if (!outlier) continue;

    const grew = outlier.direction === 'spike';
    alerts.push({
      kind: 'spend_anomaly',
      severity: grew ? 'critical' : 'warning',
      // В ключе есть дата: следующий аномальный день должен пробиться сквозь тишину.
      key: `spend_anomaly:${recipient.clientId}:${outlier.date}`,
      clientId: recipient.clientId,
      provider: null,
      title: grew ? 'Аномальный расход' : 'Расход почти остановился',
      lines: [
        `Клиент: ${recipient.name}`,
        `${outlier.date}: ${formatMoney(outlier.spend)} при среднем ${formatMoney(outlier.baseline)}`,
        `Отклонение: ${grew ? '+' : '−'}${formatPctMagnitude(outlier.changePct)}`,
      ],
    });
  }

  return alerts;
}

function describeScope(row: ErrorRow): string {
  return [row.provider ?? 'система', row.clientId ?? 'без клиента', row.scope].join(' / ');
}

function topCodes(rows: readonly ErrorRow[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = row.code ?? row.scope;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
}

export function renderAlert(alert: Alert): Markdown {
  const icon = alert.severity === 'critical' ? '🚨' : '⚠️';
  return mdJoin([
    md`${mdEscape(icon)} ${mdBold(alert.title)}`,
    ...alert.lines.map((line) => md`${mdEscape(line)}`),
  ]);
}

/**
 * Полный цикл: найти → отфильтровать повторы → отправить.
 *
 * Возвращает всё найденное, включая подавленное: сводка нужна, чтобы по логам
 * было видно разницу между «тихо, потому что всё хорошо» и «тихо, потому что
 * ограничитель молчит».
 */
export async function runAlertScan(options: AlertOptions = {}): Promise<AlertRunSummary> {
  const deps = resolveDeps(options);
  const limiter = options.limiter ?? alertLimiter;
  const now = deps.now();
  const chatId = options.chatId ?? env.TELEGRAM_ADMIN_CHAT_ID;

  const alerts = await detectAlerts(options);
  const summary: AlertRunSummary = {
    detected: alerts.length,
    sent: 0,
    suppressed: 0,
    truncated: 0,
    alerts,
  };

  if (alerts.length === 0) return summary;

  if (!chatId) {
    log.warn({ detected: alerts.length }, 'TELEGRAM_ADMIN_CHAT_ID is not set, alerts not sent');
    summary.suppressed = alerts.length;
    return summary;
  }

  const passing = alerts.filter((alert) => limiter.allow(alert.key, now));
  summary.suppressed = alerts.length - passing.length;

  const toSend = passing.slice(0, MAX_ALERTS_PER_RUN);
  summary.truncated = passing.length - toSend.length;

  for (const alert of toSend) {
    try {
      await deps.messenger().sendMarkdown(chatId, renderAlert(alert));
      summary.sent += 1;
    } catch (err) {
      // Алерт об упавшей отправке алерта отправить некуда — остаётся лог.
      log.error({ key: alert.key, err: describeError(err) }, 'failed to deliver alert');
    }
  }

  if (summary.truncated > 0) {
    try {
      await deps
        .messenger()
        .sendMarkdown(
          chatId,
          md`${mdEscape(`…и ещё ${summary.truncated} предупреждений за этот прогон.`)}`,
        );
    } catch (err) {
      log.error({ err: describeError(err) }, 'failed to deliver alert tail');
    }
  }

  log.info(
    { detected: summary.detected, sent: summary.sent, suppressed: summary.suppressed },
    'alert scan finished',
  );
  return summary;
}
