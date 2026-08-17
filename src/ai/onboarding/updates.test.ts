import { describe, expect, it } from 'vitest';

import { interviewTurnSchema } from './turn.schema.js';
import { applyTurnUpdates, normalizeQuote, quoteFound, quoteMentionsNumber } from './updates.js';

const CLIENT_SAID = ['Курсы английского для айтишников', 'Готов платить 2000 ₽ за заявку'];

function turn(patch: Record<string, unknown>) {
  return interviewTurnSchema.parse({ reply: 'Дальше?', ...patch });
}

describe('normalizeQuote', () => {
  it('стирает пунктуацию и регистр', () => {
    expect(normalizeQuote('  2000 ₽, за Заявку!  ')).toBe('2000 за заявку');
  });
});

describe('quoteFound', () => {
  it('находит цитату с другой пунктуацией и регистром', () => {
    expect(quoteFound('2000 ₽!', ['Готов платить 2000 рублей за заявку'])).toBe(true);
  });

  it('не находит цифру, которой клиент не называл', () => {
    expect(quoteFound('3500 рублей', ['готов платить 2000 рублей'])).toBe(false);
  });

  it('не считает подтверждением односимвольную цитату', () => {
    expect(quoteFound('2', ['2000 рублей'])).toBe(false);
  });
});

describe('quoteMentionsNumber', () => {
  it('находит число, записанное с разделителями тысяч', () => {
    expect(quoteMentionsNumber('2 000 ₽', 2_000)).toBe(true);
    // Неразрывный пробел прилетает из копипасты — цитата от этого честнее не станет.
    expect(quoteMentionsNumber('2\u00a0000 ₽', 2_000)).toBe(true);
    expect(quoteMentionsNumber('счётчик 12.345.678', 12_345_678)).toBe(true);
    expect(quoteMentionsNumber('12 345 678', 12_345_678)).toBe(true);
  });

  it('понимает «тыщи» и «к», как их пишут клиенты', () => {
    expect(quoteMentionsNumber('5 тыщ в день', 5_000)).toBe(true);
    expect(quoteMentionsNumber('до 3 тысяч', 3_000)).toBe(true);
    expect(quoteMentionsNumber('по 2к за заявку', 2_000)).toBe(true);
    expect(quoteMentionsNumber('1 млн в месяц', 1_000_000)).toBe(true);
  });

  it('не находит числа, которого в цитате нет', () => {
    expect(quoteMentionsNumber('12345678', 44_001)).toBe(false);
    expect(quoteMentionsNumber('счётчик', 99_999_999)).toBe(false);
    expect(quoteMentionsNumber('2000 ₽', 3_000)).toBe(false);
  });

  it('не принимает часть числа за само число', () => {
    expect(quoteMentionsNumber('44001', 4_400)).toBe(false);
  });
});

describe('applyTurnUpdates', () => {
  it('принимает неденежные поля без цитат', () => {
    const result = applyTurnUpdates({}, turn({ updates: { product: 'Курсы английского' } }), []);
    expect(result.draft.product).toBe('Курсы английского');
    expect(result.rejected).toEqual([]);
  });

  it('принимает сумму, подтверждённую цитатой клиента', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { targetCpaRub: 2000 }, evidence: { targetCpaRub: '2000 ₽ за заявку' } }),
      CLIENT_SAID,
    );
    expect(result.draft.targetCpaRub).toBe(2_000);
    expect(result.accepted).toContain('targetCpaRub');
  });

  it('отбрасывает сумму без цитаты', () => {
    const result = applyTurnUpdates({}, turn({ updates: { targetCpaRub: 2000 } }), CLIENT_SAID);
    expect(result.draft.targetCpaRub).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'targetCpaRub', reason: 'no-evidence' });
  });

  it('отбрасывает сумму, которой клиент не называл', () => {
    // Модель «вывела» типичный для ниши CPA и сослалась на несуществующую фразу.
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { targetCpaRub: 3500 },
        evidence: { targetCpaRub: 'обычно в нише 3500' },
      }),
      CLIENT_SAID,
    );
    expect(result.draft.targetCpaRub).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ reason: 'evidence-not-found' });
  });

  it('отбрасывает счётчик Метрики без цитаты', () => {
    // Правдоподобный, но выдуманный номер — это чужие конверсии в отчёте клиента.
    const result = applyTurnUpdates(
      {},
      turn({ updates: { metrika: { counterId: 12_345_678 } } }),
      CLIENT_SAID,
    );
    expect(result.draft.metrika).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'metrika', reason: 'no-evidence' });
  });

  it('принимает счётчик, названный клиентом', () => {
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 12_345_678 } },
        evidence: { metrika: '12345678' },
      }),
      [...CLIENT_SAID, 'Счётчик 12345678'],
    );
    expect(result.draft.metrika).toEqual({ counterId: 12_345_678 });
  });

  it('отбрасывает счётчик, цитата для которого его не содержит', () => {
    // Клиент сказал «номер сейчас не помню» — слово «счётчик» в его ответе есть,
    // а номера нет: цитата обязана содержать само значение, иначе это не цитата.
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 99_999_999 } },
        evidence: { metrika: 'счётчик' },
      }),
      [...CLIENT_SAID, 'Счётчик номер сейчас не помню'],
    );
    expect(result.draft.metrika).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ field: 'metrika', reason: 'value-not-quoted' });
  });

  it('отбрасывает блок Метрики, если цитата подтверждает только счётчик', () => {
    // Цитата одна на весь объект, а цель — это то, что система считает заявкой:
    // по ней двигаются ставки, и её тоже должен был назвать клиент.
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 12_345_678, goalId: 44_001 } },
        evidence: { metrika: '12345678' },
      }),
      [...CLIENT_SAID, 'Счётчик 12345678, цель заявка с формы — 44001'],
    );
    expect(result.draft.metrika).toBeUndefined();
    expect(result.rejected[0]).toMatchObject({ reason: 'value-not-quoted' });
  });

  it('принимает счётчик с целью, когда цитата содержит оба числа', () => {
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { metrika: { counterId: 12_345_678, goalId: 44_001 } },
        evidence: { metrika: 'счётчик 12345678, цель заявка с формы — 44001' },
      }),
      [...CLIENT_SAID, 'Да, счётчик 12345678, цель заявка с формы — 44001'],
    );
    expect(result.draft.metrika).toEqual({ counterId: 12_345_678, goalId: 44_001 });
    expect(result.rejected).toEqual([]);
  });

  it('снимает id цели, который клиент не называл, но оставляет саму цель', () => {
    // Названия целей клиент диктует словами, и переспрашивать их из-за выдуманного
    // id — значит зациклить интервью на поле, на которое он уже ответил.
    const result = applyTurnUpdates(
      {},
      turn({ updates: { conversionGoals: [{ name: 'заявка', metrikaGoalId: 44_001 }] } }),
      CLIENT_SAID,
    );
    expect(result.draft.conversionGoals).toEqual([{ name: 'заявка' }]);
    expect(result.rejected[0]).toMatchObject({
      field: 'conversionGoals',
      reason: 'no-evidence',
      value: [44_001],
    });
  });

  it('оставляет id цели, названный клиентом', () => {
    const result = applyTurnUpdates(
      {},
      turn({
        updates: { conversionGoals: [{ name: 'заявка', metrikaGoalId: 44_001 }] },
        evidence: { conversionGoals: 'цель заявка — 44001' },
      }),
      [...CLIENT_SAID, 'Цель заявка — 44001'],
    );
    expect(result.draft.conversionGoals).toEqual([{ name: 'заявка', metrikaGoalId: 44_001 }]);
    expect(result.rejected).toEqual([]);
  });

  it('цели без id цитаты не требуют', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { conversionGoals: [{ name: 'заявка с формы' }, { name: 'звонок' }] } }),
      CLIENT_SAID,
    );
    expect(result.draft.conversionGoals).toEqual([{ name: 'заявка с формы' }, { name: 'звонок' }]);
    expect(result.rejected).toEqual([]);
  });

  it('«Метрики нет» цитаты не требует', () => {
    // Отказ — не выдуманное значение: подтверждать в нём нечего.
    const result = applyTurnUpdates({}, turn({ updates: { metrika: null } }), CLIENT_SAID);
    expect(result.draft.metrika).toBeNull();
    expect(result.rejected).toEqual([]);
  });

  it('не роняет остальные поля хода из-за отклонённой суммы', () => {
    const result = applyTurnUpdates(
      {},
      turn({ updates: { geo: ['Москва'], dailyBudgetRub: 5000 } }),
      CLIENT_SAID,
    );
    expect(result.draft.geo).toEqual(['Москва']);
    expect(result.draft.dailyBudgetRub).toBeUndefined();
  });

  it('перезаписывает уже известное поле новым ответом', () => {
    const result = applyTurnUpdates(
      { geo: ['Москва'] },
      turn({ updates: { geo: ['Москва', 'Казань'] } }),
      [],
    );
    expect(result.draft.geo).toEqual(['Москва', 'Казань']);
  });

  it('не трогает исходный черновик', () => {
    const draft = { product: 'Пылесосы' };
    applyTurnUpdates(draft, turn({ updates: { product: 'Не пылесосы' } }), []);
    expect(draft.product).toBe('Пылесосы');
  });
});
