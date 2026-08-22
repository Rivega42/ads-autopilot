import { describe, expect, it } from 'vitest';

import { mdBold, mdEscape, mdJoin, mdRaw } from '@/reporter/markdown.js';
import { clampMarkdown, TELEGRAM_MESSAGE_LIMIT } from '@/reporter/telegram.js';

/**
 * Укладывание отчёта в одно сообщение Telegram.
 *
 * Аварийная ветка (не влезла даже первая строка) до сих пор не проверялась
 * ничем и резала текст прямым `slice`: результат укладывался в лимит и при этом
 * не разбирался площадкой — «can't parse entities», то есть отчёт не доставлен
 * ни в каком виде. Что именно на таком тексте отказывает Telegram, показывает
 * `tests/e2e/reporter-telegram.e2e.ts` настоящим транспортом.
 */
describe('clampMarkdown', () => {
  it('короткий отчёт не трогает', () => {
    const text = mdJoin([mdBold('Отчёт'), mdEscape('Расход: 100 ₽')]);
    expect(clampMarkdown(text)).toBe(text);
  });

  it('режет по границе строк и ставит многоточие', () => {
    const text = mdJoin([mdEscape('первая'), mdEscape('в'.repeat(50)), mdEscape('третья')]);
    expect(clampMarkdown(text, 20)).toBe('первая\n…');
  });

  it('одна длинная строка: жирное закрыто, разметка цела', () => {
    const clamped = clampMarkdown(mdBold('а'.repeat(TELEGRAM_MESSAGE_LIMIT)));

    expect(clamped.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(clamped.endsWith('*\n…')).toBe(true);
    // Звёздочек чётное число — сущность закрыта, а не оборвана.
    expect((clamped.match(/\*/g) ?? []).length % 2).toBe(0);
  });

  it('одна длинная строка не заканчивается висящим слэшем', () => {
    // Точка в каждой паре — тот самый экранированный спецсимвол отчёта.
    const clamped = clampMarkdown(mdRaw('a\\.'.repeat(2_000)), 100);

    expect(clamped).toBe(`${'a\\.'.repeat(32)}a\n…`);
  });
});
