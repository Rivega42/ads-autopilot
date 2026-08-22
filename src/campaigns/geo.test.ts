import { describe, expect, it } from 'vitest';

import {
  buildRegionTargeting,
  isWithinRegion,
  REGION_RUSSIA,
  regionName,
  resolveRegions,
} from '@/campaigns/geo.js';

describe('resolveRegions', () => {
  it('переводит города в номера регионов и сортирует их', () => {
    const { target } = resolveRegions(['Москва', 'Санкт-Петербург']);
    expect(target.regionIds).toEqual([2, 213]);
    expect(target.unresolved).toEqual([]);
    expect(target.fallback).toBe(false);
  });

  it('не различает регистр, ё и лишние пробелы', () => {
    expect(resolveRegions(['  спб  ']).target.regionIds).toEqual([2]);
    expect(resolveRegions(['РОССИЯ']).target.regionIds).toEqual([REGION_RUSSIA]);
  });

  it('незнакомый город не выдумывает, а возвращает в unresolved', () => {
    const { target } = resolveRegions(['Москва', 'Урюпинск']);
    expect(target.regionIds).toEqual([213]);
    expect(target.unresolved).toEqual(['Урюпинск']);
  });

  it('если не распознано ничего — вся Россия, и это видно по флагу', () => {
    const { target } = resolveRegions(['Урюпинск']);
    expect(target.regionIds).toEqual([REGION_RUSSIA]);
    expect(target.fallback).toBe(true);
  });

  it('минус-города не подменяются Россией: «нечего исключать» — это пусто', () => {
    const { excluded } = resolveRegions(['Москва'], ['Урюпинск']);
    expect(excluded.regionIds).toEqual([]);
    expect(excluded.unresolved).toEqual(['Урюпинск']);
    expect(excluded.fallback).toBe(false);
  });

  it('дубликаты схлопываются', () => {
    expect(resolveRegions(['Москва', 'москва']).target.regionIds).toEqual([213]);
  });
});

/**
 * Правила взяты из ответа площадки, а не из удобства: Директ отвечает ошибкой 5120
 * («Геотаргетинг задан неправильно») на набор, где указаны только минус-регионы,
 * где минус-регион совпадает с регионом показа и где минус-регион не содержится ни
 * в одном из регионов показа. Вложенный минус-регион — наоборот, штатный случай:
 * в документации AdGroups.add он и приведён примером (`[1, -219]`).
 */
describe('buildRegionTargeting', () => {
  it('вложенный минус-город остаётся: это ровно тот случай, ради которого минус-регионы есть', () => {
    // Россия целиком, кроме Москвы.
    expect(buildRegionTargeting([REGION_RUSSIA], [213])).toEqual({
      regionIds: [REGION_RUSSIA, -213],
      suppressedTarget: [],
      droppedNegative: [],
    });
  });

  it('минус-город вне регионов показа отбрасывается, а не уезжает в кабинет', () => {
    // Москва и Питер, минус-Сочи: Сочи не входит ни в один из них — это 5120.
    const targeting = buildRegionTargeting([2, 213], [239]);
    expect(targeting.regionIds).toEqual([2, 213]);
    expect(targeting.droppedNegative).toEqual([239]);
    expect(targeting.suppressedTarget).toEqual([]);
  });

  it('город, указанный и в показах, и в минусах, из показов уходит', () => {
    const targeting = buildRegionTargeting([2, 213], [213]);
    expect(targeting.regionIds).toEqual([2]);
    expect(targeting.suppressedTarget).toEqual([213]);
    expect(targeting.droppedNegative).toEqual([213]);
  });

  it('минус-регион, накрывающий весь показ, оставляет пустой таргетинг — решать человеку', () => {
    const targeting = buildRegionTargeting([213], [REGION_RUSSIA]);
    expect(targeting.regionIds).toEqual([]);
    expect(targeting.suppressedTarget).toEqual([213]);
  });

  it('после снятия города минус на него сохраняется, если есть куда вложить', () => {
    // Россия и Москва в показах, Москва в минусах: остаётся «Россия, кроме Москвы».
    expect(buildRegionTargeting([REGION_RUSSIA, 213], [213]).regionIds).toEqual([
      REGION_RUSSIA,
      -213,
    ]);
  });

  it('вложенность считается по дереву, а не по совпадению номеров', () => {
    expect(isWithinRegion(REGION_RUSSIA, 213)).toBe(true);
    expect(isWithinRegion(1, 213)).toBe(true);
    expect(isWithinRegion(10174, 2)).toBe(true);
    expect(isWithinRegion(213, 2)).toBe(false);
    expect(isWithinRegion(REGION_RUSSIA, 149)).toBe(false);
    // Незнакомый номер вложенным не считается — недоказанная вложенность и есть 5120.
    expect(isWithinRegion(REGION_RUSSIA, 999_999)).toBe(false);
  });

  it('повторы схлопываются: «регион повторяется несколько раз» — тоже 5120', () => {
    expect(buildRegionTargeting([213, 213], [239, 239]).regionIds).toEqual([213]);
  });

  it('называет регионы по-человечески — иначе предупреждение читать невозможно', () => {
    expect(regionName(239)).toBe('Сочи');
    expect(regionName(-213)).toBe('Москва');
    expect(regionName(REGION_RUSSIA)).toBe('Россия');
    expect(regionName(999_999)).toBe('999999');
  });
});
