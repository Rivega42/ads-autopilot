import { describe, expect, it } from 'vitest';

import {
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  findAdTextViolations,
  fitAdText,
  isValidKeyword,
  normaliseKeyword,
  textLength,
  truncateToLimit,
} from '@/campaigns/limits.js';

/** Строка ровно заданной длины из повторяющегося слова: границу проверяем точно. */
function ofLength(length: number, filler = 'а'): string {
  return filler.repeat(length);
}

describe('textLength', () => {
  it('считает символы, а не code units', () => {
    expect(textLength('абв')).toBe(3);
    // Эмодзи вне BMP: String.length дал бы 2, площадка считает один символ.
    expect(textLength('🚀')).toBe(1);
  });
});

describe('границы лимитов Директа', () => {
  it('заголовок ровно 33 символа проходит, 34 — нет', () => {
    const ok = { title: ofLength(DIRECT_TITLE_MAX), text: ofLength(20) };
    expect(findAdTextViolations(ok)).toEqual([]);

    const long = { title: ofLength(DIRECT_TITLE_MAX + 1), text: ofLength(20) };
    const violations = findAdTextViolations(long);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ field: 'title', limit: 33, actual: 34 });
  });

  it('второй заголовок ровно 30 символов проходит, 31 — нет', () => {
    const ok = { title: 'Заголовок', title2: ofLength(DIRECT_TITLE2_MAX), text: ofLength(20) };
    expect(findAdTextViolations(ok)).toEqual([]);

    const long = {
      title: 'Заголовок',
      title2: ofLength(DIRECT_TITLE2_MAX + 1),
      text: ofLength(20),
    };
    expect(findAdTextViolations(long).map((v) => v.field)).toEqual(['title2']);
  });

  it('текст ровно 81 символ проходит, 82 — нет', () => {
    const ok = { title: 'Заголовок', text: ofLength(DIRECT_TEXT_MAX) };
    expect(findAdTextViolations(ok)).toEqual([]);

    const long = { title: 'Заголовок', text: ofLength(DIRECT_TEXT_MAX + 1) };
    expect(findAdTextViolations(long).map((v) => v.field)).toEqual(['text']);
  });

  it('отсутствующий второй заголовок нарушением не считается', () => {
    expect(findAdTextViolations({ title: 'Заголовок', text: 'Текст объявления' })).toEqual([]);
  });

  it('после обрезки объявление укладывается в каждый лимит', () => {
    const { ad, truncated } = fitAdText({
      title: 'Курсы английского языка для программистов и тестировщиков',
      title2: 'Старт в любой день недели и в любое удобное время',
      text: `Разговорный курс с IT-лексикой ${ofLength(120, 'б')}`,
    });

    expect(truncated.map((v) => v.field)).toEqual(['title', 'title2', 'text']);
    expect(textLength(ad.title)).toBeLessThanOrEqual(DIRECT_TITLE_MAX);
    expect(textLength(ad.title2 ?? '')).toBeLessThanOrEqual(DIRECT_TITLE2_MAX);
    expect(textLength(ad.text)).toBeLessThanOrEqual(DIRECT_TEXT_MAX);
    expect(findAdTextViolations(ad)).toEqual([]);
  });

  it('уложившееся объявление не трогает', () => {
    const source = { title: 'Английский для айтишников', title2: 'Старт сегодня', text: 'Текст.' };
    const { ad, truncated } = fitAdText(source);
    expect(truncated).toEqual([]);
    expect(ad).toEqual(source);
  });
});

describe('truncateToLimit', () => {
  it('режет по границе слова и не оставляет висячих знаков', () => {
    expect(truncateToLimit('Курсы английского для программистов', 20)).toBe('Курсы английского');
  });

  it('режет по символу, если первое слово длиннее лимита', () => {
    expect(truncateToLimit(ofLength(50), 10)).toBe(ofLength(10));
  });

  it('строку в пределах лимита возвращает как есть, только обрезав пробелы', () => {
    expect(truncateToLimit('  Заголовок  ', 33)).toBe('Заголовок');
  });
});

describe('isValidKeyword', () => {
  it('принимает фразу из семи слов и отвергает из восьми', () => {
    expect(isValidKeyword('один два три четыре пять шесть семь')).toBe(true);
    expect(isValidKeyword('один два три четыре пять шесть семь восемь')).toBe(false);
  });

  it('отвергает пустую и слишком длинную фразу', () => {
    expect(isValidKeyword('   ')).toBe(false);
    expect(isValidKeyword(ofLength(101))).toBe(false);
  });
});

describe('normaliseKeyword', () => {
  it('схлопывает регистр и пробелы — иначе дубли уедут в кабинет', () => {
    expect(normaliseKeyword('  Курсы   Английского ')).toBe('курсы английского');
  });
});
