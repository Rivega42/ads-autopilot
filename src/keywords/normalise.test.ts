import { describe, expect, it } from 'vitest';

import {
  canonicalKey,
  dedupePhrases,
  normalisePhrase,
  significantWords,
  stripOperators,
} from '@/keywords/normalise.js';

describe('normalisePhrase', () => {
  it('приводит регистр, ё и пробелы к одному виду', () => {
    expect(normalisePhrase('  Курсы   Английского  ')).toBe('курсы английского');
    expect(normalisePhrase('ещё курсы')).toBe('еще курсы');
  });

  it('снимает операторы Директа и пунктуацию', () => {
    expect(stripOperators('!курсы +английского "онлайн"').trim().replace(/\s+/gu, ' ')).toBe(
      'курсы английского онлайн',
    );
    expect(normalisePhrase('курсы английского, онлайн')).toBe('курсы английского онлайн');
  });
});

describe('canonicalKey', () => {
  it('игнорирует порядок слов: в широком соответствии это одна фраза', () => {
    expect(canonicalKey('купить курсы английского')).toBe(canonicalKey('курсы английского купить'));
  });

  it('игнорирует служебные слова', () => {
    expect(canonicalKey('курсы для английского')).toBe(canonicalKey('курсы английского'));
  });

  it('различает отрицания: «без опыта» и «с опытом» — разный спрос', () => {
    expect(canonicalKey('курсы без опыта')).not.toBe(canonicalKey('курсы с опытом'));
  });

  it('не схлопывает фразу целиком из предлогов в пустой ключ', () => {
    expect(significantWords('для на')).toEqual(['для', 'на']);
    expect(canonicalKey('для на')).not.toBe('');
  });
});

describe('dedupePhrases', () => {
  it('схлопывает перестановки, регистр и ё в одну группу', () => {
    const result = dedupePhrases([
      'курсы английского онлайн',
      'Онлайн курсы английского',
      'курсы английского  онлайн',
      'английский для программистов',
    ]);

    expect(result.groups).toHaveLength(2);
    expect(result.duplicates).toBe(2);
    expect(result.input).toBe(4);
  });

  it('представитель группы не зависит от порядка входа', () => {
    const a = dedupePhrases(['онлайн курсы английского', 'курсы английского онлайн']);
    const b = dedupePhrases(['курсы английского онлайн', 'онлайн курсы английского']);
    expect(a.groups[0]?.phrase).toBe(b.groups[0]?.phrase);
  });

  it('отклоняет фразу длиннее семи слов: Директ её не примет', () => {
    const long = 'один два три четыре пять шесть семь восемь';
    const result = dedupePhrases(['курсы английского', long]);

    expect(result.groups.map((g) => g.phrase)).toEqual(['курсы английского']);
    expect(result.rejected).toEqual([
      { phrase: long, reason: 'too-many-words', words: 8, chars: long.length },
    ]);
  });

  it('семь слов ровно — принимает', () => {
    const seven = 'один два три четыре пять шесть семь';
    expect(dedupePhrases([seven]).groups).toHaveLength(1);
  });

  it('отклоняет пустые и слишком длинные строки', () => {
    const result = dedupePhrases(['', '   ', 'а'.repeat(120)]);
    expect(result.groups).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toContain('empty');
    expect(result.rejected.map((r) => r.reason)).toContain('too-long');
  });

  it('сохраняет порядок первого появления групп', () => {
    const result = dedupePhrases(['яблоко', 'банан', 'яблоко купить']);
    expect(result.groups.map((g) => g.phrase)).toEqual(['яблоко', 'банан', 'яблоко купить']);
  });
});
