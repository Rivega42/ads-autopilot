import { describe, expect, it } from 'vitest';

import { formatMoneyPrecise, NO_VALUE } from './format';
import { cpa, cpaDeviation, cpc, ctr } from './metrics';

describe('cpa', () => {
  it('считает стоимость конверсии', () => {
    expect(cpa(1000, 4)).toBe(250);
  });

  it('без конверсий возвращает null, а не Infinity и не ноль', () => {
    expect(cpa(1000, 0)).toBeNull();
    expect(cpa(0, 0)).toBeNull();
    expect(cpa(1000, -1)).toBeNull();
  });

  it('null доезжает до интерфейса прочерком', () => {
    expect(formatMoneyPrecise(cpa(1000, 0))).toBe(NO_VALUE);
  });
});

describe('ctr и cpc', () => {
  it('считают доли', () => {
    expect(ctr(50, 1000)).toBe(0.05);
    expect(cpc(100, 25)).toBe(4);
  });

  it('нулевой знаменатель — null', () => {
    expect(ctr(0, 0)).toBeNull();
    expect(cpc(100, 0)).toBeNull();
  });
});

describe('cpaDeviation', () => {
  it('показывает превышение цели долей', () => {
    expect(cpaDeviation(300, 200)).toBeCloseTo(0.5);
  });

  it('без цели или без факта — null', () => {
    expect(cpaDeviation(null, 200)).toBeNull();
    expect(cpaDeviation(300, null)).toBeNull();
    expect(cpaDeviation(300, 0)).toBeNull();
  });
});
