import { describe, expect, it } from 'vitest';

import { formatMsk, lastNDaysMsk, mskDateToUtc, todayMsk, ymdMsk } from '@/lib/dates.js';

describe('dates (МСК = UTC+3, без перехода на летнее время)', () => {
  it('относит поздний вечер UTC к следующим суткам по МСК', () => {
    // 21:30 UTC — это уже 00:30 следующего дня в Москве. Отчёт «за вчера»
    // обязан считать по МСК, иначе в 08:30 придут данные не за тот день.
    expect(todayMsk(new Date('2026-08-07T21:30:00Z'))).toBe('2026-08-08');
    expect(todayMsk(new Date('2026-08-07T20:59:00Z'))).toBe('2026-08-07');
  });

  it('ymdMsk совпадает с todayMsk', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    expect(ymdMsk(d)).toBe(todayMsk(d));
  });

  it('lastNDaysMsk исключает сегодня', () => {
    const now = new Date('2026-08-08T10:00:00Z');
    expect(lastNDaysMsk(7, now)).toEqual({ from: '2026-08-01', to: '2026-08-07' });
  });

  it('lastNDaysMsk для одного дня — это вчера', () => {
    const now = new Date('2026-08-08T10:00:00Z');
    expect(lastNDaysMsk(1, now)).toEqual({ from: '2026-08-07', to: '2026-08-07' });
  });

  it('lastNDaysMsk корректно переходит через границу месяца', () => {
    const now = new Date('2026-03-02T10:00:00Z');
    expect(lastNDaysMsk(5, now)).toEqual({ from: '2026-02-25', to: '2026-03-01' });
  });

  it('mskDateToUtc даёт 21:00 UTC предыдущих суток', () => {
    expect(mskDateToUtc('2026-08-08').toISOString()).toBe('2026-08-07T21:00:00.000Z');
  });

  it('mskDateToUtc и ymdMsk взаимно обратны', () => {
    for (const ymd of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      expect(ymdMsk(mskDateToUtc(ymd))).toBe(ymd);
    }
  });

  it('formatMsk печатает московское время', () => {
    expect(formatMsk(new Date('2026-08-08T05:30:00Z'))).toBe('08.08.2026 08:30');
  });
});
