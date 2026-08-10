import { describe, expect, it } from 'vitest';

import {
  buildImagePrompt,
  buildNegativePrompt,
  imageBriefFromClient,
  promptSeed,
  type ImagePromptBrief,
} from './prompt.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';

const BRIEF: ImagePromptBrief = {
  product: 'Курсы английского для программистов',
  usp: ['IT-лексика', 'Преподаватели из индустрии'],
  audience: 'Разработчики 25-40 лет',
  palette: ['#0B5FFF', '#FFFFFF'],
};

describe('buildImagePrompt', () => {
  it('собирает промпт из брифа и формата', () => {
    const prompt = buildImagePrompt(BRIEF, 'wide_1200x628');
    expect(prompt).toContain('Курсы английского для программистов');
    expect(prompt).toContain('IT-лексика');
    expect(prompt).toContain('#0B5FFF');
    expect(prompt).toContain('1200:628');
  });

  it('всегда запрещает текст в кадре: кириллицу генераторы пишут с ошибками', () => {
    expect(buildImagePrompt(BRIEF, 'square_1080')).toContain('Без текста и надписей');
    expect(buildNegativePrompt(BRIEF)).toContain('текст');
  });

  it('разные варианты дают разную композицию', () => {
    const prompts = [0, 1, 2].map((i) => buildImagePrompt(BRIEF, 'square_1080', i));
    expect(new Set(prompts).size).toBe(3);
  });

  it('один и тот же вариант воспроизводим — иначе кеш бесполезен', () => {
    expect(buildImagePrompt(BRIEF, 'square_1080', 1)).toBe(
      buildImagePrompt(BRIEF, 'square_1080', 1),
    );
  });

  it('добавляет запреты клиента к списку по умолчанию', () => {
    expect(buildNegativePrompt({ ...BRIEF, avoid: ['алкоголь'] })).toContain('алкоголь');
  });

  it('работает на минимальном брифе', () => {
    expect(buildImagePrompt({ product: 'Пицца' }, 'banner_300x250')).toContain('Пицца');
  });
});

describe('promptSeed', () => {
  it('детерминирован и различает форматы и варианты', () => {
    expect(promptSeed('p', 'square_1080', 0)).toBe(promptSeed('p', 'square_1080', 0));
    expect(promptSeed('p', 'square_1080', 0)).not.toBe(promptSeed('p', 'square_1080', 1));
    expect(promptSeed('p', 'square_1080', 0)).not.toBe(promptSeed('p', 'story_9x16', 0));
  });
});

describe('imageBriefFromClient', () => {
  it('переносит продукт, УТП и аудиторию', () => {
    const client = {
      product: 'Курсы',
      audience: { description: 'Разработчики' },
      usp: ['IT-лексика'],
    } as ClientBriefData;

    expect(imageBriefFromClient(client)).toEqual({
      product: 'Курсы',
      usp: ['IT-лексика'],
      audience: 'Разработчики',
    });
  });
});
