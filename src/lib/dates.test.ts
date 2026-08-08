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

  // Полоса 21:00–24:00 МСК: прежняя реализация применяла сдвиг +3 дважды и
  // возвращала здесь сегодняшний день вместо вчерашнего. Прошлый тест брал
  // 10:00 UTC и в эту полосу не попадал.
  it.each([
    ['2026-08-08T18:00:00Z', '21:00 МСК'],
    ['2026-08-08T19:00:00Z', '22:00 МСК'],
    ['2026-08-08T20:59:00Z', '23:59 МСК'],
  ])('lastNDaysMsk корректен поздним вечером МСК (%s, %s)', (iso) => {
    expect(lastNDaysMsk(1, new Date(iso))).toEqual({ from: '2026-08-07', to: '2026-08-07' });
  });

  it('lastNDaysMsk переключается на новый день сразу после полуночи МСК', () => {
    // 21:00 UTC — уже 00:00 следующих суток в Москве.
    expect(lastNDaysMsk(1, new Date('2026-08-08T21:00:00Z'))).toEqual({
      from: '2026-08-08',
      to: '2026-08-08',
    });
  });

  it('lastNDaysMsk согласован с todayMsk в любое время суток', () => {
    for (let hour = 0; hour < 24; hour++) {
      const now = new Date(`2026-08-08T${String(hour).padStart(2, '0')}:30:00Z`);
      const { to } = lastNDaysMsk(1, now);
      // «Вчера» обязано быть ровно на день раньше «сегодня» по МСК.
      const expected = formatMsk(
        new Date(new Date(`${todayMsk(now)}T00:00:00Z`).getTime() - 86_400_000),
        'yyyy-MM-dd',
      );
      expect(to, `час ${hour}:30 UTC`).toBe(expected);
    }
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
