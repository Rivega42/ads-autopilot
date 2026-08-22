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
  it('закрывашки укладываются в лимит, а не поверх него', () => {
    // Закрытие оставшихся сущностей дописывалось после того, как бюджет строк уже
    // посчитан, и `\`\`\`` на границе давало 4098 при лимите 4096. Телеграм на это
    // отвечает «message is too long» — то есть отчёт снова не доставлен, ровно тот
    // исход, ради которого закрытие и появилось. Перебор идёт по длине строки,
    // потому что попадание в границу зависит именно от неё.
    for (const opener of ['*', '||', '```']) {
      for (let pad = 1; pad <= 60; pad += 1) {
        const body = mdRaw(`${opener}x\n${`${'а'.repeat(pad)}\n`.repeat(600)}`);
        expect(clampMarkdown(body).length, `${opener} при длине строки ${pad}`).toBeLessThanOrEqual(
          TELEGRAM_MESSAGE_LIMIT,
        );
      }
    }
  });

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
