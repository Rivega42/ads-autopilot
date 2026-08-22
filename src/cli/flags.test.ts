import { describe, expect, it } from 'vitest';

import { resolveApply, resolveClientId } from './flags.js';

import { AppError } from '@/lib/errors.js';

describe('resolveApply', () => {
  it('без флагов ничего не применяется — общий договор CLI', () => {
    expect(resolveApply({})).toBe(false);
  });

  it('--apply включает запись', () => {
    expect(resolveApply({ apply: true })).toBe(true);
  });

  it('--dry-run — это умолчание, названное вслух (пункт приёмки ТЗ §9.3)', () => {
    expect(resolveApply({ dryRun: true })).toBe(false);
  });

  it('--apply --dry-run отвергается, а не разрешается в чью-то пользу', () => {
    // Молчаливый выбор одного из двух — худший исход: человек, набравший оба
    // флага, не знает, что именно сейчас произойдёт с деньгами клиента.
    let caught: unknown;
    try {
      resolveApply({ apply: true, dryRun: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('CLI_FLAGS_CONFLICT');
    expect((caught as AppError).message).toContain('--apply');
    expect((caught as AppError).message).toContain('--dry-run');
  });
});

describe('resolveClientId', () => {
  it('без флага фильтра нет — прогон по всем клиентам', () => {
    expect(resolveClientId(undefined)).toBeUndefined();
  });

  it('обычное значение доезжает как есть', () => {
    expect(resolveClientId('cl_123')).toBe('cl_123');
  });

  it('лишние пробелы по краям срезаются', () => {
    expect(resolveClientId(' cl_123\n')).toBe('cl_123');
  });

  it.each(['', '   '])('пустое значение (%j) — отказ, а не «все клиенты»', (raw) => {
    let caught: unknown;
    try {
      resolveClientId(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('CLI_CLIENT_EMPTY');
    expect((caught as AppError).message).toContain('--client');
  });
});
