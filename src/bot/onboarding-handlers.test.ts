import { describe, expect, it, vi } from 'vitest';

// Обработчик тянет за собой машину интервью, а та — `prisma`. Живой БД юнит-тесту
// не нужно: проверяется то, что видит человек, а не запись строки.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { adminNotice, renderStep } from './onboarding-handlers.js';

import type { ClientBriefData, InterviewStep } from '@/ai/onboarding/index.js';

/** Кусок подписи поля из `BRIEF_FIELD_LABELS`: письмо обязано называть поле по-русски. */
const BRIEF_FIELD_LABEL_FRAGMENT = 'ссылка на сайт';

const BRIEF: ClientBriefData = {
  product: 'Курсы английского для айтишников',
  audience: { description: 'Разработчики 25-40 лет' },
  geo: ['Москва'],
  negativeCities: [],
  usp: ['Преподаватели из IT'],
  targetCpaRub: 3_000,
  dailyBudgetRub: 1_000,
  budgetScope: 'per_channel',
  competitors: [],
  conversionGoals: [{ name: 'заявка' }],
  metrika: null,
  landingUrl: 'https://it-english.ru/trial',
};

describe('renderStep', () => {
  it('доносит предупреждения по собранному брифу, а не оставляет их в поле', () => {
    // Предупреждения складывались в `step.warnings`, а отправлялся только
    // `step.text`: «бюджет меньше CPA» не доезжало до человека ни разу.
    const step: InterviewStep = {
      kind: 'complete',
      text: 'Бриф собран, спасибо!',
      brief: BRIEF,
      warnings: ['Дневной бюджет 1000 ₽ меньше целевого CPA 3000 ₽.', 'Метрики нет.'],
    };

    const text = renderStep(step);

    expect(text).toContain('Бриф собран, спасибо!');
    expect(text).toContain('Дневной бюджет 1000 ₽ меньше целевого CPA 3000 ₽.');
    expect(text).toContain('Метрики нет.');
  });

  it('не дописывает ничего, когда претензий нет', () => {
    const step: InterviewStep = {
      kind: 'complete',
      text: 'Бриф собран.',
      brief: BRIEF,
      warnings: [],
    };

    expect(renderStep(step)).toBe('Бриф собран.');
  });

  it('вопрос отдаёт как есть', () => {
    const step: InterviewStep = {
      kind: 'question',
      text: 'Что продаём?',
      askedCount: 1,
      missing: ['product'],
      resumed: false,
    };

    expect(renderStep(step)).toBe('Что продаём?');
  });
});

describe('adminNotice', () => {
  it('зовёт человека, когда интервью встало', () => {
    // Иначе о таком клиенте человек узнаёт от самого клиента.
    const step: InterviewStep = {
      kind: 'needs_human',
      text: 'Ссылку я вижу, но записать её не смог.',
      missing: ['landingUrl'],
      askedCount: 5,
    };

    const notice = adminNotice('cl1', step);

    expect(notice).toContain('cl1');
    expect(notice).toContain('Ссылку я вижу, но записать её не смог.');
    expect(notice).toContain(BRIEF_FIELD_LABEL_FRAGMENT);
  });

  it('молчит на обычном ходе интервью', () => {
    const step: InterviewStep = {
      kind: 'question',
      text: 'Что продаём?',
      askedCount: 1,
      missing: ['product'],
      resumed: false,
    };

    expect(adminNotice('cl1', step)).toBeNull();
  });
});
