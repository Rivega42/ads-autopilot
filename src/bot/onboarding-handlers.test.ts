import { describe, expect, it, vi } from 'vitest';

// Обработчик тянет за собой машину интервью, а та — `prisma`. Живой БД юнит-тесту
// не нужно: проверяется то, что видит человек, а не запись строки.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { adminNotice, escalationReason, renderStep } from './onboarding-handlers.js';

import type {
  BriefField,
  ClientBriefData,
  HaltReason,
  InterviewStep,
} from '@/ai/onboarding/index.js';

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

type HaltedStep = Extract<InterviewStep, { kind: 'needs_human' }>;

/** Остановка интервью: отличаются только основанием, всё остальное совпадает. */
function halted(reason: HaltReason, missing: BriefField[] = ['landingUrl']): HaltedStep {
  return {
    kind: 'needs_human',
    text: 'Ссылку я вижу, но записать её не смог.',
    missing,
    askedCount: 5,
    reason,
  };
}

describe('adminNotice', () => {
  it('зовёт человека, когда интервью встало', () => {
    // Иначе о таком клиенте человек узнаёт от самого клиента.
    const notice = adminNotice('cl1', halted('unconfirmed-landing'));

    expect(notice).toContain('cl1');
    expect(notice).toContain('Ссылку я вижу, но записать её не смог.');
    expect(notice).toContain(BRIEF_FIELD_LABEL_FRAGMENT);
  });

  it('называет, почему интервью встало', () => {
    // «Не хватает ссылки» одинаково у клиента без сайта и у клиента, чей адрес мы
    // не смогли записать. Письмо про второго читалось как «рекламировать нечего».
    expect(adminNotice('cl1', halted('no-landing'))).toContain('сайт не назван');
    expect(adminNotice('cl1', halted('unconfirmed-landing'))).toContain('записать не смогли');
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

describe('escalationReason', () => {
  it('разводит остановки, у которых не хватает одного и того же', () => {
    // Клиент трижды сказал «сайта нет», потом вспомнил адрес, а записать его не
    // вышло. Набор недостающих полей тот же, разговор другой — и пока основание
    // считалось только по `missing`, второе письмо не уходило вовсе.
    expect(escalationReason(halted('no-landing'))).not.toBe(
      escalationReason(halted('unconfirmed-landing')),
    );
  });

  it('на ту же остановку отвечает тем же основанием', () => {
    // Иначе каждое «ладно» и «спасибо» в остановленный бриф — новое письмо.
    expect(escalationReason(halted('no-landing'))).toBe(escalationReason(halted('no-landing')));
  });

  it('различает и набор недостающих полей', () => {
    expect(escalationReason(halted('question-budget', ['geo', 'product']))).not.toBe(
      escalationReason(halted('question-budget')),
    );
  });

  it('на обычном ходе интервью человека не зовёт', () => {
    const step: InterviewStep = {
      kind: 'question',
      text: 'Что продаём?',
      askedCount: 1,
      missing: ['product'],
      resumed: false,
    };

    expect(escalationReason(step)).toBe('none');
  });
});
