import { ChangeActor } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  APPLIED_ACTIONS,
  DECISION_ACTIONS,
  SERVICE_ACTIONS,
  changeActionLabel,
  describeChange,
} from './labels';

/**
 * Карта названий действий против того, что система действительно пишет.
 *
 * Она уже один раз устарела целиком: в ней жили `bid_up`, `bid_down` и `pause`,
 * которых не пишет никто, а восемнадцать настоящих действий доезжали до человека
 * сырыми идентификаторами. Поэтому проверяется не только содержимое карты, но и
 * поведение на незнакомом значении: молча выглядеть штатным названием оно не должно.
 *
 * Полноту карты по отношению к коду бэкенда проверяет `tests/e2e/dashboard-labels.e2e.ts`:
 * там доступны настоящие схемы и константы, отсюда — нет.
 */

function row(overrides: Partial<Parameters<typeof describeChange>[0]> = {}) {
  return {
    action: 'BID_DECREASE',
    actor: ChangeActor.AI,
    approvedBy: null,
    ...overrides,
  };
}

describe('карта названий действий', () => {
  it('три семейства не пересекаются: одно действие — одна форма', () => {
    const keys = [
      ...Object.keys(APPLIED_ACTIONS),
      ...Object.keys(DECISION_ACTIONS),
      ...Object.keys(SERVICE_ACTIONS),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('названия — человеческие, а не идентификаторы', () => {
    for (const [action, label] of Object.entries({
      ...APPLIED_ACTIONS,
      ...DECISION_ACTIONS,
      ...SERVICE_ACTIONS,
    })) {
      expect(label, action).not.toBe(action);
      expect(label, action).toMatch(/[А-Яа-я]/);
    }
  });

  it('регистр различает решение человека и применённое изменение', () => {
    // `budget_change` пишет апрув, `BUDGET_CHANGE` — оптимизатор. Это разные
    // события, и схлопывать их в одно имя нельзя.
    expect(describeChange(row({ action: 'budget_change' })).form).toBe('decision');
    expect(describeChange(row({ action: 'BUDGET_CHANGE' })).form).toBe('applied');
    expect(changeActionLabel('budget_change')).not.toBe(changeActionLabel('BUDGET_CHANGE'));
  });
});

describe('незнакомое действие', () => {
  it('не падает и показывает сам идентификатор', () => {
    const view = describeChange(row({ action: 'какое_то_новое_действие' }));

    expect(view.label).toBe('какое_то_новое_действие');
    expect(view.form).toBe('unknown');
  });

  it('помечено как неописанное — иначе карта устареет молча', () => {
    const view = describeChange(row({ action: 'какое_то_новое_действие' }));

    expect(view.note).not.toBeNull();
    expect(view.note).toMatch(/витрин/i);
  });

  it('пустое действие тоже не роняет выдачу', () => {
    expect(describeChange(row({ action: '' })).form).toBe('unknown');
    expect(describeChange(row({ action: '' })).label).toBe('');
  });

  it('прототипные имена не считаются известными действиями', () => {
    // Карта — обычный объект, и `constructor` в ней «есть». Без собственной
    // проверки ключа человек увидел бы функцию вместо названия.
    for (const action of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const view = describeChange(row({ action }));
      expect(view.form, action).toBe('unknown');
      expect(view.label, action).toBe(action);
    }
  });
});

describe('изменение ставки, выпущенное человеком', () => {
  const canonical = row({
    action: 'BID_DECREASE',
    actor: ChangeActor.USER,
    approvedBy: 'roman',
  });

  it('каноническая строка помечена как дубль решения', () => {
    const view = describeChange(canonical);

    expect(view.form).toBe('applied');
    expect(view.duplicate).toBe(true);
    expect(view.note).toMatch(/решени/i);
  });

  it('та же ставка от оптимизатора дублем не считается', () => {
    // У ночного прогона аудиторской строки нет вовсе: пометить её дублем значило
    // бы объявить технической единственную запись об изменении.
    expect(describeChange(row({ action: 'BID_DECREASE', actor: ChangeActor.AI })).duplicate).toBe(
      false,
    );
  });

  it('решение оптимизатора не становится дублем от одного лишь апрува', () => {
    // Признак держится на двух условиях сразу, и проверять надо оба: строка от
    // ночного прогона с заполненным `approvedBy` — форма, которую сегодня не
    // пишет никто, но именно ею признак и сломается, если такой писатель
    // появится. Без этой проверки условие про actor можно снять, и ни один тест
    // не покраснеет.
    expect(
      describeChange(row({ action: 'BID_DECREASE', actor: ChangeActor.AI, approvedBy: 'roman' }))
        .duplicate,
    ).toBe(false);
  });

  it('строка человека без апрува дублем не считается', () => {
    // `approvedBy` заполняет только `approval/bid-journal.ts`. Без него это чужая
    // запись, и пары у неё нет.
    expect(describeChange(row({ action: 'BID_DECREASE', actor: ChangeActor.USER })).duplicate).toBe(
      false,
    );
  });

  it('дубль — только про ставку: пауза и бюджет от человека уникальны', () => {
    for (const action of ['PAUSE', 'BUDGET_CHANGE', 'STRATEGY_CHANGE']) {
      expect(
        describeChange(row({ action, actor: ChangeActor.USER, approvedBy: 'roman' })).duplicate,
        action,
      ).toBe(false);
    }
  });

  it('аудиторская строка решения дублем не помечается', () => {
    // Она единственная, что остаётся, когда изменение до кабинета не доехало.
    const view = describeChange(
      row({ action: 'bid_change', actor: ChangeActor.USER, approvedBy: 'roman' }),
    );

    expect(view.form).toBe('decision');
    expect(view.duplicate).toBe(false);
  });
});
