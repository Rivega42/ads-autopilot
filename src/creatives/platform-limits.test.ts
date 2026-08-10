import { describe, expect, it } from 'vitest';

import {
  findTextViolations,
  fitToPlatform,
  isPlatformValid,
  PLATFORM_TEXT_LIMITS,
  VK_TEXT_MAX,
  VK_TITLE_MAX,
} from './platform-limits.js';

import {
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  type AdTextDraft,
} from '@/campaigns/limits.js';

const ru = (n: number): string => 'я'.repeat(n);

function draft(over: Partial<AdTextDraft> = {}): AdTextDraft {
  return { title: 'Заголовок', text: 'Текст объявления.', ...over };
}

describe('лимиты Директа на границе', () => {
  it('принимает ровно 33 символа в первом заголовке и отклоняет 34', () => {
    expect(isPlatformValid(draft({ title: ru(DIRECT_TITLE_MAX) }), 'yandex_direct')).toBe(true);

    const violations = findTextViolations(
      draft({ title: ru(DIRECT_TITLE_MAX + 1) }),
      'yandex_direct',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      field: 'title',
      kind: 'too_long',
      limit: DIRECT_TITLE_MAX,
      actual: DIRECT_TITLE_MAX + 1,
    });
  });

  it('принимает ровно 30 символов во втором заголовке и отклоняет 31', () => {
    expect(isPlatformValid(draft({ title2: ru(DIRECT_TITLE2_MAX) }), 'yandex_direct')).toBe(true);
    expect(
      findTextViolations(draft({ title2: ru(DIRECT_TITLE2_MAX + 1) }), 'yandex_direct')[0],
    ).toMatchObject({ field: 'title2', limit: DIRECT_TITLE2_MAX });
  });

  it('принимает ровно 81 символ текста и отклоняет 82', () => {
    expect(isPlatformValid(draft({ text: ru(DIRECT_TEXT_MAX) }), 'yandex_direct')).toBe(true);
    expect(
      findTextViolations(draft({ text: ru(DIRECT_TEXT_MAX + 1) }), 'yandex_direct')[0],
    ).toMatchObject({ field: 'text', limit: DIRECT_TEXT_MAX, actual: DIRECT_TEXT_MAX + 1 });
  });

  it('считает эмодзи вне BMP одним символом, как площадка', () => {
    // 32 буквы + один эмодзи = 33 символа для Директа, но 34 для String.length.
    const title = `${ru(DIRECT_TITLE_MAX - 1)}🚀`;
    expect(title.length).toBe(DIRECT_TITLE_MAX + 1);
    expect(isPlatformValid(draft({ title }), 'yandex_direct')).toBe(true);
  });

  it('пустое обязательное поле — тоже нарушение', () => {
    const violations = findTextViolations({ title: '   ', text: 'Текст' }, 'yandex_direct');
    expect(violations).toEqual([expect.objectContaining({ field: 'title', kind: 'empty' })]);
  });
});

describe('лимиты VK', () => {
  it('заголовок 25 и текст 90 — из имён текстовых блоков', () => {
    expect(PLATFORM_TEXT_LIMITS.vk_ads.title).toBe(VK_TITLE_MAX);
    expect(PLATFORM_TEXT_LIMITS.vk_ads.text).toBe(VK_TEXT_MAX);
    expect(PLATFORM_TEXT_LIMITS.vk_ads.verified).toBe(false);
  });

  it('второй заголовок у VK не поддерживается', () => {
    const violations = findTextViolations(draft({ title2: 'Второй' }), 'vk_ads');
    expect(violations).toEqual([
      expect.objectContaining({ field: 'title2', kind: 'unsupported_field', limit: null }),
    ]);
  });

  it('текст, влезающий в Директ, может не влезть в VK', () => {
    const ad = draft({ title: ru(30), text: ru(80) });
    expect(isPlatformValid(ad, 'yandex_direct')).toBe(true);
    expect(isPlatformValid(ad, 'vk_ads')).toBe(false);
  });
});

describe('fitToPlatform', () => {
  it('обрезает по границе слова и делает текст валидным', () => {
    const fitted = fitToPlatform(
      { title: 'Курсы английского языка для программистов и тестировщиков', text: 'Коротко.' },
      'yandex_direct',
    );
    expect(fitted.usable).toBe(true);
    expect(fitted.ad.title).toBe('Курсы английского языка для');
    expect(fitted.changes).toHaveLength(1);
    expect(isPlatformValid(fitted.ad, 'yandex_direct')).toBe(true);
  });

  it('выбрасывает второй заголовок на площадке, где его нет', () => {
    const fitted = fitToPlatform({ title: 'Заголовок', title2: 'Второй', text: 'Текст' }, 'vk_ads');
    expect(fitted.ad.title2).toBeUndefined();
    expect(fitted.usable).toBe(true);
  });

  it('ничего не меняет в тексте, который и так проходит', () => {
    const ad = draft();
    const fitted = fitToPlatform(ad, 'yandex_direct');
    expect(fitted.changes).toEqual([]);
    expect(fitted.ad).toEqual(ad);
  });
});
