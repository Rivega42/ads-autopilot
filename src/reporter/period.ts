import { ymdToDateColumn } from '@/ingestion/window.js';
import { ymdMsk } from '@/lib/dates.js';
import { formatDayFull, formatDayShort } from '@/reporter/format.js';

/**
 * Границы отчётных периодов.
 *
 * Период — это пара дат `yyyy-MM-dd` по МСК, обе включительно. Дальше в БД
 * они превращаются в UTC-полночь через `ymdToDateColumn`: колонка
 * `CampaignStat.date` объявлена как `@db.Date`, и московская полночь
 * (21:00 предыдущих суток UTC) записалась бы туда предыдущим числом.
 *
 * Сдвиг на сутки считается в пространстве дат, а не вычитанием из `Date`:
 * `lastNDaysMsk` из `src/lib/dates.ts` сначала зонирует момент в МСК, а потом
 * ещё раз форматирует его как МСК, поэтому на сервере в UTC любой запуск с
 * 21:00 до 24:00 МСК уезжает на сутки вперёд. Для крона в 08:30 это незаметно,
 * для отчёта по требованию — нет.
 */
export interface ReportPeriod {
  /** Первый день периода, `yyyy-MM-dd` по МСК. */
  from: string;
  /** Последний день периода включительно. */
  to: string;
}

export const WEEK_DAYS = 7;

/** Календарный сдвиг даты. Работает в UTC-полуночи, поэтому от TZ сервера не зависит. */
export function shiftYmd(ymd: string, days: number): string {
  const date = ymdToDateColumn(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function todayMskYmd(now: Date = new Date()): string {
  return ymdMsk(now);
}

/** Вчерашние сутки по МСК — период дневного отчёта (ТЗ §9.2). */
export function yesterdayPeriod(now: Date = new Date()): ReportPeriod {
  const day = shiftYmd(todayMskYmd(now), -1);
  return { from: day, to: day };
}

/** Последние семь полных суток по МСК; сегодняшний неполный день не входит. */
export function lastWeekPeriod(now: Date = new Date()): ReportPeriod {
  const to = shiftYmd(todayMskYmd(now), -1);
  return { from: shiftYmd(to, -(WEEK_DAYS - 1)), to };
}

/** Скользящее окно из `days` полных суток, заканчивающееся вчера. */
export function trailingPeriod(days: number, now: Date = new Date()): ReportPeriod {
  const to = shiftYmd(todayMskYmd(now), -1);
  return { from: shiftYmd(to, -(Math.max(days, 1) - 1)), to };
}

export function periodDays(period: ReportPeriod): number {
  const from = ymdToDateColumn(period.from).getTime();
  const to = ymdToDateColumn(period.to).getTime();
  return Math.floor((to - from) / 86_400_000) + 1;
}

/** Такой же по длине период, прижатый к левому краю текущего: с чем сравниваем. */
export function previousPeriod(period: ReportPeriod): ReportPeriod {
  const length = periodDays(period);
  return { from: shiftYmd(period.from, -length), to: shiftYmd(period.to, -length) };
}

/** Все даты периода по порядку — чтобы в графике не пропадали дни без открутки. */
export function eachDay(period: ReportPeriod): string[] {
  const days: string[] = [];
  for (let cursor = period.from; cursor <= period.to; cursor = shiftYmd(cursor, 1)) {
    days.push(cursor);
    // Защита от периода наизнанку: без неё цикл не закончится никогда.
    if (days.length > 400) break;
  }
  return days;
}

/** Фильтр для `where.date` в Prisma. */
export function periodFilter(period: ReportPeriod): { gte: Date; lte: Date } {
  return { gte: ymdToDateColumn(period.from), lte: ymdToDateColumn(period.to) };
}

export function periodContains(period: ReportPeriod, ymd: string): boolean {
  return ymd >= period.from && ymd <= period.to;
}

/** `07.08.2026` для одного дня, `01.08 — 07.08.2026` для диапазона. */
export function formatPeriod(period: ReportPeriod): string {
  if (period.from === period.to) return formatDayFull(period.to);
  return `${formatDayShort(period.from)} — ${formatDayFull(period.to)}`;
}
