import { describe, expect, it } from 'vitest';

import {
  datesInRange,
  STATS_WINDOW_DAYS,
  trailingWindowMsk,
  ymdToDateColumn,
} from '@/ingestion/window.js';

describe('trailingWindowMsk', () => {
  it('окно в 21 день заканчивается сегодняшним днём по МСК', () => {
    expect(trailingWindowMsk(STATS_WINDOW_DAYS, new Date('2026-08-08T09:00:00Z'))).toEqual({
      from: '2026-07-19',
      to: '2026-08-08',
    });
  });

  it('после 21:00 UTC в Москве уже завтра', () => {
    expect(trailingWindowMsk(1, new Date('2026-08-08T21:30:00Z'))).toEqual({
      from: '2026-08-09',
      to: '2026-08-09',
    });
  });

  it('корректно переходит через границу года', () => {
    expect(trailingWindowMsk(3, new Date('2026-01-02T09:00:00Z'))).toEqual({
      from: '2025-12-31',
      to: '2026-01-02',
    });
  });
});

describe('ymdToDateColumn', () => {
  it('даёт UTC-полночь: Postgres приводит timestamp к date по UTC', () => {
    expect(ymdToDateColumn('2026-08-08').toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });
});

describe('datesInRange', () => {
  it('перечисляет все даты окна включительно', () => {
    expect(datesInRange({ from: '2026-08-06', to: '2026-08-08' })).toEqual([
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
    ]);
  });

  it('окно из одного дня — один день', () => {
    expect(datesInRange({ from: '2026-08-08', to: '2026-08-08' })).toEqual(['2026-08-08']);
  });
});
