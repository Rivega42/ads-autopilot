import { describe, expect, it } from 'vitest';

import {
  md,
  mdBold,
  mdEscape,
  mdItalic,
  mdJoin,
  mdLink,
  mdRaw,
  mdTruncate,
} from '@/reporter/markdown.js';

describe('экранирование MarkdownV2', () => {
  it('экранирует ровно те символы, которые перечислены в Bot API', () => {
    expect(mdEscape('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s')).toBe(
      'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s',
    );
  });

  it('экранирует обратный слеш, иначе он съест следующий символ', () => {
    expect(mdEscape('C:\\path')).toBe('C:\\\\path');
  });

  it('не трогает кириллицу, эмодзи и длинное тире', () => {
    expect(mdEscape('Расход — 12 400 ₽ 📊')).toBe('Расход — 12 400 ₽ 📊');
  });

  it('имя кампании со скобками и дефисом не ломает разметку', () => {
    expect(mdBold('Поиск (Москва) — B2B')).toBe('*Поиск \\(Москва\\) — B2B*');
    expect(mdItalic('CPA-цель')).toBe('_CPA\\-цель_');
  });
});

describe('ссылки', () => {
  it('в URL экранируются только скобка и слеш', () => {
    expect(mdLink('График', 'https://quickchart.io/chart?c=%7B%22a%22%3A1%7D')).toBe(
      '[График](https://quickchart.io/chart?c=%7B%22a%22%3A1%7D)',
    );
  });

  it('закрывающая скобка в URL не обрывает ссылку', () => {
    expect(mdLink('x', 'https://e.io/a)b')).toBe('[x](https://e.io/a\\)b)');
  });
});

describe('шаблон md', () => {
  it('экранирует литералы и оставляет подстановки как есть', () => {
    expect(md`Расход: ${mdBold('12 400 ₽')} (за 07.08)`).toBe(
      'Расход: *12 400 ₽* \\(за 07\\.08\\)',
    );
  });

  it('склеивает строки, пропуская пустые места', () => {
    expect(mdJoin([mdRaw('раз'), null, mdRaw('два'), undefined])).toBe('раз\nдва');
  });
});

/**
 * Обрезка готовой разметки.
 *
 * Проверяется не длина, а разбираемость результата: прямой `slice` укладывался в
 * лимит и при этом оставлял висящий `\` или незакрытое `*жирное*` — Telegram
 * отвечает на это `can't parse entities`, то есть отчёт не доставлен вовсе.
 * Что площадка такой текст действительно отвергает, показывает
 * `tests/e2e/reporter-telegram.e2e.ts`; здесь — сама резка.
 */
describe('mdTruncate', () => {
  it('короткий текст возвращает как есть', () => {
    expect(mdTruncate(mdEscape('Расход 100 ₽'), 100)).toBe('Расход 100 ₽');
  });

  it('закрывает жирное, оборванное лимитом', () => {
    expect(mdTruncate(mdBold('аааааааааа'), 6)).toBe('*аааа*');
  });

  it('не режет пару «слэш плюс символ» пополам', () => {
    // 'a\.b\.c': резать можно только по границам токенов, поэтому на лимите 4
    // остаётся 'a\.b', а не 'a\.b\' с висящим слэшем.
    expect(mdTruncate(mdEscape('a.b.c'), 4)).toBe('a\\.b');
    expect(mdTruncate(mdEscape('a.b.c'), 2)).toBe('a');
  });

  it('ссылка либо влезает целиком, либо не попадает вовсе', () => {
    const text = mdJoin([mdEscape('Отчёт: '), mdLink('График', 'https://quickchart.io/c')], '');
    expect(mdTruncate(text, text.length - 1)).toBe('Отчёт: ');
    expect(mdTruncate(text, text.length)).toBe(text);
  });

  it('нулевой лимит даёт пустую строку, а не обломок разметки', () => {
    expect(mdTruncate(mdBold('ааа'), 0)).toBe('');
  });
});
