import { subDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

import type { DateRange } from '@/channels/types.js';

import { MSK } from '@/constants.js';
import { ymdMsk } from '@/lib/dates.js';

/**
 * Конверсии из Метрики доезжают до 21 дня (ТЗ §2.1), поэтому вчерашняя цифра
 * меняется ещё три недели. Каждый прогон перезаливает всё окно целиком —
 * иначе в БД навсегда останется первая, заниженная версия дня.
 */
export const STATS_WINDOW_DAYS = 21;

/**
 * Окно `days` последних суток по МСК, включая сегодняшний неполный день.
 *
 * Сегодня включён намеренно: `fetch-stats-hourly` крутится каждый час, и отчёт
 * «сколько потрачено сегодня» нужен раньше, чем наступит завтра. Перезапись
 * неполного дня безопасна — ключ upsert'а тот же самый.
 */
export function trailingWindowMsk(days: number, now: Date = new Date()): DateRange {
  const zoned = toZonedTime(now, MSK);
  return {
    from: ymdMsk(subDays(zoned, Math.max(days, 1) - 1)),
    to: ymdMsk(zoned),
  };
}

/**
 * `yyyy-MM-dd` → значение для колонки `@db.Date`.
 *
 * Именно UTC-полночь, а не `mskDateToUtc`: Postgres приводит timestamp к date
 * по UTC, и московская полночь (21:00 предыдущих суток UTC) записалась бы
 * вчерашним числом. `mskDateToUtc` верен для timestamp-колонок, здесь — нет.
 */
export function ymdToDateColumn(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** Все даты окна включительно — нужен, чтобы выбрать существующие строки одним запросом. */
export function datesInRange(range: DateRange): string[] {
  const out: string[] = [];
  const last = ymdToDateColumn(range.to).getTime();
  for (let cursor = ymdToDateColumn(range.from); cursor.getTime() <= last; ) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 3600 * 1000);
  }
  return out;
}
