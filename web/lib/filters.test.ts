import { describe, expect, it } from 'vitest';

import { isPresetActive, parseFilters, presetLink, rangeLength, withFilters } from './filters';

const NOW = new Date('2026-08-08T10:00:00.000Z');

describe('parseFilters', () => {
  it('по умолчанию отдаёт 30 дней по МСК — требование приёмки §9.5', () => {
    const filters = parseFilters({}, NOW);
    expect(filters).toMatchObject({ from: '2026-07-10', to: '2026-08-08' });
    expect(rangeLength(filters)).toBe(30);
  });

  it('принимает явный период', () => {
    expect(parseFilters({ from: '2026-08-01', to: '2026-08-05' }, NOW)).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-05',
    });
  });

  it('вывернутый период откатывается к окну по умолчанию', () => {
    expect(parseFilters({ from: '2026-08-05', to: '2026-08-01' }, NOW)).toMatchObject({
      from: '2026-07-03',
      to: '2026-08-01',
    });
  });

  it('мусор в датах игнорируется', () => {
    expect(parseFilters({ from: 'вчера', to: '13.13.2026' }, NOW)).toMatchObject({
      from: '2026-07-10',
      to: '2026-08-08',
    });
  });

  it('будущее не запрашивается: конец периода не дальше сегодня', () => {
    expect(parseFilters({ to: '2027-01-01' }, NOW).to).toBe('2026-08-08');
  });

  it('слишком длинный период обрезается', () => {
    expect(parseFilters({ from: '2000-01-01' }, NOW).from).toBe('2026-07-10');
  });

  it('неизвестные значения перечислений отбрасываются', () => {
    expect(parseFilters({ provider: 'МОЙ_КАНАЛ', status: 'DROP TABLE' }, NOW)).toMatchObject({
      provider: null,
      status: null,
    });
  });

  it('известные значения проходят', () => {
    expect(parseFilters({ provider: 'VK_ADS', status: 'ACTIVE' }, NOW)).toMatchObject({
      provider: 'VK_ADS',
      status: 'ACTIVE',
    });
  });
});

describe('withFilters', () => {
  it('сохраняет срез при переходе между страницами', () => {
    const filters = parseFilters({ provider: 'VK_ADS' }, NOW);
    expect(withFilters('/campaigns', filters)).toBe(
      '/campaigns?provider=VK_ADS&from=2026-07-10&to=2026-08-08',
    );
  });

  it('пустое переопределение убирает параметр', () => {
    const filters = parseFilters({ clientId: 'abc' }, NOW);
    expect(withFilters('/campaigns', filters, { clientId: null })).not.toContain('clientId');
  });
});

describe('presetLink', () => {
  it('пресет ставит окно, оканчивающееся сегодня', () => {
    const filters = parseFilters({}, NOW);
    expect(presetLink('/campaigns', filters, 7, NOW)).toContain('from=2026-08-02');
    expect(isPresetActive(parseFilters({ from: '2026-08-02' }, NOW), 7)).toBe(true);
  });
});
