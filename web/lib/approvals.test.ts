import { describe, expect, it } from 'vitest';

import { approvalsEmptyText, approvalsSubtitle } from './approvals';

const BASE = {
  periodApplies: false,
  total: 12,
  queueTotal: 12,
  from: '2026-07-01',
  to: '2026-07-30',
  rangeDays: 30,
};

describe('подзаголовок очереди апрувов', () => {
  it('история решений подписана периодом', () => {
    const text = approvalsSubtitle({ ...BASE, periodApplies: true, total: 2, queueTotal: null });

    expect(text).toBe('30 дн.: 01.07.2026 — 30.07.2026 (МСК)');
  });

  it('очередь без фильтров названа целой — потому что она целая', () => {
    const text = approvalsSubtitle(BASE);

    expect(text).toContain('Ждут решения: 12');
    expect(text).toContain('целиком');
  });

  it('под фильтром названы оба числа, и слова «целиком» нет', () => {
    // Тот самый случай: в шапке 12, на странице 3 при clientStatus=ACTIVE.
    const text = approvalsSubtitle({ ...BASE, total: 3, queueTotal: 12 });

    expect(text).toContain('3 из 12');
    expect(text).not.toContain('целиком');
    expect(text).toContain('счётчик в шапке считает всю очередь');
  });

  it('совпадение чисел под фильтром лишнего не дописывает', () => {
    // Фильтр, который никого не отсеял: объяснять нечего, и объяснения нет.
    const text = approvalsSubtitle({ ...BASE, total: 12, queueTotal: 12 });

    expect(text).not.toContain('из 12 в очереди');
    expect(text).toContain('целиком');
  });
});

describe('пустая таблица очереди апрувов', () => {
  it('пустая очередь названа пустой', () => {
    expect(approvalsEmptyText({ periodApplies: false, queueTotal: 0 })).toBe(
      'Ничего не ждёт решения.',
    );
  });

  it('пусто из-за фильтра — про пустую очередь не говорится', () => {
    const text = approvalsEmptyText({ periodApplies: false, queueTotal: 12 });

    expect(text).toContain('Под фильтром');
    expect(text).toContain('12');
    expect(text).not.toBe('Ничего не ждёт решения.');
  });

  it('история решений объясняется периодом, а не очередью', () => {
    expect(approvalsEmptyText({ periodApplies: true, queueTotal: null })).toContain('период');
  });
});
