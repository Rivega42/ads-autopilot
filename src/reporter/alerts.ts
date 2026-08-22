import type { Provider } from '@prisma/client';

import { env } from '@/env.js';
import { formatMsk } from '@/lib/dates.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/logger.js';
// Код, под которым оптимизатор пишет недоставленную карточку. Импорт, а не своя
// строка: разъехавшиеся константы дают молчащую тревогу, и заметить это нечем.
import { APPROVAL_NOT_DELIVERED_CODE } from '@/optimizer/errors.js';
import { detectSpendOutlier } from '@/reporter/anomalies.js';
import { resolveDeps, type ReporterDb, type ReporterDeps } from '@/reporter/deps.js';
import {
  describeFailure,
  recordFailure,
  REPORT_FAILURE_CODE_VALUES,
  REPORT_FAILURE_CODES,
} from '@/reporter/errors.js';
import { formatMoney, formatPctMagnitude, truncate } from '@/reporter/format.js';
import { md, mdBold, mdEscape, mdJoin, type Markdown } from '@/reporter/markdown.js';
import { collectPeriodMetrics } from '@/reporter/metrics.js';
import { trailingPeriod } from '@/reporter/period.js';
import { alertLimiter, type CooldownLimiter } from '@/reporter/rate-limit.js';
import { listReportRecipients } from '@/reporter/recipients.js';
import { CRON_SCHEDULE, cronIntervalMinutes, QUEUE_NAMES } from '@/scheduler/schedule.js';

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

// Реэкспорт: `cronIntervalMinutes` переехала к расписанию (`scheduler/schedule.ts`) —
// там же, где `CRON_SCHEDULE`, из которого она и считает. Тот же приём, что в
// `scheduler/queues.ts`: место импорта у тех, кто брал её отсюда, не меняется.
export { cronIntervalMinutes };

export type AlertKind =
  | 'error_burst'
  | 'provider_burst'
  | 'auth_error'
  | 'out_of_units'
  | 'approval_undelivered'
  | 'report_failed'
  | 'spend_anomaly'
  /** Скан не увидел весь журнал: тревог этого прогона могло не хватить. */
  | 'scan_incomplete';

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
  /**
   * Ключ тревоги, в тексте которой этот повод уже рассказан строкой.
   *
   * Свернуть — не то же самое, что подавить: свёрнутый повод считается
   * доставленным только вместе с родителем. Если родитель промолчал (тишина по
   * его ключу), повод уходит сам по себе — иначе всплеск у нового кабинета
   * ждал бы конца чужой тишины.
   */
  foldedInto?: string;
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
 * Потолок числа групп в скане.
 *
 * Считать теперь можно агрегатом, поэтому потолок стоит не на строках, а на
 * различных сочетаниях «клиент × площадка × scope × код». Тысяча строк одного
 * отказа — одна группа, и в потолок такой кабинет не упирается вовсе: раньше
 * он ровно этим и вытеснял из выборки чужие поводы.
 *
 * Потолок всё равно нужен — запрос без границы это запрос без границы, — но
 * упереться в него значит «я смотрел не всё», и об этом поднимается своя
 * тревога `scan_incomplete`. Молча урезанная проверка — то же самое, что
 * выключенная.
 */
export const MAX_ERROR_GROUPS = 500;

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
 * Тишина по стоячему состоянию — почти сутки, по той же причине.
 *
 * «Клиент держит бота в блоке» не проходит само между прогонами: повод
 * повторяется каждым тиком, пока человек не позвонит клиенту. С общими 30
 * минутами такой повод за сутки даёт полсотни одинаковых сообщений — и уносит
 * с собой внимание к тем, которые срочные.
 */
export const STANDING_ALERT_COOLDOWN_MS = 20 * 60 * 60 * 1000;

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
 *
 * Одного этого условия мало: см. `isWidespread` — считать площадкой всё, где
 * задето два кабинета, значит называть площадкой один сломанный кабинет плюс
 * случайную соседнюю ошибку.
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
  /**
   * Рассказано строкой внутри другой тревоги (см. `Alert.foldedInto`).
   *
   * Отдельно от `suppressed`: свёрнутый повод человек увидел, подавленный — нет,
   * и по логам это должно различаться.
   */
  folded: number;
  /** Не влезло в лимит одного прогона; тишину не жжёт и уйдёт следующим тиком. */
  truncated: number;
  alerts: Alert[];
}

/**
 * Срез журнала: сколько ошибок одного вида пришло от одного кабинета.
 *
 * Тревоги считают строки, но читать строки ради счёта не обязаны: у группы
 * «клиент × площадка × scope × код» счёт берётся агрегатом. Это не оптимизация,
 * а условие правильности — см. `groupErrors`.
 */
interface ErrorGroup {
  clientId: string | null;
  provider: Provider | null;
  scope: string;
  code: string | null;
  count: number;
  /** id первой строки группы: адрес образца текста и порядок появления разом. */
  firstId: bigint;
  firstAt: Date;
}

interface ErrorScan {
  groups: ErrorGroup[];
  /** Скан упёрся в потолок групп: часть журнала он не видел. */
  incomplete: boolean;
}

function bucketKey(row: { clientId: string | null; provider: Provider | null }): string {
  return `${row.clientId ?? 'system'}:${row.provider ?? 'none'}`;
}

/**
 * Журнал за окно — агрегатом, а не выборкой строк.
 *
 * Раньше здесь стоял один `findMany` с потолком в 500 свежих строк на всех
 * клиентов сразу. Прогон крупного кабинета пишет тысячу строк за тик
 * (`recordFailures`: до потолка на кампанию, кампаний десятки) и выбивал из
 * выборки чужие: 401 соседнего клиента в неё не попадал, а назад ни один тик не
 * смотрит — повод терялся навсегда, а в чат уходила ровно одна тревога: про
 * флудящего. Поднимать потолок бессмысленно — следующий клиент крупнее.
 *
 * Агрегат снимает саму возможность вытеснения. Тысяча строк одного отказа — это
 * одна группа, и число в ней точное: обрезать нечего.
 */
async function groupErrors(
  db: ReporterDb,
  since: Date,
  clientId: string | undefined,
): Promise<ErrorScan> {
  const rows = await db.errorLog.groupBy({
    by: ['clientId', 'provider', 'scope', 'code'],
    where: {
      createdAt: { gte: since },
      ...(clientId ? { clientId } : {}),
    },
    _count: { _all: true },
    _min: { id: true, createdAt: true },
    _max: { createdAt: true },
    // Если групп всё-таки больше потолка, отрезать надо старые.
    orderBy: { _max: { createdAt: 'desc' } },
    take: MAX_ERROR_GROUPS + 1,
  });

  const groups: ErrorGroup[] = [];
  for (const row of rows.slice(0, MAX_ERROR_GROUPS)) {
    const firstId = row._min?.id;
    const firstAt = row._min?.createdAt;
    if (firstId === null || firstId === undefined || !firstAt) continue;
    groups.push({
      clientId: row.clientId,
      provider: row.provider,
      scope: row.scope,
      code: row.code,
      count: row._count._all,
      firstId,
      firstAt,
    });
  }

  // Порядок появления: тексты называют «первую» ошибку, и он же задаёт порядок
  // самих тревог. Без явной сортировки он зависел бы от плана запроса.
  groups.sort((a, b) => (a.firstId === b.firstId ? 0 : a.firstId < b.firstId ? -1 : 1));

  return { groups, incomplete: rows.length > MAX_ERROR_GROUPS };
}

/**
 * Тексты первых строк выбранных групп — по их id, а не выборкой «сверху».
 *
 * Строк ровно столько, сколько групп: у каждой группы свой id, и вытеснить
 * чужой образец нечем.
 */
async function loadSamples(
  db: ReporterDb,
  groups: readonly ErrorGroup[],
): Promise<Map<string, string>> {
  const ids = [...new Set(groups.map((group) => group.firstId))];
  if (ids.length === 0) return new Map();

  const rows = await db.errorLog.findMany({
    where: { id: { in: ids } },
    select: { id: true, message: true },
    take: ids.length,
  });
  return new Map(rows.map((row) => [String(row.id), row.message]));
}

function bucketize(groups: readonly ErrorGroup[]): Map<string, ErrorGroup[]> {
  const buckets = new Map<string, ErrorGroup[]>();
  for (const group of groups) {
    const key = bucketKey(group);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(group);
    else buckets.set(key, [group]);
  }
  return buckets;
}

function totalOf(groups: readonly ErrorGroup[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

interface BucketBurst {
  anchor: ErrorGroup;
  count: number;
  groups: ErrorGroup[];
}

/** Поводы одного бакета «клиент × площадка», найденные за один проход. */
interface BucketFindings {
  burst?: BucketBurst;
  auth?: ErrorGroup;
  units?: ErrorGroup;
  approval?: ErrorGroup;
  /** Отказы отчётности, сгруппированные по этапу и виду отказа. */
  reports: ErrorGroup[][];
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
  const lookbackMinutes = Math.max(windowMinutes, ERROR_LOOKBACK_MINUTES);
  const burstSince = new Date(now.getTime() - windowMinutes * 60_000);
  const since = new Date(now.getTime() - lookbackMinutes * 60_000);

  const lookback = await groupErrors(deps.db, since, options.clientId);
  // Окно всплеска уже выборки; при совпадении границ второй запрос не нужен.
  const inWindowScan =
    burstSince.getTime() === since.getTime()
      ? lookback
      : await groupErrors(deps.db, burstSince, options.clientId);

  const alerts: Alert[] = [];

  // Первым делом — признание в неполноте. Оно обязано быть тревогой, а не
  // строчкой в логе: молчание неполного скана неотличимо от «всё хорошо», и
  // именно так проверка самоотключается, никого не предупредив.
  if (lookback.incomplete || inWindowScan.incomplete) {
    log.error({ since, groups: MAX_ERROR_GROUPS }, 'alert scan hit the error group cap');
    alerts.push({
      kind: 'scan_incomplete',
      severity: 'critical',
      key: 'scan_incomplete',
      clientId: null,
      provider: null,
      title: 'Скан тревог видел не весь журнал',
      lines: [
        `Групп ошибок за ${lookbackMinutes} мин больше ${MAX_ERROR_GROUPS} — остальные в прогон не попали.`,
        'Пока это так, тишина по кабинету ничего не доказывает.',
      ],
    });
  }

  const windowBuckets = bucketize(inWindowScan.groups);

  // Поломки площадки ищем до кабинетных: если сыплется вся площадка, разговор
  // идёт о ней, а не о каждом задетом кабинете по отдельности.
  const providerBursts = findProviderBursts(inWindowScan.groups, threshold);
  const widespread = new Map<Provider, string>();
  for (const burst of providerBursts) {
    widespread.set(burst.provider, `provider_burst:${burst.provider}`);
  }

  const findings = new Map<string, BucketFindings>();
  for (const [key, groups] of bucketize(lookback.groups)) {
    // Порог из ТЗ задан на окно — считаем строго по нему, хотя выбрали шире.
    const inWindow = windowBuckets.get(key) ?? [];
    const count = totalOf(inWindow);
    const anchor = inWindow[0];

    const reports = new Map<string, ErrorGroup[]>();
    for (const group of groups) {
      if (group.code === null || !REPORT_FAILURE_CODE_VALUES.has(group.code)) continue;
      const reportKey = `${reportStage(group.scope)}|${group.code}`;
      const same = reports.get(reportKey);
      if (same) same.push(group);
      else reports.set(reportKey, [group]);
    }

    findings.set(key, {
      ...(anchor && count > threshold ? { burst: { anchor, count, groups: inWindow } } : {}),
      auth: groups.find((group) => group.code !== null && AUTH_CODES.has(group.code)),
      units: groups.find((group) => group.code !== null && UNITS_CODES.has(group.code)),
      approval: groups.find((group) => group.code === APPROVAL_NOT_DELIVERED_CODE),
      reports: [...reports.values()],
    });
  }

  // Тексты — одним запросом на все найденные поводы разом, и только после того,
  // как поводы найдены: до этого момента ни одна строка журнала не читалась.
  const samples = await loadSamples(deps.db, [
    ...providerBursts.map((burst) => burst.anchor),
    ...[...findings.values()].flatMap((found) =>
      [
        found.burst?.anchor,
        found.auth,
        found.units,
        found.approval,
        ...found.reports.map((r) => r[0]),
      ].filter((group): group is ErrorGroup => group !== undefined),
    ),
  ]);
  const messageOf = (group: ErrorGroup): string => samples.get(String(group.firstId)) ?? '';

  for (const burst of providerBursts) {
    const loud = burst.clients.filter(([, count]) => count > threshold);
    alerts.push({
      kind: 'provider_burst',
      severity: 'critical',
      key: `provider_burst:${burst.provider}`,
      // Клиента нет намеренно: поломка не принадлежит ни одному кабинету.
      clientId: null,
      provider: burst.provider,
      title: `${burst.count} ошибок ${burst.provider} за ${windowMinutes} мин`,
      lines: [
        `Кабинетов задето: ${burst.clients.length} — похоже на площадку, а не на один кабинет.`,
        ...burst.clients.slice(0, 3).map(([clientId, count]) => `${clientId}: ${count}`),
        ...(loud.length > 0 ? [`Сверх кабинетного порога: ${listClients(loud)}.`] : []),
        `Первая: ${formatMsk(burst.anchor.firstAt, 'HH:mm')} — ${truncate(messageOf(burst.anchor), 160)}`,
        ...topCodes(burst.groups).map(([code, count]) => `${code}: ${count}`),
      ],
    });
  }

  for (const [key, found] of findings) {
    const burst = found.burst;
    if (burst) {
      // Тревога по площадке уже назовёт этот кабинет строкой — второе сообщение
      // об одной поломке лишнее. Но именно свёрнута, а не выброшена: если
      // родитель промолчит, этот повод уйдёт сам.
      const parent =
        burst.anchor.provider === null ? undefined : widespread.get(burst.anchor.provider);
      alerts.push({
        kind: 'error_burst',
        severity: 'critical',
        key: `error_burst:${key}`,
        foldedInto: parent,
        clientId: burst.anchor.clientId,
        provider: burst.anchor.provider,
        title: `${burst.count} ошибок за ${windowMinutes} мин`,
        lines: [
          `Кабинет: ${describeScope(burst.anchor)}`,
          `Первая: ${formatMsk(burst.anchor.firstAt, 'HH:mm')} — ${truncate(messageOf(burst.anchor), 160)}`,
          ...topCodes(burst.groups).map(([code, count]) => `${code}: ${count}`),
        ],
      });
    }

    if (found.auth) {
      const auth = found.auth;
      alerts.push({
        kind: 'auth_error',
        severity: 'critical',
        key: `auth_error:${key}`,
        clientId: auth.clientId,
        provider: auth.provider,
        title: 'Токен не принят площадкой',
        lines: [
          `Кабинет: ${describeScope(auth)}`,
          truncate(messageOf(auth), 200),
          'Ретрай бесполезен — нужна переавторизация.',
        ],
      });
    }

    if (found.units) {
      const units = found.units;
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

    if (found.approval) {
      const approval = found.approval;
      alerts.push({
        kind: 'approval_undelivered',
        severity: 'warning',
        key: `approval_undelivered:${key}`,
        cooldownMs: STANDING_ALERT_COOLDOWN_MS,
        clientId: approval.clientId,
        provider: approval.provider,
        title: 'Карточку апрува некому нажать',
        lines: [
          `Кабинет: ${describeScope(approval)}`,
          truncate(messageOf(approval), 200),
          ...(approval.count > 1 ? [`Карточек за выборку: ${approval.count}`] : []),
          'Заявка создана, но не доставлена: без человека она истечёт сама.',
        ],
      });
    }

    for (const groups of found.reports) {
      alerts.push(reportFailure(groups, messageOf));
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
 * Отказ отчётности — один повод на кабинет, этап и вид отказа.
 *
 * Этап (`daily`, `weekly`, `alerts`) входит в ключ подавления: недоставленный
 * дневной отчёт и упавший недельный разбор — разные поломки, и вторая не должна
 * молчать полчаса из-за первой. Вид отказа входит туда же и по той же причине:
 * несобравшийся отчёт и неушедший — разные поломки с разным действием.
 *
 * Вид берётся из кода записи, а не угадывается по этапу. Угадывание было
 * ровно тем, чем выглядело: дневной отчёт, упавший на расчёте, объявлялся
 * неушедшим клиенту, потому что этап называется `daily`.
 */
function reportFailure(
  groups: readonly ErrorGroup[],
  messageOf: (group: ErrorGroup) => string,
): Alert {
  const first = groups[0] as ErrorGroup;
  const stage = reportStage(first.scope);
  const delivery = first.code === REPORT_FAILURE_CODES.delivery;
  const count = totalOf(groups);
  // У `alerts` клиента-получателя нет: этап служебный, отчёта клиенту он не шлёт.
  const clientFacing = stage === 'daily' || stage === 'weekly';
  return {
    kind: 'report_failed',
    severity: 'critical',
    key: `report_failed:${bucketKey(first)}:${stage}:${first.code ?? ''}`,
    clientId: first.clientId,
    provider: first.provider,
    title: delivery ? `Отчёт не ушёл клиенту (${stage})` : `Сбой отчётности (${stage})`,
    lines: [
      `Кабинет: ${describeScope(first)}`,
      truncate(messageOf(first), 200),
      ...(count > 1 ? [`Отказов за выборку: ${count}`] : []),
      ...(clientFacing
        ? [
            'Клиент за этот период отчёта не получил.',
            delivery
              ? 'Текст уже в БД: следующий прогон отправит его без пересчёта.'
              : 'Отчёт не собрался — повтор упрётся в ту же причину, пока её не разобрать.',
          ]
        : []),
    ],
  };
}

/** `reporter:daily` → `daily`. Чужие scope оставляем как есть — врать в заголовке нельзя. */
function reportStage(scope: string): string {
  return scope.startsWith('reporter:') ? scope.slice('reporter:'.length) : scope;
}

/**
 * Распределена ли поломка по кабинетам настолько, чтобы звать её площадкой.
 *
 * Одного «задето ≥ 2 кабинетов» мало, и это была дыра: 50 ошибок протухшего
 * токена у `cl1` плюс одна посторонняя у `cl2` давали тревогу «51 ошибка
 * площадки, кабинетов задето 2» с `clientId: null`. Чинить надо было один
 * кабинет, а сообщение звало разбираться с площадкой — и заодно глушило
 * кабинетную тревогу, которая назвала бы виновника.
 *
 * Площадка — это одна из двух картин, и обе описываются тем же порогом, что и
 * кабинетный всплеск, без новых подобранных чисел:
 *
 *  • порог перебирают сразу несколько кабинетов — сыплется у всех;
 *  • порог вместе перебирают те, кто поодиночке до него не дотягивает, — ровно
 *    тот случай, ради которого счёт по площадке и заводился (6 + 6).
 *
 * Промежуток между ними — один громкий кабинет плюс фоновая мелочь у соседей —
 * остаётся кабинетным: у него есть виновник, и тревога обязана его назвать.
 */
function isWidespread(clients: ReadonlyArray<[string, number]>, threshold: number): boolean {
  const loud = clients.filter(([, count]) => count > threshold);
  if (loud.length >= PROVIDER_BURST_MIN_CLIENTS) return true;

  const quiet = clients.filter(([, count]) => count <= threshold);
  const quietTotal = quiet.reduce((total, [, count]) => total + count, 0);
  return quiet.length >= PROVIDER_BURST_MIN_CLIENTS && quietTotal > threshold;
}

interface ProviderBurst {
  provider: Provider;
  count: number;
  clients: Array<[string, number]>;
  groups: ErrorGroup[];
  anchor: ErrorGroup;
}

/**
 * Всплеск по площадке целиком.
 *
 * Считается по тем же группам и тому же окну, что и всплеск по бакету, но без
 * разбиения по клиентам. Поднимается, только когда ошибки действительно
 * размазаны по кабинетам (`isWidespread`), а не просто попали в два бакета.
 *
 * Найденная поломка площадки сворачивает кабинетные всплески по ней в свою
 * строку (см. вызов): иначе отвалившаяся у полусотни клиентов площадка вместо
 * одного внятного сообщения давала бы полсотни почти одинаковых, растянутых
 * лимитом прогона на час. Свёрнутые кабинеты названы поимённо — «похоже на
 * площадку» не должно означать «с кем разбираться, догадайся сам». Кабинетные
 * поводы со своим действием — переавторизация, кончившиеся units, неушедший
 * отчёт — остаются отдельными: они про конкретного клиента.
 */
function findProviderBursts(groups: readonly ErrorGroup[], threshold: number): ProviderBurst[] {
  const byProvider = new Map<Provider, ErrorGroup[]>();
  for (const group of groups) {
    if (group.provider === null) continue;
    const bucket = byProvider.get(group.provider);
    if (bucket) bucket.push(group);
    else byProvider.set(group.provider, [group]);
  }

  const bursts: ProviderBurst[] = [];
  for (const [provider, inWindow] of byProvider) {
    const count = totalOf(inWindow);
    if (count <= threshold) continue;
    const clients = countBy(inWindow, (group) => group.clientId ?? 'без клиента');
    if (clients.length < PROVIDER_BURST_MIN_CLIENTS) continue;
    if (!isWidespread(clients, threshold)) continue;

    const anchor = inWindow[0];
    if (!anchor) continue;
    bursts.push({ provider, count, clients, groups: inWindow, anchor });
  }

  return bursts;
}

/** Кабинеты с числами в одну строку: три поимённо, остальные счётом. */
function listClients(clients: ReadonlyArray<[string, number]>): string {
  const named = clients.slice(0, 3).map(([clientId, count]) => `${clientId} (${count})`);
  const rest = clients.length - named.length;
  return rest > 0 ? `${named.join(', ')} и ещё ${rest}` : named.join(', ');
}

function describeScope(group: ErrorGroup): string {
  return [group.provider ?? 'система', group.clientId ?? 'без клиента', group.scope].join(' / ');
}

function topCodes(groups: readonly ErrorGroup[]): Array<[string, number]> {
  return countBy(groups, (group) => group.code ?? group.scope).slice(0, 3);
}

/** Счётчик по ключу, от частого к редкому. */
function countBy(
  groups: readonly ErrorGroup[],
  key: (group: ErrorGroup) => string,
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    const value = key(group);
    counts.set(value, (counts.get(value) ?? 0) + group.count);
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
    folded: 0,
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
  const allowed = alerts.filter((alert) => limiter.isAllowed(alert.key, now));
  summary.suppressed = alerts.length - allowed.length;

  /**
   * Свёрнутые поводы — только под родителя, который сегодня заговорит.
   *
   * Родитель в тишине не имеет права уносить их с собой: тогда полчаса тишины
   * по площадке съедали бы и всплеск у кабинета, сломавшегося уже после того,
   * как тревога по площадке ушла. Своя тишина у свёрнутого повода тоже есть —
   * её ставит доставка родителя (`markSent` ниже), потому что внутри его текста
   * повод человеку рассказан.
   */
  const speaking = new Set(allowed.map((alert) => alert.key));
  const foldedUnder = new Map<string, Alert[]>();
  const passing: Alert[] = [];
  for (const alert of allowed) {
    const parent = alert.foldedInto;
    if (parent !== undefined && parent !== alert.key && speaking.has(parent)) {
      const siblings = foldedUnder.get(parent);
      if (siblings) siblings.push(alert);
      else foldedUnder.set(parent, [alert]);
      summary.folded += 1;
      continue;
    }
    passing.push(alert);
  }

  // Резать хвост придётся по лимиту прогона — пусть под нож идёт warning,
  // а не 401, который дороже всех остальных вместе взятых.
  passing.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const toSend = passing.slice(0, MAX_ALERTS_PER_RUN);
  summary.truncated = passing.length - toSend.length;

  for (const alert of toSend) {
    try {
      await deps.messenger().sendMarkdown(chatId, renderAlert(alert));
      // Только здесь: недоставленный алерт обязан пробиться на следующем тике,
      // а не молчать полчаса, ни разу никому не показавшись.
      limiter.markSent(alert.key, now, alert.cooldownMs);
      for (const folded of foldedUnder.get(alert.key) ?? []) {
        limiter.markSent(folded.key, now, folded.cooldownMs);
      }
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
    {
      detected: summary.detected,
      sent: summary.sent,
      suppressed: summary.suppressed,
      folded: summary.folded,
    },
    'alert scan finished',
  );
  return summary;
}
