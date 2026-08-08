import { describe, expect, it } from 'vitest';

import {
  daysBetween,
  eachDay,
  formatYmd,
  isYmd,
  mskDateToUtc,
  shiftYmd,
  todayMsk,
  ymdToDateColumn,
} from './dates';

describe('todayMsk', () => {
  it('после 21:00 UTC в Москве уже следующий день', () => {
    expect(todayMsk(new Date('2026-08-08T21:30:00.000Z'))).toBe('2026-08-09');
  });

  it('до 21:00 UTC день ещё тот же', () => {
    expect(todayMsk(new Date('2026-08-08T20:30:00.000Z'))).toBe('2026-08-08');
  });
});

describe('mskDateToUtc', () => {
  it('начало московских суток — 21:00 предыдущего дня UTC', () => {
    expect(mskDateToUtc('2026-08-08').toISOString()).toBe('2026-08-07T21:00:00.000Z');
  });
});

describe('ymdToDateColumn', () => {
  it('для колонки @db.Date нужна именно UTC-полночь', () => {
    expect(ymdToDateColumn('2026-08-08').toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });
});

describe('shiftYmd', () => {
  it('переходит через границу месяца', () => {
    expect(shiftYmd('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('окно в 30 дней заканчивается сегодняшним днём', () => {
    expect(shiftYmd('2026-08-08', -29)).toBe('2026-07-10');
    expect(daysBetween('2026-07-10', '2026-08-08') + 1).toBe(30);
  });
});

describe('eachDay', () => {
  it('отдаёт непрерывный ряд включительно', () => {
    const days = eachDay('2026-08-06', '2026-08-08');
    expect(days).toEqual(['2026-08-06', '2026-08-07', '2026-08-08']);
  });

  it('вывернутый период — пустой ряд, а не бесконечный цикл', () => {
    expect(eachDay('2026-08-08', '2026-08-01')).toEqual([]);
  });
});

describe('прочее', () => {
  it('isYmd отсекает мусор из адресной строки', () => {
    expect(isYmd('2026-08-08')).toBe(true);
    expect(isYmd('08.08.2026')).toBe(false);
    expect(isYmd('2026-13-40')).toBe(false);
  });

  it('formatYmd переворачивает дату в привычный вид', () => {
    expect(formatYmd('2026-08-08')).toBe('08.08.2026');
  });
});
