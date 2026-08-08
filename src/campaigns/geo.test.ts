import { describe, expect, it } from 'vitest';

import { REGION_RUSSIA, resolveRegions } from '@/campaigns/geo.js';

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
