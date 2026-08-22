import { describe, expect, it } from 'vitest';

import { resolveApply } from './flags.js';

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
