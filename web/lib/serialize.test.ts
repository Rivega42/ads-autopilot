import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { bigIntToString, decimalToNumber, formatJsonInline, toJsonSafe } from './serialize';

describe('decimalToNumber', () => {
  it('разворачивает Prisma.Decimal в число', () => {
    expect(decimalToNumber(new Prisma.Decimal('1234.5678'))).toBe(1234.5678);
  });

  it('не теряет точность на длинной дробной части', () => {
    expect(decimalToNumber(new Prisma.Decimal('0.0001'))).toBe(0.0001);
  });

  it('null остаётся null, а не превращается в ноль', () => {
    expect(decimalToNumber(null)).toBeNull();
    expect(decimalToNumber(undefined)).toBeNull();
  });

  it('отбрасывает нечисловой мусор', () => {
    expect(decimalToNumber({})).toBeNull();
    expect(decimalToNumber('не число')).toBeNull();
    expect(decimalToNumber(Number.NaN)).toBeNull();
  });
});

describe('bigIntToString', () => {
  it('сохраняет значения за пределами точности number', () => {
    expect(bigIntToString(9007199254740993n)).toBe('9007199254740993');
  });

  it('null остаётся null', () => {
    expect(bigIntToString(null)).toBeNull();
  });
});

describe('toJsonSafe', () => {
  it('делает значение пригодным для JSON.stringify', () => {
    const value = toJsonSafe({
      id: 42n,
      spend: new Prisma.Decimal('10.50'),
      at: new Date('2026-08-08T12:00:00.000Z'),
      nested: [1n, { deep: new Prisma.Decimal('2') }],
    });

    expect(() => JSON.stringify(value)).not.toThrow();
    expect(value).toEqual({
      id: '42',
      spend: 10.5,
      at: '2026-08-08T12:00:00.000Z',
      nested: ['1', { deep: 2 }],
    });
  });

  it('на сырых данных из Prisma JSON.stringify упал бы', () => {
    expect(() => JSON.stringify({ id: 1n })).toThrow(TypeError);
  });
});

describe('formatJsonInline', () => {
  it('схлопывает объект в одну строку', () => {
    expect(formatJsonInline({ bid: 120, reason: 'cpa' })).toBe('bid: 120, reason: cpa');
  });

  it('пустое значение — прочерк', () => {
    expect(formatJsonInline(null)).toBe('—');
  });

  it('обрезает длинное значение', () => {
    expect(formatJsonInline('x'.repeat(300), 20)).toHaveLength(20);
  });
});
