import { describe, expect, it } from 'vitest';

import { interviewTurnSchema } from './turn.schema.js';
import { applyTurnUpdates, normalizeQuote, quoteFound } from './updates.js';

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
  it('находит цитату с другой пунктуацией', () => {
    expect(quoteFound('2000 рублей', ['Готов платить 2000 рублей за заявку'])).toBe(true);
    expect(quoteFound('2000 ₽!', ['готов платить 2000 руб'])).toBe(false);
  });

  it('не считает подтверждением односимвольную цитату', () => {
    expect(quoteFound('2', ['2000 рублей'])).toBe(false);
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
