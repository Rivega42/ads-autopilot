import { describe, expect, it } from 'vitest';

import {
  clearPromptCache,
  loadPrompt,
  promptHeader,
  renderTemplate,
  PromptError,
  PROMPT_VERSION,
  type PromptName,
} from './prompt-loader.js';

import { BRIEF_FIELDS } from '@/ai/onboarding/brief.schema.js';

describe('renderTemplate', () => {
  it('подставляет значения по имени', () => {
    expect(renderTemplate('CPA: {{cpa}} ₽, гео: {{geo}}', { cpa: 2000, geo: 'Москва' })).toBe(
      'CPA: 2000 ₽, гео: Москва',
    );
  });

  it('терпит пробелы внутри скобок', () => {
    expect(renderTemplate('{{ name }}', { name: 'бриф' })).toBe('бриф');
  });

  it('падает, если плейсхолдер остался незаполненным', () => {
    // Ради этого модуль и существует: «{{brief}}», доехавший до модели, породит
    // уверенный ответ на пустое место.
    expect(() => renderTemplate('Бриф: {{brief}}', {})).toThrow(PromptError);
    expect(() => renderTemplate('Бриф: {{brief}}', {})).toThrow(/brief/);
  });

  it('падает, если передали переменную, которой нет в шаблоне', () => {
    expect(() => renderTemplate('Привет', { name: 'x' })).toThrow(/name/);
  });

  it('подставляет одно значение во все вхождения', () => {
    expect(renderTemplate('{{a}}-{{a}}', { a: 1 })).toBe('1-1');
  });
});

describe('loadPrompt', () => {
  it('читает файл и приклеивает версию первой строкой', () => {
    clearPromptCache();
    const prompt = loadPrompt('onboarding-interview', {
      knownBrief: '{}',
      missingFields: '- product: что продаём',
      askedCount: 0,
      maxQuestions: 25,
    });

    expect(prompt.version).toBe(PROMPT_VERSION['onboarding-interview']);
    expect(prompt.text.startsWith(promptHeader('onboarding-interview', prompt.version))).toBe(true);
    expect(prompt.text).toContain('- product: что продаём');
    expect(prompt.text).not.toMatch(/\{\{/);
  });

  it('падает на неизвестном имени промпта', () => {
    expect(() => loadPrompt('нет-такого' as PromptName)).toThrow(PromptError);
  });

  it('падает, если не передать переменные шаблона', () => {
    clearPromptCache();
    expect(() => loadPrompt('onboarding-interview')).toThrow(/knownBrief/);
  });

  it('у каждого промпта из реестра есть файл', () => {
    clearPromptCache();
    for (const name of Object.keys(PROMPT_VERSION) as PromptName[]) {
      // Переменные не знаем, поэтому проверяем только наличие файла: renderTemplate
      // бросит PromptError с перечислением плейсхолдеров, а не с «файл не найден».
      try {
        loadPrompt(name);
      } catch (err) {
        expect(String(err)).toMatch(/Unsubstituted placeholders|Variables not present/);
      }
    }
  });
});

describe('промпт онбординга и схема брифа', () => {
  it('описывает каждое поле брифа', () => {
    clearPromptCache();
    const prompt = loadPrompt('onboarding-interview', {
      knownBrief: '{}',
      missingFields: '-',
      askedCount: 0,
      maxQuestions: 25,
    });

    // Промпт и схема расходятся молча: модель просто перестаёт заполнять поле,
    // о котором ей не сказали. Дешевле поймать это тестом.
    for (const field of BRIEF_FIELDS) {
      expect(prompt.text).toContain(field);
    }
  });
});
