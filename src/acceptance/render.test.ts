import { describe, expect, it } from 'vitest';

import type { CycleVerdict, DayVerdict } from '@/acceptance/cycle.js';
import { renderCycleMarkdown, renderCycleText } from '@/acceptance/render.js';

function day(date: string, overrides: Partial<DayVerdict> = {}): DayVerdict {
  return {
    date,
    status: 'passed',
    checks: [{ id: 'db:clients', title: 'Клиенты и доступы', status: 'pass', detail: '2 шт.' }],
    notes: [],
    ...overrides,
  };
}

function cycle(overrides: Partial<CycleVerdict> = {}): CycleVerdict {
  return {
    days: [day('2026-08-19'), day('2026-08-20'), day('2026-08-21')],
    required: 3,
    passed: 3,
    status: 'passed',
    ...overrides,
  };
}

describe('renderCycleText', () => {
  it('пройденный цикл называется пройденным и считает сутки', () => {
    const text = renderCycleText(cycle());
    expect(text).toContain('ПРОЙДЕН');
    expect(text).toContain('3 из 3');
  });

  it('срыв объявляется так же громко, как успех, и первым делом', () => {
    const broken = cycle({
      status: 'failed',
      passed: 2,
      days: [
        day('2026-08-19'),
        day('2026-08-20', {
          status: 'failed',
          checks: [
            { id: 'db:errors', title: 'Журнал ошибок', status: 'fail', detail: '4 записи: 401' },
          ],
        }),
        day('2026-08-21'),
      ],
    });
    const text = renderCycleText(broken);
    expect(text.split('\n')[0]).toContain('СОРВАН');
    expect(text).toContain('20.08');
    expect(text).toContain('401');
    expect(text).not.toContain('ПРОЙДЕН —');
  });

  it('нехватка улик называется нехваткой улик, а не успехом', () => {
    const text = renderCycleText(cycle({ status: 'no-data', passed: 0, days: [] }));
    expect(text).toContain('НЕТ ДАННЫХ');
    expect(text).not.toContain('ПРОЙДЕН');
  });

  it('пройденные сутки не тонут в списке проверок, а сорванные — показываются целиком', () => {
    const text = renderCycleText(
      cycle({
        status: 'failed',
        passed: 0,
        days: [
          day('2026-08-19', {
            status: 'failed',
            checks: [
              { id: 'cron:daily-report', title: 'daily-report', status: 'fail', detail: '0 из 1' },
              { id: 'db:clients', title: 'Клиенты', status: 'pass', detail: '2 шт.' },
            ],
            notes: ['нажатий по карточкам апрува: 2'],
          }),
        ],
      }),
    );
    expect(text).toContain('0 из 1');
    expect(text).toContain('нажатий по карточкам апрува: 2');
  });
});

describe('renderCycleMarkdown', () => {
  it('спецсимволы Telegram экранируются', () => {
    const md = renderCycleMarkdown(
      cycle({
        status: 'failed',
        passed: 0,
        days: [
          day('2026-08-19', {
            status: 'failed',
            checks: [
              {
                id: 'db:errors',
                title: 'Журнал ошибок',
                status: 'fail',
                detail: 'ingestion: 401 (token_expired) [yandex-direct]',
              },
            ],
          }),
        ],
      }),
    );
    expect(md).toContain('\\(token\\_expired\\)');
    expect(md).toContain('\\[yandex\\-direct\\]');
  });
});
