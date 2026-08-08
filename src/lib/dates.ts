import { subDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

import { MSK } from '@/constants.js';

/** Все отчётные периоды считаются по МСК, независимо от TZ сервера. */
export function todayMsk(now: Date = new Date()): string {
  return formatInTimeZone(now, MSK, 'yyyy-MM-dd');
}

export function ymdMsk(date: Date): string {
  return formatInTimeZone(date, MSK, 'yyyy-MM-dd');
}

/** Полуинтервал последних N полных дней по МСК, не включая сегодня. */
export function lastNDaysMsk(n: number, now: Date = new Date()): { from: string; to: string } {
  const zoned = toZonedTime(now, MSK);
  const to = subDays(zoned, 1);
  const from = subDays(zoned, n);
  return {
    from: formatInTimeZone(from, MSK, 'yyyy-MM-dd'),
    to: formatInTimeZone(to, MSK, 'yyyy-MM-dd'),
  };
}

/** `yyyy-MM-dd` по МСК → UTC-полночь этой даты, как хранит Postgres `@db.Date`. */
export function mskDateToUtc(ymd: string): Date {
  return fromZonedTime(`${ymd}T00:00:00`, MSK);
}

export function formatMsk(date: Date, pattern = 'dd.MM.yyyy HH:mm'): string {
  return formatInTimeZone(date, MSK, pattern);
}
