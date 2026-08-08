import { describe, expect, it } from 'vitest';

import {
  briefDraftSchema,
  briefWarnings,
  clientBriefSchema,
  isMoneyField,
  missingBriefFields,
  parseCompleteBrief,
  REQUIRED_BRIEF_FIELDS,
  type ClientBriefData,
} from './brief.schema.js';

const FULL: ClientBriefData = {
  product: 'Курсы английского для айтишников',
  audience: { description: 'Разработчики 25-40 лет, доход от 150к', ageFrom: 25, ageTo: 40 },
  geo: ['Москва', 'Санкт-Петербург'],
  negativeCities: ['Норильск'],
  usp: ['Преподаватели из IT', 'Занятия в 7 утра'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [{ name: 'Skyeng', site: 'https://skyeng.ru' }],
  conversionGoals: [{ name: 'заявка на пробный урок', metrikaGoalId: 123 }],
};

describe('clientBriefSchema', () => {
  it('принимает полностью собранный бриф', () => {
    expect(clientBriefSchema.safeParse(FULL).success).toBe(true);
  });

  it('пустые минус-города и конкуренты — валидный ответ, а не пропуск', () => {
    const parsed = clientBriefSchema.safeParse({ ...FULL, negativeCities: [], competitors: [] });
    expect(parsed.success).toBe(true);
  });

  it('требует хотя бы одну цель конверсии и одно УТП', () => {
    expect(clientBriefSchema.safeParse({ ...FULL, conversionGoals: [] }).success).toBe(false);
    expect(clientBriefSchema.safeParse({ ...FULL, usp: [] }).success).toBe(false);
  });

  it('отбивает дневной бюджет ниже минимума Директа', () => {
    // Так выглядит «5 тыщ», разобранное моделью как «5».
    expect(clientBriefSchema.safeParse({ ...FULL, dailyBudgetRub: 5 }).success).toBe(false);
  });

  it('отбивает дробные и отрицательные деньги', () => {
    expect(clientBriefSchema.safeParse({ ...FULL, targetCpaRub: 2000.5 }).success).toBe(false);
    expect(clientBriefSchema.safeParse({ ...FULL, targetCpaRub: -1 }).success).toBe(false);
  });

  it('отбивает суммы с лишними нулями', () => {
    expect(clientBriefSchema.safeParse({ ...FULL, targetCpaRub: 50_000_000 }).success).toBe(false);
  });

  it('проверяет диапазон возраста', () => {
    const broken = { ...FULL, audience: { description: 'кто угодно', ageFrom: 50, ageTo: 20 } };
    expect(clientBriefSchema.safeParse(broken).success).toBe(false);
  });

  it('требует настоящий url у сайта конкурента', () => {
    const broken = { ...FULL, competitors: [{ name: 'X', site: 'скайэнг' }] };
    expect(clientBriefSchema.safeParse(broken).success).toBe(false);
  });
});

describe('briefDraftSchema', () => {
  it('разрешает отсутствие любого поля', () => {
    expect(briefDraftSchema.safeParse({}).success).toBe(true);
    expect(briefDraftSchema.safeParse({ product: 'Пылесосы' }).success).toBe(true);
  });

  it('но проверяет то, что присутствует', () => {
    expect(briefDraftSchema.safeParse({ dailyBudgetRub: 10 }).success).toBe(false);
  });

  it('выкидывает неизвестные ключи, а не тащит их в бриф', () => {
    const parsed = briefDraftSchema.parse({ product: 'Пылесосы', выдумка: 42 });
    expect(parsed).toEqual({ product: 'Пылесосы' });
  });
});

describe('missingBriefFields', () => {
  it('на пустом черновике возвращает все обязательные поля', () => {
    expect(missingBriefFields({})).toEqual([...REQUIRED_BRIEF_FIELDS]);
  });

  it('на полном брифе — пусто', () => {
    expect(missingBriefFields(FULL)).toEqual([]);
  });

  it('считает недостающим поле с непроходящим схему значением', () => {
    // Значение есть, но 50 ₽ в день Директ не примет: интервью обязано переспросить.
    expect(missingBriefFields({ ...FULL, dailyBudgetRub: 50 })).toEqual(['dailyBudgetRub']);
  });

  it('не считает недостающими необязательные поля', () => {
    expect(missingBriefFields(FULL)).not.toContain('landingUrl');
  });
});

describe('parseCompleteBrief', () => {
  it('возвращает разобранный бриф', () => {
    const result = parseCompleteBrief(FULL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.brief.product).toBe(FULL.product);
  });

  it('перечисляет проблемы человекочитаемо', () => {
    const result = parseCompleteBrief({ ...FULL, targetCpaRub: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('targetCpaRub');
  });
});

describe('briefWarnings', () => {
  it('замечает бюджет меньше целевого CPA', () => {
    const warnings = briefWarnings({ ...FULL, dailyBudgetRub: 1_000, targetCpaRub: 3_000 });
    expect(warnings.join(' ')).toContain('меньше одной заявки в день');
  });

  it('замечает город и в гео, и в минус-городах', () => {
    const warnings = briefWarnings({ ...FULL, negativeCities: ['москва'] });
    expect(warnings.join(' ')).toContain('Москва');
  });

  it('на чистом брифе молчит', () => {
    expect(briefWarnings(FULL)).toEqual([]);
  });
});

describe('isMoneyField', () => {
  it('покрывает ровно денежные поля', () => {
    expect(isMoneyField('targetCpaRub')).toBe(true);
    expect(isMoneyField('dailyBudgetRub')).toBe(true);
    expect(isMoneyField('product')).toBe(false);
  });
});
