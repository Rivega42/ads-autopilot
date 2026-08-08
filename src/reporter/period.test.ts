import { describe, expect, it } from 'vitest';

import {
  eachDay,
  formatPeriod,
  lastWeekPeriod,
  periodDays,
  periodFilter,
  previousPeriod,
  shiftYmd,
  todayMskYmd,
  trailingPeriod,
  yesterdayPeriod,
} from '@/reporter/period.js';

describe('границы периодов по МСК', () => {
  it('в 21:30 UTC в Москве уже следующие сутки, поэтому «вчера» сдвигается', () => {
    // 08.08 21:30 UTC = 09.08 00:30 МСК → вчерашние сутки по МСК это 08.08.
    expect(yesterdayPeriod(new Date('2026-08-08T21:30:00Z'))).toEqual({
      from: '2026-08-08',
      to: '2026-08-08',
    });
  });

  it('в 19:00 UTC в Москве ещё те же сутки, «вчера» — предыдущий день', () => {
    // 22:00 МСК того же дня. Наивный сдвиг зонированной даты дал бы 08.08.
    expect(yesterdayPeriod(new Date('2026-08-08T19:00:00Z'))).toEqual({
      from: '2026-08-07',
      to: '2026-08-07',
    });
  });

  it('сразу после московской полуночи отчёт уже за прошедшие сутки', () => {
    expect(yesterdayPeriod(new Date('2026-08-08T21:00:00Z'))).toEqual({
      from: '2026-08-08',
      to: '2026-08-08',
    });
    expect(yesterdayPeriod(new Date('2026-08-08T20:59:59Z'))).toEqual({
      from: '2026-08-07',
      to: '2026-08-07',
    });
  });

  it('штатный запуск в 08:30 МСК отчитывается за предыдущий день', () => {
    expect(yesterdayPeriod(new Date('2026-08-08T05:30:00Z'))).toEqual({
      from: '2026-08-07',
      to: '2026-08-07',
    });
  });

  it('сегодняшняя дата берётся по МСК, а не по UTC', () => {
    expect(todayMskYmd(new Date('2026-08-08T21:30:00Z'))).toBe('2026-08-09');
    expect(todayMskYmd(new Date('2026-08-08T20:59:00Z'))).toBe('2026-08-08');
  });

  it('недельный период — семь полных суток, сегодня не входит', () => {
    // Понедельник 10:00 МСК: разбор за прошедшие пн–вс.
    const period = lastWeekPeriod(new Date('2026-08-10T07:00:00Z'));
    expect(period).toEqual({ from: '2026-08-03', to: '2026-08-09' });
    expect(periodDays(period)).toBe(7);
  });

  it('предыдущий период такой же длины и примыкает вплотную', () => {
    expect(previousPeriod({ from: '2026-08-03', to: '2026-08-09' })).toEqual({
      from: '2026-07-27',
      to: '2026-08-02',
    });
    expect(previousPeriod({ from: '2026-08-07', to: '2026-08-07' })).toEqual({
      from: '2026-08-06',
      to: '2026-08-06',
    });
  });

  it('сдвиг даты переживает границы месяца и года', () => {
    expect(shiftYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftYmd('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftYmd('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('фильтр в БД — UTC-полночь, иначе колонка @db.Date уедет на день назад', () => {
    const filter = periodFilter({ from: '2026-08-01', to: '2026-08-07' });
    expect(filter.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(filter.lte.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  it('перечисляет все дни периода включительно', () => {
    expect(eachDay({ from: '2026-08-05', to: '2026-08-08' })).toEqual([
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
    ]);
    expect(eachDay({ from: '2026-08-05', to: '2026-08-05' })).toEqual(['2026-08-05']);
    expect(eachDay({ from: '2026-08-05', to: '2026-08-04' })).toEqual([]);
  });

  it('скользящее окно заканчивается вчерашним днём', () => {
    expect(trailingPeriod(8, new Date('2026-08-08T05:30:00Z'))).toEqual({
      from: '2026-07-31',
      to: '2026-08-07',
    });
  });

  it('подписывает один день датой, а диапазон — двумя', () => {
    expect(formatPeriod({ from: '2026-08-07', to: '2026-08-07' })).toBe('07.08.2026');
    expect(formatPeriod({ from: '2026-08-01', to: '2026-08-07' })).toBe('01.08 — 07.08.2026');
  });
});
