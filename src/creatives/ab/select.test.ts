import { describe, expect, it } from 'vitest';

import {
  adjustedAlpha,
  DEFAULT_AB_TEST,
  selectWinner,
  type AbTestConfig,
  type VariantCounts,
} from './select.js';

function variant(id: string, impressions: number, clicks: number): VariantCounts {
  return { variantId: id, impressions, clicks };
}

function config(over: Partial<AbTestConfig> = {}): AbTestConfig {
  return { ...DEFAULT_AB_TEST, ...over };
}

describe('минимум наблюдений', () => {
  it('до 500 показов на вариант победителя не бывает', () => {
    const decision = selectWinner([variant('a', 499, 30), variant('b', 500, 5)]);
    expect(decision.status).toBe('collecting');
    expect(decision.reasonCode).toBe('MIN_IMPRESSIONS');
    expect(decision.winner).toBeNull();
  });

  it('порог настраиваемый и проверяется по каждому варианту отдельно', () => {
    const decision = selectWinner(
      [variant('a', 200, 20), variant('b', 300, 2)],
      config({ minImpressionsPerVariant: 100 }),
    );
    expect(decision.status).toBe('winner');
  });

  it('вариант ниже порога помечен как неготовый в отчёте', () => {
    const decision = selectWinner([variant('a', 100, 5), variant('b', 900, 20)]);
    expect(decision.variants.map((v) => v.eligible)).toEqual([false, true]);
  });
});

describe('отказ выбирать победителя на шуме', () => {
  // Тот самый случай из ТЗ: 3 варианта, ровно 500 показов, CTR около 2%,
  // лидер опережает на 2 клика. Наивный argmax объявил бы победителя.
  it('500 показов и разница в 2 клика — победителя нет', () => {
    const decision = selectWinner([
      variant('a', 500, 12),
      variant('b', 500, 10),
      variant('c', 500, 10),
    ]);

    expect(decision.status).toBe('inconclusive');
    expect(decision.reasonCode).toBe('NOT_SIGNIFICANT');
    expect(decision.winner).toBeNull();
    expect(decision.comparisons.every((c) => !c.significant)).toBe(true);
    expect(decision.reason).toContain('в пределах шума');
  });

  it('в отказе сказано, сколько показов на самом деле нужно', () => {
    const decision = selectWinner([variant('a', 500, 12), variant('b', 500, 10)]);
    expect(decision.requiredImpressionsPerVariant ?? 0).toBeGreaterThan(500);
  });

  it('доверительные интервалы вариантов перекрываются — это видно в отчёте', () => {
    const decision = selectWinner([variant('a', 500, 12), variant('b', 500, 10)]);
    const [a, b] = decision.variants;
    expect(a?.ctrInterval.low ?? 1).toBeLessThan(b?.ctrInterval.high ?? 0);
  });

  it('слишком мало кликов — это «данные набираются», а не «нет разницы»', () => {
    const decision = selectWinner([variant('a', 500, 3), variant('b', 500, 1)]);
    expect(decision.status).toBe('collecting');
    expect(decision.reasonCode).toBe('TOO_FEW_CLICKS');
  });

  it('одинаковый CTR — ничья, а не произвольный выбор первого', () => {
    const decision = selectWinner([variant('a', 1000, 20), variant('b', 1000, 20)]);
    expect(decision.reasonCode).toBe('TIE');
    expect(decision.winner).toBeNull();
  });

  it('один вариант сравнивать не с чем', () => {
    const decision = selectWinner([variant('a', 10_000, 500)]);
    expect(decision.reasonCode).toBe('NOT_ENOUGH_VARIANTS');
  });

  it('значимая, но крошечная разница не стоит переключения', () => {
    const decision = selectWinner([variant('a', 200_000, 4_200), variant('b', 200_000, 4_000)]);
    expect(decision.reasonCode).toBe('LIFT_TOO_SMALL');
    expect(decision.winner).toBeNull();
  });
});

describe('победитель при однозначном разрыве', () => {
  it('5% против 1% на 1000 показов — победитель есть', () => {
    const decision = selectWinner([
      variant('a', 1000, 50),
      variant('b', 1000, 10),
      variant('c', 1000, 12),
    ]);

    expect(decision.status).toBe('winner');
    expect(decision.winner).toBe('a');
    expect(decision.comparisons).toHaveLength(2);
    expect(decision.comparisons.every((c) => c.significant)).toBe(true);
    expect(decision.requiredImpressionsPerVariant).toBeNull();
  });

  it('лидер обязан обойти каждого, а не только ближайшего', () => {
    // «a» уверенно бьёт «c», но от «b» отличается неотличимо: победителя нет.
    const decision = selectWinner([
      variant('a', 2000, 100),
      variant('b', 2000, 96),
      variant('c', 2000, 20),
    ]);
    expect(decision.status).toBe('inconclusive');
    expect(decision.reasonCode).toBe('NOT_SIGNIFICANT');
  });
});

describe('поправка на множественность', () => {
  it('делит alpha на число сравнений', () => {
    expect(adjustedAlpha(0.05, 3)).toBeCloseTo(0.025, 10);
    expect(adjustedAlpha(0.05, 2)).toBeCloseTo(0.05, 10);
  });

  it('при одном варианте не делит на ноль', () => {
    expect(adjustedAlpha(0.05, 1)).toBeCloseTo(0.05, 10);
  });

  it('порог из сравнений совпадает с поправленным alpha', () => {
    const decision = selectWinner([
      variant('a', 5000, 250),
      variant('b', 5000, 100),
      variant('c', 5000, 90),
    ]);
    expect(decision.comparisons.every((c) => c.alphaAdjusted === 0.025)).toBe(true);
  });
});

describe('отчёт о вариантах', () => {
  it('содержит CTR и интервал по каждому варианту', () => {
    const decision = selectWinner([variant('a', 1000, 50), variant('b', 1000, 10)]);
    const report = decision.variants.find((v) => v.variantId === 'a');
    expect(report?.ctr).toBeCloseTo(0.05, 6);
    expect(report?.ctrInterval.low).toBeGreaterThan(0);
    expect(report?.ctrInterval.high).toBeLessThan(1);
  });

  it('конфигурация возвращается вместе с решением — правило видно в отчёте', () => {
    const decision = selectWinner([variant('a', 1000, 50), variant('b', 1000, 10)]);
    expect(decision.config.minImpressionsPerVariant).toBe(500);
  });
});
