import { describe, expect, it } from 'vitest';

import {
  adjustedAlpha,
  DEFAULT_AB_TEST,
  losingVariantIds,
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

  it('один недобравший вариант не замораживает решение по остальным', () => {
    // «c» сняли с показа на двенадцатом показе. «a» и «b» набрали по 1000 —
    // между ними пропасть, и ждать «c» незачем.
    const decision = selectWinner([
      variant('a', 1000, 50),
      variant('b', 1000, 10),
      variant('c', 12, 0),
    ]);

    expect(decision.status).toBe('winner');
    expect(decision.winner).toBe('a');
    // Недобравший вариант из отчёта не исчез — он просто не участвовал в сравнении.
    expect(decision.variants).toHaveLength(3);
    expect(decision.comparisons.map((c) => c.variantId)).toEqual(['b']);
  });

  it('меньше двух готовых вариантов — данные всё ещё набираются', () => {
    const decision = selectWinner([variant('a', 1000, 50), variant('b', 12, 0)]);
    expect(decision.status).toBe('collecting');
    expect(decision.reasonCode).toBe('MIN_IMPRESSIONS');
  });
});

describe('срок эксперимента', () => {
  it('через две недели «данные набираются» превращается в «неубедительно»', () => {
    const counts = [variant('a', 1000, 50), variant('b', 12, 0)];

    expect(selectWinner(counts, DEFAULT_AB_TEST, { elapsedDays: 13 }).status).toBe('collecting');

    const expired = selectWinner(counts, DEFAULT_AB_TEST, { elapsedDays: 21 });
    expect(expired.status).toBe('inconclusive');
    expect(expired.reasonCode).toBe('COLLECTION_TIMEOUT');
    expect(expired.reason).toContain('21 дн.');
  });

  it('срок не отменяет победителя: данных хватило — решение есть', () => {
    const decision = selectWinner(
      [variant('a', 1000, 50), variant('b', 1000, 10)],
      DEFAULT_AB_TEST,
      { elapsedDays: 90 },
    );
    expect(decision.status).toBe('winner');
  });

  it('без возраста эксперимента срок не проверяется', () => {
    const decision = selectWinner([variant('a', 1000, 50), variant('b', 12, 0)]);
    expect(decision.status).toBe('collecting');
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

describe('кто именно проиграл', () => {
  it('недобравший минимум показов проигравшим не считается', () => {
    // «c» с 30 показами ни с кем не сравнивался: выключить его как проигравшего
    // значит навсегда лишить его шанса набрать данные.
    const decision = selectWinner([
      variant('a', 1000, 50),
      variant('b', 1000, 10),
      variant('c', 30, 2),
    ]);

    expect(decision.winner).toBe('a');
    expect(losingVariantIds(decision)).toEqual(['b']);
  });

  it('вариант вообще без показов в проигравшие не попадает', () => {
    const decision = selectWinner([
      variant('a', 1000, 50),
      variant('b', 1000, 10),
      variant('c', 0, 0),
    ]);

    expect(losingVariantIds(decision)).toEqual(['b']);
  });

  it('без победителя проигравших нет', () => {
    const decision = selectWinner([variant('a', 500, 12), variant('b', 500, 10)]);

    expect(decision.status).toBe('inconclusive');
    expect(losingVariantIds(decision)).toEqual([]);
  });
});

describe('имена вариантов в объяснении', () => {
  function labelled(id: string, impressions: number, clicks: number, label: string): VariantCounts {
    return { variantId: id, impressions, clicks, label };
  }

  it('победитель назван заголовком объявления, а не отпечатком текста', () => {
    const decision = selectWinner([
      labelled('t-9f3a1b2c3d4e', 1000, 50, 'Ремонт под ключ за 30 дней'),
      labelled('t-aaaabbbbcccc', 1000, 10, 'Ремонт квартир недорого'),
    ]);

    expect(decision.status).toBe('winner');
    expect(decision.reason).toContain('Ремонт под ключ за 30 дней');
    expect(decision.reason).not.toContain('t-9f3a1b2c3d4e');
  });

  it('в отказе «нет значимой разницы» тоже стоят заголовки', () => {
    const decision = selectWinner([
      labelled('t-9f3a1b2c3d4e', 500, 12, 'Ремонт под ключ'),
      labelled('t-aaaabbbbcccc', 500, 10, 'Ремонт недорого'),
    ]);

    expect(decision.reasonCode).toBe('NOT_SIGNIFICANT');
    expect(decision.reason).toContain('Ремонт под ключ');
    expect(decision.reason).not.toContain('t-');
  });

  it('без заголовка остаётся id варианта: выдумывать имя нечем', () => {
    const decision = selectWinner([variant('a', 1000, 50), variant('b', 1000, 10)]);

    expect(decision.reason).toContain('«a»');
    expect(decision.variants[0]?.label).toBeNull();
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
