import { describe, expect, it } from 'vitest';

import {
  ctr,
  normalCdf,
  normalQuantile,
  requiredTrialsPerVariant,
  twoProportionZTest,
  twoSidedZ,
  wilsonInterval,
} from './stats.js';

describe('normalCdf', () => {
  it('совпадает с табличными значениями', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-2.5758)).toBeCloseTo(0.005, 5);
  });
});

describe('normalQuantile', () => {
  it('обратна normalCdf на стандартных уровнях', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.995)).toBeCloseTo(2.575829, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
  });

  it('симметрична и работает в хвостах', () => {
    expect(normalQuantile(0.001)).toBeCloseTo(-normalQuantile(0.999), 4);
    expect(normalQuantile(1e-6)).toBeLessThan(-4.5);
  });

  it('отказывается считать за пределами (0,1)', () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('twoSidedZ', () => {
  it('для alpha = 0.05 даёт 1.96', () => {
    expect(twoSidedZ(0.05)).toBeCloseTo(1.959964, 5);
  });
});

describe('wilsonInterval', () => {
  it('накрывает наблюдённую долю', () => {
    const interval = wilsonInterval({ successes: 10, trials: 500 });
    expect(interval.low).toBeLessThan(0.02);
    expect(interval.high).toBeGreaterThan(0.02);
  });

  it('при нуле кликов не схлопывается в точку (в отличие от Вальда)', () => {
    const interval = wilsonInterval({ successes: 0, trials: 500 });
    expect(interval.low).toBeCloseTo(0, 12);
    expect(interval.high).toBeGreaterThan(0.005);
  });

  it('сужается с ростом выборки', () => {
    const small = wilsonInterval({ successes: 10, trials: 500 });
    const large = wilsonInterval({ successes: 200, trials: 10_000 });
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('без наблюдений возвращает весь отрезок', () => {
    expect(wilsonInterval({ successes: 0, trials: 0 })).toEqual({ low: 0, high: 1 });
  });
});

describe('twoProportionZTest', () => {
  it('не видит различия в 2 клика на 500 показах', () => {
    const test = twoProportionZTest({ successes: 12, trials: 500 }, { successes: 10, trials: 500 });
    expect(test).not.toBeNull();
    expect(test?.pValue).toBeGreaterThan(0.5);
    expect(test?.approximationValid).toBe(true);
  });

  it('видит различие 5% против 1% на 1000 показов', () => {
    const test = twoProportionZTest(
      { successes: 50, trials: 1000 },
      { successes: 10, trials: 1000 },
    );
    expect(test?.pValue).toBeLessThan(0.0001);
  });

  it('честно говорит, что приближение неприменимо при трёх кликах', () => {
    const test = twoProportionZTest({ successes: 2, trials: 500 }, { successes: 1, trials: 500 });
    expect(test?.approximationValid).toBe(false);
  });

  it('возвращает null, когда одной группы фактически нет', () => {
    expect(
      twoProportionZTest({ successes: 0, trials: 0 }, { successes: 5, trials: 500 }),
    ).toBeNull();
  });

  it('без кликов вообще различия нет по построению', () => {
    const test = twoProportionZTest({ successes: 0, trials: 500 }, { successes: 0, trials: 500 });
    expect(test?.pValue).toBe(1);
  });
});

describe('requiredTrialsPerVariant', () => {
  it('показывает, что 500 показов из ТЗ не хватает на порядки', () => {
    const required = requiredTrialsPerVariant(0.02, 0.2);
    expect(required).not.toBeNull();
    expect(required ?? 0).toBeGreaterThan(10_000);
  });

  it('чем крупнее искомый эффект, тем меньше нужно показов', () => {
    const small = requiredTrialsPerVariant(0.02, 0.1) ?? 0;
    const large = requiredTrialsPerVariant(0.02, 1) ?? 0;
    expect(large).toBeLessThan(small);
  });

  it('без базового CTR оценить нечего', () => {
    expect(requiredTrialsPerVariant(0, 0.2)).toBeNull();
    expect(requiredTrialsPerVariant(0.02, 0)).toBeNull();
  });
});

describe('ctr', () => {
  it('без показов равен нулю, а не NaN', () => {
    expect(ctr({ successes: 0, trials: 0 })).toBe(0);
    expect(ctr({ successes: 10, trials: 500 })).toBeCloseTo(0.02, 6);
  });
});
