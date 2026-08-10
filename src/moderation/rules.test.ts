import { Provider } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  findForbidden,
  formatRules,
  hintCategories,
  MODERATION_RULES,
  RULES_COUNT,
  ruleSources,
  rulesFor,
  rulesForRejection,
} from '@/moderation/rules.js';
import { REJECTION_CATEGORIES } from '@/moderation/types.js';

describe('база правил модерации', () => {
  it('у каждого правила есть источник, требование и способ исправления', () => {
    for (const rule of MODERATION_RULES) {
      expect(rule.source.authority.length, rule.id).toBeGreaterThan(0);
      expect(rule.source.ref.length, rule.id).toBeGreaterThan(0);
      expect(rule.requirement.length, rule.id).toBeGreaterThan(20);
      expect(rule.fix.length, rule.id).toBeGreaterThan(20);
      expect(rule.channels.length, rule.id).toBeGreaterThan(0);
      expect(REJECTION_CATEGORIES).toContain(rule.category);
    }
  });

  it('идентификаторы уникальны: по ним пишется ChangeLog', () => {
    const ids = MODERATION_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RULES_COUNT).toBe(ids.length);
  });

  it('источники перечислены явно — их видно в письме человеку', () => {
    expect(ruleSources().length).toBeGreaterThanOrEqual(3);
  });

  it('фильтрует правила по каналу', () => {
    const vkOnly = MODERATION_RULES.filter(
      (rule) => rule.channels.length === 1 && rule.channels[0] === Provider.VK_ADS,
    );
    expect(vkOnly.length).toBeGreaterThan(0);
    for (const rule of vkOnly) {
      expect(rulesFor(rule.category, Provider.YANDEX_DIRECT)).not.toContainEqual(rule);
    }
  });
});

describe('подсказки по тексту причины', () => {
  it('узнаёт превосходную степень', () => {
    expect(hintCategories('Использование превосходной степени «лучший»')).toContain('superlative');
  });

  it('на пустой причине не выдумывает категорий', () => {
    expect(hintCategories('')).toEqual([]);
  });

  it('добавляет к правилам категории те, на которые указала сама причина', () => {
    const rules = rulesForRejection(
      'formatting',
      Provider.YANDEX_DIRECT,
      'Текст содержит контактную информацию и превосходную степень',
    );
    const ids = rules.map((rule) => rule.id);
    expect(ids).toContain('no-contacts-in-text');
    expect(ids).toContain('superlative-unproven');
  });
});

describe('лексические детекторы', () => {
  it('ловят превосходную степень и стопроцентную гарантию', () => {
    const hits = findForbidden('Лучший сервис, 100% результат', Provider.YANDEX_DIRECT);
    expect(hits.map((hit) => hit.ruleId)).toEqual(
      expect.arrayContaining(['superlative-unproven', 'no-absolute-guarantee']),
    );
  });

  it('ловят телефон в тексте объявления', () => {
    const hits = findForbidden('Звоните +7 999 123-45-67', Provider.YANDEX_DIRECT);
    expect(hits.map((hit) => hit.ruleId)).toContain('no-contacts-in-text');
  });

  it('молчат на нормальном объявлении', () => {
    const clean = 'Ремонт стиральных машин на дому\nВыезд сегодня\nДиагностика перед ремонтом.';
    expect(findForbidden(clean, Provider.YANDEX_DIRECT)).toEqual([]);
  });

  it('не применяют правила чужого канала', () => {
    const withUrl = 'Подробности на example.ru';
    expect(findForbidden(withUrl, Provider.YANDEX_DIRECT).length).toBeGreaterThan(0);
    expect(findForbidden(withUrl, Provider.VK_ADS)).toEqual([]);
  });
});

describe('формат для промпта', () => {
  it('включает источник — модель должна видеть, откуда требование', () => {
    const block = formatRules(rulesFor('superlative', Provider.YANDEX_DIRECT));
    expect(block).toContain('superlative-unproven');
    expect(block).toContain('Источник:');
  });

  it('честно говорит, что правил под категорию нет', () => {
    expect(formatRules([])).toMatch(/правил под эту категорию в базе нет/u);
  });
});
