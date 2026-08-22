import { ConversionSource } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  addCounts,
  attributionHint,
  attributionLabel,
  comparableCpa,
  conversionSourceHint,
  conversionSourceLabel,
  countsOfSources,
  emptyCounts,
  MIXED_ATTRIBUTION_HINT,
  summarizeAttribution,
} from './attribution';
import { formatMoneyPrecise, NO_VALUE } from './format';
import { cpa } from './metrics';

const { METRIKA, NONE, PLATFORM } = ConversionSource;

function summaryOf(sources: readonly (ConversionSource | null)[]) {
  return summarizeAttribution(countsOfSources(sources));
}

describe('summarizeAttribution', () => {
  it('одна модель — она же primary, смешения нет', () => {
    expect(summaryOf([PLATFORM, PLATFORM])).toMatchObject({
      mixed: false,
      primary: PLATFORM,
      models: [PLATFORM],
    });
  });

  it('две модели в выборке — смешение, единственного источника нет', () => {
    expect(summaryOf([PLATFORM, METRIKA])).toMatchObject({ mixed: true, primary: null });
  });

  it('NONE не третья модель: с ним выборка остаётся односоставной', () => {
    expect(summaryOf([METRIKA, NONE, NONE])).toMatchObject({ mixed: false, primary: METRIKA });
  });

  it('только NONE — данных нет, но это не смешение', () => {
    expect(summaryOf([NONE, NONE])).toMatchObject({ mixed: false, primary: null });
  });

  it('пустая выборка не смешана', () => {
    expect(summaryOf([])).toMatchObject({ mixed: false, primary: null, models: [] });
  });

  it('дни без строки статистики в счёт не идут', () => {
    expect(countsOfSources([PLATFORM, null, null])).toEqual({
      [PLATFORM]: 1,
      [METRIKA]: 0,
      [NONE]: 0,
    });
  });
});

describe('addCounts', () => {
  it('смешение проявляется при сложении: у кампаний по одной модели, у клиента — две', () => {
    const yandex = countsOfSources([PLATFORM, PLATFORM]);
    const metrika = countsOfSources([METRIKA]);

    expect(summarizeAttribution(yandex).mixed).toBe(false);
    expect(summarizeAttribution(metrika).mixed).toBe(false);
    expect(summarizeAttribution(addCounts(yandex, metrika)).mixed).toBe(true);
  });

  it('пустой счётчик — нейтральный элемент', () => {
    const counts = countsOfSources([METRIKA]);
    expect(addCounts(counts, emptyCounts())).toEqual(counts);
  });
});

describe('comparableCpa', () => {
  it('при одном источнике число проходит как есть', () => {
    expect(comparableCpa(250, summaryOf([METRIKA]))).toBe(250);
  });

  it('при смешении число не отдаётся наверх — оно ничего не измеряет', () => {
    expect(comparableCpa(250, summaryOf([METRIKA, PLATFORM]))).toBeNull();
  });

  it('null доезжает до интерфейса прочерком, а не нулём', () => {
    const mixed = summaryOf([METRIKA, PLATFORM]);
    expect(formatMoneyPrecise(comparableCpa(cpa(10000, 40), mixed))).toBe(NO_VALUE);
  });
});

describe('ярлыки и подсказки', () => {
  it('каждому источнику — русский ярлык', () => {
    expect(conversionSourceLabel(PLATFORM)).toBe('Площадка');
    expect(conversionSourceLabel(METRIKA)).toBe('Метрика');
    expect(conversionSourceLabel(NONE)).toBe('Нет данных');
  });

  it('смешение называется своим именем, а не именем одной из моделей', () => {
    expect(attributionLabel(summaryOf([METRIKA, PLATFORM]))).toBe('Смешанные источники');
    expect(attributionHint(summaryOf([METRIKA, PLATFORM]))).toBe(MIXED_ATTRIBUTION_HINT);
  });

  it('выборка без конверсий подписана «Нет данных»', () => {
    expect(attributionLabel(summaryOf([]))).toBe('Нет данных');
    expect(attributionLabel(summaryOf([NONE]))).toBe('Нет данных');
  });

  it('подсказка объясняет разницу моделей, а не повторяет ярлык', () => {
    expect(attributionHint(summaryOf([METRIKA]))).toContain('Метрика');
    expect(attributionHint(summaryOf([PLATFORM]))).toContain('рекламный кабинет');
  });

  it('у каждого источника есть своя подсказка для отдельной строки', () => {
    for (const source of [PLATFORM, METRIKA, NONE]) {
      expect(conversionSourceHint(source).length).toBeGreaterThan(0);
    }
    expect(conversionSourceHint(NONE)).toContain('не измеренный ноль');
  });
});
