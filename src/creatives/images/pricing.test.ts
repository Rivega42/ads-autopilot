import { describe, expect, it } from 'vitest';

import {
  checkSetCost,
  CREATIVE_SET_BUDGET_USD,
  IMAGE_PRICING,
  IMAGE_SET_BUDGET_USD,
  imageCostUsd,
} from './pricing.js';

describe('imageCostUsd', () => {
  it('знает цену реализованного провайдера', () => {
    expect(imageCostUsd('fusionbrain', 'kandinsky-3.1')).toBe(0);
  });

  it('незнакомый провайдер стоит null, а не ноль', () => {
    expect(imageCostUsd('midjourney', 'v7')).toBeNull();
  });

  it('у каждой строки прайса есть источник', () => {
    for (const [key, price] of Object.entries(IMAGE_PRICING)) {
      expect(price.source, key).not.toBe('');
      expect(price.usdPerImage).toBeGreaterThanOrEqual(0);
    }
  });

  it('рублёвая цена YandexART переведена в доллары', () => {
    const price = imageCostUsd('yandexart', 'yandex-art');
    expect(price).toBeGreaterThan(0.02);
    expect(price).toBeLessThan(0.04);
  });
});

describe('checkSetCost', () => {
  it('три картинки DALL·E укладываются в бюджет ТЗ на изображения', () => {
    const unit = imageCostUsd('openai', 'dall-e-3');
    const check = checkSetCost([unit, unit, unit]);
    expect(check.totalUsd).toBeCloseTo(0.12, 6);
    expect(check.withinBudget).toBe(true);
    expect(check.budgetUsd).toBe(IMAGE_SET_BUDGET_USD);
  });

  it('четыре картинки DALL·E из бюджета уже вылезают', () => {
    const unit = imageCostUsd('openai', 'dall-e-3');
    expect(checkSetCost([unit, unit, unit, unit]).withinBudget).toBe(false);
  });

  it('неизвестные цены считаются отдельно: итог занижен и это видно', () => {
    const check = checkSetCost([0.04, null, null]);
    expect(check.totalUsd).toBeCloseTo(0.04, 6);
    expect(check.unpricedCount).toBe(2);
  });

  it('бюджет полного набора берётся из ТЗ', () => {
    expect(CREATIVE_SET_BUDGET_USD).toBe(0.7);
    expect(checkSetCost([0.05, 0.15, 0.5], CREATIVE_SET_BUDGET_USD).withinBudget).toBe(true);
  });
});
