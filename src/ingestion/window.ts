import { subDays } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

import type { DateRange } from '@/channels/types.js';
import { todayMsk } from '@/lib/dates.js';

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
  // Арифметика по календарным датам, а не по моментам: toZonedTime плюс
  // ymdMsk применяли сдвиг +3 дважды, и после 21:00 МСК окно съезжало на сутки.
  const today = todayMsk(now);
  const anchored = new Date(`${today}T00:00:00Z`);
  return {
    from: formatInTimeZone(subDays(anchored, Math.max(days, 1) - 1), 'UTC', 'yyyy-MM-dd'),
    to: today,
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
