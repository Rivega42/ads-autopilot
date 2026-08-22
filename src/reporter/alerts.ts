import type { Provider } from '@prisma/client';

import { env } from '@/env.js';
import { formatMsk } from '@/lib/dates.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
import { detectSpendOutlier } from '@/reporter/anomalies.js';
import { resolveDeps, type ReporterDeps } from '@/reporter/deps.js';
import { describeFailure, recordFailure } from '@/reporter/errors.js';
import { formatMoney, formatPctMagnitude, truncate } from '@/reporter/format.js';
import { md, mdBold, mdEscape, mdJoin, type Markdown } from '@/reporter/markdown.js';
import { collectPeriodMetrics } from '@/reporter/metrics.js';
import { trailingPeriod } from '@/reporter/period.js';
import { alertLimiter, type CooldownLimiter } from '@/reporter/rate-limit.js';
import { listReportRecipients } from '@/reporter/recipients.js';
import { CRON_SCHEDULE, QUEUE_NAMES } from '@/scheduler/schedule.js';

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

export type AlertKind =
  | 'error_burst'
  | 'provider_burst'
  | 'auth_error'
  | 'out_of_units'
  | 'report_failed'
  | 'spend_anomaly';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** Ключ подавления повторов: одна поломка — один ключ. */
  key: string;
  /** Своя длительность тишины по этому поводу; по умолчанию — общая. */
  cooldownMs?: number;
  clientId: string | null;
  provider: Provider | null;
  title: string;
  lines: string[];
}

/** ТЗ §3.6: больше 10 ошибок за 5 минут — алерт. */
export const ERROR_BURST_THRESHOLD = 10;
export const ERROR_WINDOW_MINUTES = 5;

/**
 * Период крона `alert-scan` в минутах.
 *
 * Считается из самого расписания, а не записан числом рядом: отдельную
 * константу забывают поправить при смене крона, и глубина выборки молча
 * расходится с частотой прогонов.
 */
export const ALERT_SCAN_INTERVAL_MINUTES = cronIntervalMinutes(
  CRON_SCHEDULE[QUEUE_NAMES.alertScan],
);

/** Запас на дрожание крона: тик, приехавший позже соседа, не должен оставлять щель. */
export const ERROR_LOOKBACK_JITTER_MINUTES = 1;

/**
 * Глубина выборки из `ErrorLog`.
 *
 * Инвариант: выборка обязана перекрывать два периода крона. Прогон видит только
 * то, что попало в его собственное окно, назад никто не смотрит, — поэтому
 * пропущенный тик (рестарт воркера, залипшая очередь) при выборке короче
 * `2 × период` оставляет минуты журнала, которых не увидит ни один прогон.
 * Разовый повод — 401 или исчерпание units — из такой дырки теряется навсегда.
 *
 * Раньше здесь стоял фиксированный заход на 2 минуты при кроне «раз в 5 минут»: тик в T
 * покрывал `[T−7, T]`, следующий после пропущенного — `[T+3, T+10]`, и интервал
 * `(T, T+3)` не смотрел никто.
 *
 * Всплеск по-прежнему считается строго по окну, а разовые поводы — по всей
 * выборке: увидеть 401 дважды не страшно (повтор гасит ограничитель), не
 * увидеть ни разу — страшно.
 */
export const ERROR_LOOKBACK_MINUTES = Math.max(
  ERROR_WINDOW_MINUTES,
  2 * ALERT_SCAN_INTERVAL_MINUTES + ERROR_LOOKBACK_JITTER_MINUTES,
);

/** Насколько выборка заходит за окно всплеска. Производная величина, не настройка. */
export const ERROR_LOOKBACK_OVERLAP_MINUTES = ERROR_LOOKBACK_MINUTES - ERROR_WINDOW_MINUTES;

/**
 * Потолок выборки из `ErrorLog`.
 *
 * Сломанный кабинет даёт сотни строк за пять минут, а для решения хватает
 * факта «больше порога» и трёх верхних кодов. Берём свежие: пропустить старую
 * ошибку не страшно, пропустить последнюю — страшно.
 */
export const MAX_ERROR_ROWS = 500;

/** Сколько дней истории берём под аномальный расход. */
export const SPEND_BASELINE_DAYS = 8;

/**
 * Тишина по аномальному расходу — почти сутки.
 *
 * В ключе стоит дата вчерашних суток, и весь день он не меняется. С общими 30
 * минутами это давало 48 одинаковых сообщений в сутки на одного клиента: чат с
 * такой историей перестают читать, и следующий настоящий инцидент проходит
 * мимо. Одна аномалия за день — одно сообщение; завтрашняя дата даст новый ключ.
 */
export const SPEND_ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/**
 * Как часто вообще имеет смысл проверять расход.
 *
 * Проверка читает восьмидневное окно статистики на каждого клиента, а крон
 * алертов ходит раз в пять минут — за это время цифры вчерашних суток не
 * меняются. Ограничитель прогона держит проверку раз в час.
 */
export const SPEND_SCAN_INTERVAL_MS = 60 * 60 * 1000;

const SPEND_SCAN_KEY = 'spend_scan';

/** Больше пяти сообщений за прогон — это уже флуд, остальное схлопываем в строку. */
export const MAX_ALERTS_PER_RUN = 5;

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warning: 1 };

const AUTH_CODES = new Set(['AUTH_FAILED', 'UNAUTHORIZED', '401']);
const UNITS_CODES = new Set(['OUT_OF_UNITS', '52']);

/**
 * Коды, которым порог не нужен: одна такая строка — уже инцидент.
 *
 * Недоставленный отчёт пишется в `ErrorLog` кодом `REPORT_FAILED`, и до этого
 * набора не поднимал ничего: до порога всплеска одной записи не хватает, а в
 * наборы 401 и units код не входит. Клиент при этом остался без отчёта —
 * единственного канала, по которому он вообще узнаёт, что происходит с
 * деньгами. «Записали в журнал» и «сообщили человеку» — разные вещи.
 */
const REPORT_FAILURE_CODES = new Set(['REPORT_FAILED', 'REPORT_DELIVERY_FAILED']);

/**
 * Порог по площадке целиком — на поломку, размазанную по кабинетам.
 *
 * Порог всплеска считается по бакету «клиент + площадка»: это защищает от
 * ситуации, когда один сломанный кабинет глушит остальных, но общий отказ
 * площадки, поделённый поровну между кабинетами, не перебирает порог ни в
 * одном бакете и тревоги не даёт. Тот же счёт по площадке целиком её видит.
 */
export const PROVIDER_BURST_THRESHOLD = ERROR_BURST_THRESHOLD;

/**
 * Со скольких кабинетов поломка считается общей для площадки.
 *
 * Ошибки одного кабинета — это его кабинет, а не площадка: такую тревогу
 * поднимает порог по бакету, и она называет кабинет, с которым человеку
 * предстоит что-то делать.
 */
export const PROVIDER_BURST_MIN_CLIENTS = 2;

export interface AlertOptions extends Partial<ReporterDeps> {
  /** Куда слать. По умолчанию — админский чат из окружения. */
  chatId?: string;
  clientId?: string;
  windowMinutes?: number;
  burstThreshold?: number;
  /** Свой ограничитель — нужен тестам, чтобы не делить состояние между кейсами. */
  limiter?: CooldownLimiter;
  /**
   * Проверять ли расход. По умолчанию `runAlertScan` решает сам: раз в час, а
   * не на каждом пятиминутном тике. Явное значение перекрывает это решение.
   */
  checkSpend?: boolean;
}

export interface AlertRunSummary {
  detected: number;
  sent: number;
  /** Подавлено ограничителем повторов. */
  suppressed: number;
  /** Не влезло в лимит одного прогона; тишину не жжёт и уйдёт следующим тиком. */
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
  const burstSince = new Date(now.getTime() - windowMinutes * 60_000);
  const since = new Date(now.getTime() - Math.max(windowMinutes, ERROR_LOOKBACK_MINUTES) * 60_000);

  const fetched: ErrorRow[] = await deps.db.errorLog.findMany({
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
    // Свежие сначала — потолок обязан отрезать хвост, а не голову.
    orderBy: { createdAt: 'desc' },
    take: MAX_ERROR_ROWS,
  });

  const capped = fetched.length >= MAX_ERROR_ROWS;
  if (capped) {
    log.warn({ since, take: MAX_ERROR_ROWS }, 'error log window is larger than the alert cap');
  }
  const rows = [...fetched].reverse();

  const alerts: Alert[] = [];
  const buckets = new Map<string, ErrorRow[]>();
  for (const row of rows) {
    const key = bucketKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  // Поломки площадки ищем до кабинетных: если сыплется вся площадка, разговор
  // идёт о ней, а не о каждом задетом кабинете по отдельности.
  const providerAlerts = providerBursts(rows, burstSince, windowMinutes, threshold, capped);
  const widespread = new Set(providerAlerts.map((alert) => alert.provider));
  alerts.push(...providerAlerts);

  for (const [key, bucket] of buckets) {
    const first = bucket[0];
    if (!first) continue;

    // Порог из ТЗ задан на окно — считаем строго по нему, хотя выбрали шире.
    const inWindow = bucket.filter((row) => row.createdAt >= burstSince);
    const burstFirst = inWindow[0] ?? first;
    if (inWindow.length > threshold && !widespread.has(first.provider)) {
      alerts.push({
        kind: 'error_burst',
        severity: 'critical',
        key: `error_burst:${key}`,
        clientId: burstFirst.clientId,
        provider: burstFirst.provider,
        title: `${capped ? 'больше ' : ''}${inWindow.length} ошибок за ${windowMinutes} мин`,
        lines: [
          `Кабинет: ${describeScope(burstFirst)}`,
          `Первая: ${formatMsk(burstFirst.createdAt, 'HH:mm')} — ${truncate(burstFirst.message, 160)}`,
          ...topCodes(inWindow).map(([code, count]) => `${code}: ${count}`),
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

    // Отказ отчётности: по одной тревоге на кабинет и этап, а не на запись —
    // иначе прогон, упавший по всем клиентам, превратился бы в поток сообщений.
    for (const failure of reportFailures(bucket)) {
      alerts.push(failure);
    }
  }

  if (options.checkSpend !== false) {
    try {
      alerts.push(...(await detectSpendAlerts(options)));
    } catch (err) {
      // Проверка расхода — самая тяжёлая и самая ломкая часть скана. Её отказ
      // не имеет права утащить с собой уже найденные 401 и всплески ошибок.
      log.error({ err: describeError(err) }, 'spend anomaly scan failed');
    }
  }

  return alerts;
}

async function detectSpendAlerts(options: AlertOptions): Promise<Alert[]> {
  const deps = resolveDeps(options);
  const period = trailingPeriod(SPEND_BASELINE_DAYS, deps.now());
  const recipients = await listReportRecipients(deps.db, options.clientId);
  const alerts: Alert[] = [];

  for (const recipient of recipients) {
    // Клиенты независимы: та же логика, что в `runIngestion` и `runDailyReports`.
    // Один битый кабинет не должен стоить алертов всем остальным.
    try {
      const metrics = await collectPeriodMetrics(deps.db, recipient.clientId, period);
      const outlier = detectSpendOutlier(metrics.byDate);
      if (!outlier) continue;

      const grew = outlier.direction === 'spike';
      alerts.push({
        kind: 'spend_anomaly',
        severity: grew ? 'critical' : 'warning',
        // В ключе есть дата: следующий аномальный день должен пробиться сквозь тишину.
        key: `spend_anomaly:${recipient.clientId}:${outlier.date}`,
        cooldownMs: SPEND_ALERT_COOLDOWN_MS,
        clientId: recipient.clientId,
        provider: null,
        title: grew ? 'Аномальный расход' : 'Расход почти остановился',
        lines: [
          `Клиент: ${recipient.name}`,
          `${outlier.date}: ${formatMoney(outlier.spend)} при среднем ${formatMoney(outlier.baseline)}`,
          `Отклонение: ${grew ? '+' : '−'}${formatPctMagnitude(outlier.changePct)}`,
        ],
      });
    } catch (err) {
      log.error(
        { clientId: recipient.clientId, err: describeError(err) },
        'spend anomaly check failed for client',
      );
      await recordFailure(deps.db, describeFailure(recipient.clientId, 'alerts', err));
    }
  }

  return alerts;
}

/**
 * Отказы отчётности в бакете — по одному поводу на этап.
 *
 * Этап (`daily`, `weekly`, `alerts`) входит в ключ подавления: недоставленный
 * дневной отчёт и упавший недельный разбор — разные поломки, и вторая не должна
 * молчать полчаса из-за первой.
 */
function reportFailures(bucket: readonly ErrorRow[]): Alert[] {
  const byStage = new Map<string, ErrorRow[]>();
  for (const row of bucket) {
    if (row.code === null || !REPORT_FAILURE_CODES.has(row.code)) continue;
    const stage = reportStage(row.scope);
    const rows = byStage.get(stage);
    if (rows) rows.push(row);
    else byStage.set(stage, [row]);
  }

  return [...byStage].map(([stage, rows]) => {
    const first = rows[0] as ErrorRow;
    const delivery = stage === 'daily' || stage === 'weekly';
    return {
      kind: 'report_failed' as const,
      severity: 'critical' as const,
      key: `report_failed:${bucketKey(first)}:${stage}`,
      clientId: first.clientId,
      provider: first.provider,
      title: delivery ? `Отчёт не ушёл клиенту (${stage})` : `Сбой отчётности (${stage})`,
      lines: [
        `Кабинет: ${describeScope(first)}`,
        truncate(first.message, 200),
        ...(rows.length > 1 ? [`Отказов за выборку: ${rows.length}`] : []),
        ...(delivery ? ['Клиент за этот период отчёта не получил.'] : []),
      ],
    };
  });
}

/** `reporter:daily` → `daily`. Чужие scope оставляем как есть — врать в заголовке нельзя. */
function reportStage(scope: string): string {
  return scope.startsWith('reporter:') ? scope.slice('reporter:'.length) : scope;
}

/**
 * Всплеск по площадке целиком.
 *
 * Считается по тем же строкам и тому же окну, что и всплеск по бакету, но без
 * разбиения по клиентам. Поднимается, только когда ошибки размазаны минимум по
 * двум кабинетам: один кабинет — это работа порога по бакету.
 *
 * Найденная поломка площадки отменяет кабинетные всплески по ней (см. вызов):
 * иначе отвалившаяся у полусотни клиентов площадка вместо одного внятного
 * сообщения давала бы полсотни почти одинаковых, растянутых лимитом прогона на
 * час. Кабинетные поводы, у которых есть своё действие — переавторизация,
 * кончившиеся units, неушедший отчёт, — остаются: они про конкретного клиента.
 */
function providerBursts(
  rows: readonly ErrorRow[],
  burstSince: Date,
  windowMinutes: number,
  threshold: number,
  capped: boolean,
): Alert[] {
  const byProvider = new Map<Provider, ErrorRow[]>();
  for (const row of rows) {
    if (row.provider === null || row.createdAt < burstSince) continue;
    const bucket = byProvider.get(row.provider);
    if (bucket) bucket.push(row);
    else byProvider.set(row.provider, [row]);
  }

  const alerts: Alert[] = [];
  for (const [provider, inWindow] of byProvider) {
    if (inWindow.length <= threshold) continue;
    const clients = countBy(inWindow, (row) => row.clientId ?? 'без клиента');
    if (clients.length < PROVIDER_BURST_MIN_CLIENTS) continue;

    const first = inWindow[0] as ErrorRow;
    alerts.push({
      kind: 'provider_burst',
      severity: 'critical',
      key: `provider_burst:${provider}`,
      // Клиента нет намеренно: поломка не принадлежит ни одному кабинету.
      clientId: null,
      provider,
      title: `${capped ? 'больше ' : ''}${inWindow.length} ошибок ${provider} за ${windowMinutes} мин`,
      lines: [
        `Кабинетов задето: ${clients.length} — похоже на площадку, а не на один кабинет.`,
        ...clients.slice(0, 3).map(([clientId, count]) => `${clientId}: ${count}`),
        `Первая: ${formatMsk(first.createdAt, 'HH:mm')} — ${truncate(first.message, 160)}`,
        ...topCodes(inWindow).map(([code, count]) => `${code}: ${count}`),
      ],
    });
  }

  return alerts;
}

function describeScope(row: ErrorRow): string {
  return [row.provider ?? 'система', row.clientId ?? 'без клиента', row.scope].join(' / ');
}

function topCodes(rows: readonly ErrorRow[]): Array<[string, number]> {
  return countBy(rows, (row) => row.code ?? row.scope).slice(0, 3);
}

/** Счётчик по ключу, от частого к редкому. */
function countBy(
  rows: readonly ErrorRow[],
  key: (row: ErrorRow) => string,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = key(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
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

  // Проверка расхода дорогая, а вчерашние цифры между тиками не меняются:
  // пускаем её раз в час, если вызывающий не потребовал обратного явно.
  const checkSpend =
    options.checkSpend ?? limiter.allow(SPEND_SCAN_KEY, now, SPEND_SCAN_INTERVAL_MS);

  const alerts = await detectAlerts({ ...options, checkSpend });
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

  // Проверяем, но не отмечаем: отметку ставит только состоявшаяся отправка.
  const passing = alerts
    .filter((alert) => limiter.isAllowed(alert.key, now))
    // Резать хвост придётся по лимиту прогона — пусть под нож идёт warning,
    // а не 401, который дороже всех остальных вместе взятых.
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  summary.suppressed = alerts.length - passing.length;

  const toSend = passing.slice(0, MAX_ALERTS_PER_RUN);
  summary.truncated = passing.length - toSend.length;

  for (const alert of toSend) {
    try {
      await deps.messenger().sendMarkdown(chatId, renderAlert(alert));
      // Только здесь: недоставленный алерт обязан пробиться на следующем тике,
      // а не молчать полчаса, ни разу никому не показавшись.
      limiter.markSent(alert.key, now, alert.cooldownMs);
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
          md`${mdEscape(`…и ещё ${summary.truncated} предупреждений — придут следующим прогоном.`)}`,
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

/**
 * Период крона в минутах: наибольший разрыв между соседними запусками.
 *
 * Разобраны расписания, которые ходят каждый час, — крон тревог именно такой.
 * Всё остальное считаем часовым: занизить период нельзя (это вернёт слепую
 * зону), а завысить безопасно — повтор гасит ограничитель.
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
