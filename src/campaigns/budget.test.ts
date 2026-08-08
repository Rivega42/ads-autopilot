import { describe, expect, it } from 'vitest';

import { splitBudget, totalDailyBudget } from '@/campaigns/budget.js';

const MIN = 300;

function sum(values: readonly { amountRub: number }[]): number {
  // Складываем в копейках: сумма double'ов сама по себе даёт хвост и тест
  // проверял бы точность сложения, а не точность раскладки.
  return values.reduce((acc, v) => acc + Math.round(v.amountRub * 100), 0) / 100;
}

describe('splitBudget', () => {
  it('сумма долей точно равна исходной при неделимом остатке', () => {
    const split = splitBudget(
      10_000,
      [
        { key: 'a', weight: 1 },
        { key: 'b', weight: 1 },
        { key: 'c', weight: 1 },
      ],
      { minRub: MIN },
    );

    expect(split.allocations).toHaveLength(3);
    expect(sum(split.allocations)).toBe(10_000);
    expect(split.totalRub).toBe(10_000);
    // Лишняя копейка достаётся первой доле — раскладка обязана быть воспроизводимой.
    expect(split.allocations.map((a) => a.amountRub)).toEqual([3333.34, 3333.33, 3333.33]);
  });

  it('сумма точна и при дробных весах', () => {
    const split = splitBudget(
      15_000,
      [
        { key: 'search', weight: 0.7 },
        { key: 'network', weight: 0.3 },
      ],
      { minRub: MIN },
    );
    expect(sum(split.allocations)).toBe(15_000);
    expect(split.allocations).toEqual([
      { key: 'search', amountRub: 10_500 },
      { key: 'network', amountRub: 4_500 },
    ]);
  });

  it('сумма точна на бюджете с копейками', () => {
    const split = splitBudget(
      1_000.01,
      [
        { key: 'a', weight: 2 },
        { key: 'b', weight: 1 },
      ],
      { minRub: 1 },
    );
    expect(sum(split.allocations)).toBe(1_000.01);
  });

  it('не выдаёт долю меньше минимума: деньги достаются оставшимся', () => {
    const split = splitBudget(
      500,
      [
        { key: 'search', weight: 0.7 },
        { key: 'network', weight: 0.3 },
      ],
      { minRub: MIN },
    );

    expect(split.allocations).toEqual([{ key: 'search', amountRub: 500 }]);
    expect(split.dropped).toEqual([
      { key: 'network', reason: 'доля меньше минимального дневного бюджета 300 ₽' },
    ]);
    expect(sum(split.allocations)).toBe(500);
  });

  it('перекошенные веса: доля ниже минимума отбрасывается после раскладки', () => {
    const split = splitBudget(
      700,
      [
        { key: 'big', weight: 0.99 },
        { key: 'tiny', weight: 0.01 },
      ],
      { minRub: MIN },
    );

    expect(split.allocations).toEqual([{ key: 'big', amountRub: 700 }]);
    expect(split.dropped.map((d) => d.key)).toEqual(['tiny']);
  });

  it('бюджета не хватает ни на одну долю — не выдаёт ничего', () => {
    const split = splitBudget(100, [{ key: 'search', weight: 1 }], { minRub: MIN });
    expect(split.allocations).toEqual([]);
    expect(split.totalRub).toBe(0);
    expect(split.dropped.map((d) => d.key)).toEqual(['search']);
  });

  it('нулевой вес отбрасывается с явной причиной', () => {
    const split = splitBudget(
      1_000,
      [
        { key: 'a', weight: 1 },
        { key: 'b', weight: 0 },
      ],
      { minRub: MIN },
    );
    expect(split.allocations).toEqual([{ key: 'a', amountRub: 1_000 }]);
    expect(split.dropped).toEqual([{ key: 'b', reason: 'нулевой вес' }]);
  });
});

describe('totalDailyBudget', () => {
  it('«на канал» умножается на число каналов, общий — нет', () => {
    expect(totalDailyBudget(5_000, 'per_channel', 2)).toBe(10_000);
    expect(totalDailyBudget(5_000, 'total', 2)).toBe(5_000);
  });

  it('ноль каналов не обнуляет бюджет', () => {
    expect(totalDailyBudget(5_000, 'per_channel', 0)).toBe(5_000);
  });
});
