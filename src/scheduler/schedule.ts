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

const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const WEEK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Период крона в минутах: наибольший разрыв между соседними запусками.
 *
 * Считаются и суточные, и недельные расписания, и отбор по числам месяца. Раньше
 * разбирались только кроны внутри часа, а всё остальное объявлялось часовым — и это
 * было занижением, а не запасом: у `30 8 * * *` разрыв между запусками равен суткам,
 * то есть период возвращался в 24 раза меньше настоящего. Потребители выводят отсюда
 * глубину выборки и сроки жизни захватов, а заниженный период возвращает ровно ту
 * слепую зону, ради закрытия которой величину и считают из расписания.
 *
 * Час остаётся только для двух случаев: расписания нет вовсе (`null`) и выражение
 * разобрать не удалось. Второе — единственная догадка, которая здесь осталась;
 * она безопасна ровно настолько, насколько выражения приходят из `CRON_SCHEDULE`
 * рядом, а не из пользовательского ввода.
 */
export function cronIntervalMinutes(expression: string | null): number {
  if (expression === null) return HOUR_MINUTES;

  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return HOUR_MINUTES;
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minutes = expandField(minuteField, 0, 59);
  const hours = expandField(hourField, 0, 23);
  if (minutes === null || hours === null) return HOUR_MINUTES;

  const times: number[] = [];
  for (const hour of hours) for (const minute of minutes) times.push(hour * HOUR_MINUTES + minute);
  times.sort((a, b) => a - b);
  if (times.length === 0) return HOUR_MINUTES;

  const dayGap = maxDayGap(domField, monthField, dowField);
  if (dayGap === null) return HOUR_MINUTES;

  let gap = 0;
  for (let i = 1; i < times.length; i += 1) {
    gap = Math.max(gap, (times[i] as number) - (times[i - 1] as number));
  }
  const first = times[0] as number;
  const last = times[times.length - 1] as number;
  // Переход через полночь: хвост суток запуска, начало следующих суток с запуском и
  // целые сутки без запусков между ними.
  return Math.max(gap, DAY_MINUTES - last + first + (dayGap - 1) * DAY_MINUTES);
}

/**
 * Наибольший разрыв в сутках между днями, когда крон вообще запускается.
 *
 * Три регистра, потому что дороже всего здесь ошибиться в меньшую сторону:
 * каждый день (1), недельный цикл (считается по семи дням) и отбор по числам
 * месяца или месяцам — он считается по настоящему календарю, потому что длина
 * месяца меняет ответ: у отбора «каждое третье число» разрыв 28→1 в тридцатидневном
 * месяце равен трём суткам, а в тридцать первом — одним.
 *
 * @returns null, если поля разобрать не удалось или совпадений нет вовсе.
 */
function maxDayGap(domField: string, monthField: string, dowField: string): number | null {
  const restrictedDom = domField !== '*';
  const restrictedDow = dowField !== '*';
  const restrictedMonth = monthField !== '*';
  if (!restrictedDom && !restrictedDow && !restrictedMonth) return 1;

  const dom = expandField(domField, 1, 31);
  const month = expandField(monthField, 1, 12);
  // Воскресенье пишут и нулём, и семёркой — это один день, поэтому 7 сводим к 0.
  const dow = expandField(dowField, 0, 7)?.map((day) => day % WEEK_DAYS);
  if (dom === null || month === null || dow === null) return null;

  const domSet = new Set(dom);
  const monthSet = new Set(month);
  const dowSet = new Set(dow);

  const matches = (date: Date): boolean => {
    if (!monthSet.has(date.getUTCMonth() + 1)) return false;
    const byDom = domSet.has(date.getUTCDate());
    const byDow = dowSet.has(date.getUTCDay());
    // Классическая семантика крона: заданы оба поля — совпадение по любому из них.
    if (restrictedDom && restrictedDow) return byDom || byDow;
    if (restrictedDom) return byDom;
    if (restrictedDow) return byDow;
    return true;
  };

  if (!restrictedDom && !restrictedMonth) {
    const days = [...Array(WEEK_DAYS).keys()].filter((day) => dowSet.has(day));
    if (days.length === 0) return null;
    let gap = (days[0] as number) + WEEK_DAYS - (days[days.length - 1] as number);
    for (let i = 1; i < days.length; i += 1) {
      gap = Math.max(gap, (days[i] as number) - (days[i - 1] as number));
    }
    return gap;
  }

  // Четыре года покрывают високосный и все длины месяцев; края окна не считаются
  // разрывом — они артефакт границы, а не расписания.
  const SPAN_DAYS = 4 * 366;
  const start = Date.UTC(2024, 0, 1);
  let previous: number | null = null;
  let gap = 0;
  for (let day = 0; day < SPAN_DAYS; day += 1) {
    if (!matches(new Date(start + day * DAY_MS))) continue;
    if (previous !== null) gap = Math.max(gap, day - previous);
    previous = day;
  }
  // Реже раза в четыре года — считать нечего; берём всё окно, потому что ошибка
  // в меньшую сторону здесь дороже ошибки в большую.
  if (gap === 0) return previous === null ? null : SPAN_DAYS;
  return gap;
}

/**
 * Поле крона в список значений диапазона. Непонятное поле — null, а не пустой список:
 * «не разобрали» и «не совпадает никогда» — разные ответы.
 */
function expandField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    if (range === undefined) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let from = min;
    let to = max;
    if (range !== '*') {
      const [fromText, toText] = range.split('-');
      from = Number(fromText);
      to = toText === undefined ? from : Number(toText);
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
      if (from < min || to > max || from > to) return null;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return values.size === 0 ? null : [...values].sort((a, b) => a - b);
}
