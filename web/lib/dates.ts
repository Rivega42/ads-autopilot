/**
 * Даты дашборда — по МСК, как и все отчётные периоды сервиса.
 *
 * Дубликат минимума из `src/lib/dates.ts` и `src/ingestion/window.ts`: корневой
 * пакет не публикует `exports`, собранного `dist` на момент сборки веба нет, и
 * тянуть в Next весь `src/env.ts` (zod-валидация всех ключей площадок) ради двух
 * функций — дороже, чем повторить их. Дублируется только то, что здесь нужно;
 * поведение обязано совпадать с оригиналом.
 */

export const MSK = 'Europe/Moscow';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const MSK_YMD = new Intl.DateTimeFormat('ru-RU', {
  timeZone: MSK,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MSK_ISO = new Intl.DateTimeFormat('en-GB', {
  timeZone: MSK,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const MSK_DATE_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: MSK,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Сегодняшняя дата по МСК в виде `yyyy-MM-dd`. */
export function todayMsk(now: Date = new Date()): string {
  const parts = MSK_YMD.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isYmd(value: string): boolean {
  return YMD.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

/**
 * `yyyy-MM-dd` → значение для колонки `@db.Date`.
 *
 * Именно UTC-полночь: Postgres приводит timestamp к date по UTC, и московская
 * полночь (21:00 предыдущих суток UTC) записалась бы вчерашним числом. Та же
 * логика, что в `src/ingestion/window.ts#ymdToDateColumn`.
 */
export function ymdToDateColumn(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * `yyyy-MM-dd` по МСК → момент начала этих суток, выраженный в UTC.
 *
 * Для колонок `@db.Date` не годится — там нужна `ymdToDateColumn`. Эта функция
 * для timestamp-колонок (`ChangeLog.appliedAt`, `PendingApproval.createdAt`):
 * граница «с 8 августа» — это 21:00 седьмого по UTC, а не полночь UTC.
 *
 * Смещение берётся у Intl, а не константой +03:00: правила зон меняются, и
 * захардкоженный сдвиг молча сместил бы все отчёты на час.
 */
export function mskDateToUtc(ymd: string): Date {
  const naive = Date.parse(`${ymd}T00:00:00.000Z`);
  // Смещение зависит от момента, а момент — от смещения; двух итераций хватает
  // с запасом, переходы зон не превышают часа.
  let guess = naive - mskOffsetMs(new Date(naive));
  guess = naive - mskOffsetMs(new Date(guess));
  return new Date(guess);
}

function mskOffsetMs(instant: Date): number {
  const parts = MSK_ISO.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - instant.getTime();
}

/** Обратное преобразование колонки `@db.Date` в `yyyy-MM-dd`. */
export function dateColumnToYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Календарный сдвиг строки `yyyy-MM-dd`; знак `days` задаёт направление. */
export function shiftYmd(ymd: string, days: number): string {
  const shifted = new Date(`${ymd}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Полуоткрытое сравнение календарных строк — они лексикографически упорядочены. */
export function compareYmd(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Все даты от `from` до `to` включительно. Пустой массив, если период вывернут. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  // Верхняя граница нужна, чтобы кривой параметр в URL не увёл цикл в бесконечность.
  for (let guard = 0; guard < 3660 && compareYmd(cursor, to) <= 0; guard += 1) {
    days.push(cursor);
    cursor = shiftYmd(cursor, 1);
  }
  return days;
}

export function daysBetween(from: string, to: string): number {
  const ms = ymdToDateColumn(to).getTime() - ymdToDateColumn(from).getTime();
  return Math.round(ms / 86_400_000);
}

/** `2026-08-08` → `08.08.2026`. */
export function formatYmd(ymd: string): string {
  const [year, month, day] = ymd.split('-');
  return year && month && day ? `${day}.${month}.${year}` : ymd;
}

/** `2026-08-08` → `08.08` — для подписей оси. */
export function formatYmdShort(ymd: string): string {
  const [, month, day] = ymd.split('-');
  return month && day ? `${day}.${month}` : ymd;
}

/** Момент времени → `08.08.2026, 17:32` по МСК. */
export function formatMskDateTime(date: Date): string {
  return MSK_DATE_TIME.format(date);
}
