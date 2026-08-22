import { describe, expect, it } from 'vitest';

import { buildSegments, niceScale, tickIndices } from './chart';

describe('niceScale', () => {
  it('округляет максимум до круглого числа', () => {
    expect(niceScale(1234).max).toBe(1500);
    expect(niceScale(97).ticks).toEqual([0, 25, 50, 75, 100]);
  });

  it('целочисленная шкала не даёт дробных делений', () => {
    expect(niceScale(3, true).ticks).toEqual([0, 1, 2, 3]);
  });

  it('пустые данные не ломают шкалу', () => {
    expect(niceScale(0).max).toBe(1);
    expect(niceScale(Number.NaN).max).toBe(1);
  });
});

describe('buildSegments', () => {
  it('рвёт линию на пропусках, а не подставляет ноль', () => {
    expect(buildSegments([1, 2, null, 4, 5])).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('ряд без значений не даёт ни одного отрезка', () => {
    expect(buildSegments([null, null])).toEqual([]);
  });
});

describe('tickIndices', () => {
  it('подписей не больше лимита и последняя всегда на месте', () => {
    const indices = tickIndices(30, 7);
    expect(indices.length).toBeLessThanOrEqual(8);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(29);
  });

  it('короткий ряд подписывается целиком', () => {
    expect(tickIndices(3, 7)).toEqual([0, 1, 2]);
  });
});
