import { subDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { MSK } from '@/constants.js';

/** Все отчётные периоды считаются по МСК, независимо от TZ сервера. */
export function todayMsk(now: Date = new Date()): string {
  return formatInTimeZone(now, MSK, 'yyyy-MM-dd');
}

export function ymdMsk(date: Date): string {
  return formatInTimeZone(date, MSK, 'yyyy-MM-dd');
}

/**
 * Последние N полных дней по МСК, не включая сегодня. Границы включительные.
 *
 * Арифметика идёт по календарным датам, а не по моментам времени. Прежняя
 * версия звала toZonedTime, а результат печатала через formatInTimeZone —
 * сдвиг +3 применялся дважды, и после 21:00 МСК «вчера» превращалось в
 * «сегодня». Крон в 08:30 в эту полосу не попадал, поэтому баг не проявлялся,
 * но отчёт по требованию вечером показал бы не тот день.
 */
export function lastNDaysMsk(n: number, now: Date = new Date()): { from: string; to: string } {
  const todayUtcAnchored = new Date(`${todayMsk(now)}T00:00:00Z`);
  const ymdUtc = (d: Date) => formatInTimeZone(d, 'UTC', 'yyyy-MM-dd');
  return {
    from: ymdUtc(subDays(todayUtcAnchored, n)),
    to: ymdUtc(subDays(todayUtcAnchored, 1)),
  };
}

/**
 * `yyyy-MM-dd` по МСК → момент начала этих суток в МСК, выраженный в UTC.
 * Это 21:00 предыдущего дня, а НЕ полночь UTC.
 *
 * Для колонок `@db.Date` не годится: Postgres отбросит время и сохранит
 * предыдущую дату. Там нужна UTC-полночь — см. `ingestion/window.ymdToDateColumn`.
 */
export function mskDateToUtc(ymd: string): Date {
  return fromZonedTime(`${ymd}T00:00:00`, MSK);
}

export function formatMsk(date: Date, pattern = 'dd.MM.yyyy HH:mm'): string {
  return formatInTimeZone(date, MSK, pattern);
}
