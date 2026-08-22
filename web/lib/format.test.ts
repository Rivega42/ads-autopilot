import { describe, expect, it } from 'vitest';

import { NO_VALUE, NOT_SET, formatBid, formatBidRange } from './format';

/**
 * Ставка группы — единственный рычаг цены у VK, и у неё три разных состояния:
 * число, ноль и «ставки нет». Витрина обязана различать все три: прочерк на
 * месте нуля читается как «данных нет», ноль на месте пустоты — как «мы
 * поставили ноль».
 */
describe('ставка группы', () => {
  it('ноль — это цена, а не отсутствие данных', () => {
    expect(formatBid(0)).not.toBe(NO_VALUE);
    expect(formatBid(0)).not.toBe(NOT_SET);
    expect(formatBid(0)).toContain('0,00');
  });

  it('«не задана» не выглядит нулём', () => {
    expect(formatBid(null)).toBe(NOT_SET);
    expect(formatBid(null)).not.toBe(formatBid(0));
  });

  it('копейки не теряются', () => {
    expect(formatBid(12.34)).toContain('12,34');
  });

  it('битое число не доезжает до человека как NaN', () => {
    expect(formatBid(Number.NaN)).toBe(NO_VALUE);
    expect(formatBid(Number.POSITIVE_INFINITY)).toBe(NO_VALUE);
  });
});

describe('сводка ставок для плитки', () => {
  it('групп нет — говорить не о чем', () => {
    expect(formatBidRange({ groups: 0, withBid: 0, min: null, max: null })).toBe(NO_VALUE);
  });

  it('группы есть, ставки нет — это «не задана», а не прочерк', () => {
    expect(formatBidRange({ groups: 4, withBid: 0, min: null, max: null })).toBe(NOT_SET);
  });

  it('одна ставка на все группы показывается одним числом', () => {
    expect(formatBidRange({ groups: 3, withBid: 3, min: 12.34, max: 12.34 })).toBe(
      formatBid(12.34),
    );
  });

  it('разброс показывается диапазоном', () => {
    const text = formatBidRange({ groups: 4, withBid: 3, min: 0, max: 99.99 });
    expect(text).toContain('0,00');
    expect(text).toContain('99,99');
  });

  it('ни при каких данных не выдаёт NaN', () => {
    for (const range of [
      { groups: 2, withBid: 2, min: null, max: 5 },
      { groups: 2, withBid: 2, min: Number.NaN, max: Number.NaN },
      { groups: -1, withBid: 5, min: 1, max: 2 },
    ]) {
      expect(formatBidRange(range), JSON.stringify(range)).not.toMatch(/NaN|Infinity/);
    }
  });
});
