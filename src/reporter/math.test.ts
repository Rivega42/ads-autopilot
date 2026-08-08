import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  divideOrNull,
  meanOrNull,
  pctChangeOrNull,
  stdDevOrNull,
  sum,
  toNumber,
} from '@/reporter/math.js';

describe('toNumber', () => {
  it('разбирает Decimal через строку, не теряя копейки', () => {
    expect(toNumber(new Prisma.Decimal('1234.5678'))).toBeCloseTo(1234.5678, 4);
    expect(toNumber(new Prisma.Decimal('0'))).toBe(0);
  });

  it('пустое значение — это ноль, а не NaN', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('не число')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('divideOrNull', () => {
  it('делит, когда есть на что', () => {
    expect(divideOrNull(1000, 4)).toBe(250);
  });

  it('CPA при нуле конверсий — null, а не ноль и не бесконечность', () => {
    expect(divideOrNull(5000, 0)).toBeNull();
  });

  it('CTR при нуле показов — null', () => {
    expect(divideOrNull(0, 0)).toBeNull();
  });

  it('отрицательный и нечисловой знаменатель тоже дают null', () => {
    expect(divideOrNull(10, -1)).toBeNull();
    expect(divideOrNull(10, Number.NaN)).toBeNull();
    expect(divideOrNull(Number.NaN, 10)).toBeNull();
  });
});

describe('pctChangeOrNull', () => {
  it('считает изменение к живой базе', () => {
    expect(pctChangeOrNull(112, 100)).toBeCloseTo(12, 6);
    expect(pctChangeOrNull(50, 100)).toBeCloseTo(-50, 6);
  });

  it('рост с нуля процентом не выражается', () => {
    expect(pctChangeOrNull(5, 0)).toBeNull();
    expect(pctChangeOrNull(0, 0)).toBeNull();
  });

  it('падение до нуля от живой базы — это ровно −100%', () => {
    expect(pctChangeOrNull(0, 100)).toBe(-100);
  });
});

describe('meanOrNull / stdDevOrNull', () => {
  it('среднее пустой выборки не существует', () => {
    expect(meanOrNull([])).toBeNull();
    expect(meanOrNull([2, 4, 6])).toBe(4);
  });

  it('на одной точке разброса нет — null, иначе z-оценка делилась бы на ноль', () => {
    expect(stdDevOrNull([5])).toBeNull();
    expect(stdDevOrNull([])).toBeNull();
  });

  it('идеально ровный ряд даёт нулевое отклонение', () => {
    expect(stdDevOrNull([10, 10, 10])).toBe(0);
    expect(stdDevOrNull([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 6);
  });
});

describe('sum', () => {
  it('складывает пустую выборку в ноль', () => {
    expect(sum([])).toBe(0);
    expect(sum([1.5, 2.5])).toBe(4);
  });
});
