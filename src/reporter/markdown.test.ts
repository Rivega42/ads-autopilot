import { describe, expect, it } from 'vitest';

import { md, mdBold, mdEscape, mdItalic, mdJoin, mdLink, mdRaw } from '@/reporter/markdown.js';

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
