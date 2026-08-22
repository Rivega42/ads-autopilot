import { describe, expect, it } from 'vitest';

import {
  formatDayFull,
  formatDayLabel,
  formatDayShort,
  formatInt,
  formatMoney,
  formatPctChange,
  formatPctMagnitude,
  formatRatio,
  trendArrow,
  truncate,
  DASH,
} from '@/reporter/format.js';

describe('деньги и числа', () => {
  it('группирует разряды пробелом и округляет до рубля', () => {
    expect(formatMoney(87_200)).toBe('87 200 ₽');
    expect(formatMoney(1234.56)).toBe('1 235 ₽');
    expect(formatMoney(0)).toBe('0 ₽');
  });

  it('отсутствующая сумма — прочерк, а не ноль', () => {
    expect(formatMoney(null)).toBe(DASH);
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe(DASH);
  });

  it('целые числа тоже группируются', () => {
    expect(formatInt(47)).toBe('47');
    expect(formatInt(1_000_000)).toBe('1 000 000');
    expect(formatInt(-1500)).toBe('−1 500');
  });
});

describe('проценты', () => {
  it('показывает знак и округляет', () => {
    expect(formatPctChange(12.4)).toBe('+12%');
    expect(formatPctChange(-7.6)).toBe('−8%');
  });

  it('нулевое изменение остаётся без знака', () => {
    expect(formatPctChange(0)).toBe('0%');
    expect(formatPctChange(0.2)).toBe('0%');
  });

  it('отсутствие базы даёт прочерк, а не «+∞%»', () => {
    expect(formatPctChange(null)).toBe(DASH);
    expect(formatPctMagnitude(null)).toBe(DASH);
  });

  it('модуль изменения печатается без знака', () => {
    expect(formatPctMagnitude(-42.4)).toBe('42%');
    expect(formatPctMagnitude(42.6)).toBe('43%');
  });

  it('CTR приходит долей и печатается процентом с запятой', () => {
    expect(formatRatio(0.0512)).toBe('5,12%');
    expect(formatRatio(0)).toBe('0,00%');
    expect(formatRatio(null)).toBe(DASH);
  });
});

describe('стрелки и даты', () => {
  it('стрелка отражает направление, а не оценку', () => {
    expect(trendArrow(12)).toBe('↑');
    expect(trendArrow(-12)).toBe('↓');
    expect(trendArrow(0)).toBe('→');
    expect(trendArrow(null)).toBe('→');
  });

  it('форматирует даты по-русски', () => {
    expect(formatDayShort('2026-08-07')).toBe('07.08');
    expect(formatDayFull('2026-08-07')).toBe('07.08.2026');
    expect(formatDayLabel('2026-08-07')).toBe('7 авг');
  });
});

describe('truncate', () => {
  it('режет длинное имя и ставит многоточие', () => {
    expect(truncate('Поисковая кампания по всей России', 10)).toBe('Поисковая…');
    expect(truncate('Короткое', 10)).toBe('Короткое');
  });
});
