import { describe, expect, it } from 'vitest';

import { optimizeNeedsHumanFix } from './optimize-exit.js';

import type { ScheduledOptimizationSummary } from '@/optimizer/index.js';

function summary(over: Partial<ScheduledOptimizationSummary> = {}): ScheduledOptimizationSummary {
  return {
    campaigns: 3,
    autoApply: 5,
    plannedOnly: 0,
    noop: 0,
    applyFailed: 0,
    localStateFailed: 0,
    approvals: 2,
    approvalsFailed: 0,
    approvalsUndelivered: 0,
    approvalsDuplicate: 0,
    rejected: 3,
    clamped: 0,
    noTargetCpa: 0,
    skipped: {},
    failed: 0,
    ...over,
  };
}

describe('optimizeNeedsHumanFix', () => {
  it('чистый прогон — нулевой код', () => {
    expect(optimizeNeedsHumanFix(summary())).toBe(false);
  });

  it.each([
    ['applyFailed', { applyFailed: 5 }],
    ['approvalsFailed', { approvalsFailed: 1 }],
    ['localStateFailed', { localStateFailed: 1 }],
    ['failed', { failed: 1 }],
  ])('%s — потеря, которую сама система не исправит', (_name, over) => {
    expect(optimizeNeedsHumanFix(summary(over))).toBe(true);
  });

  it('недоставленная карточка кода возврата не поднимает', () => {
    // Стоячее состояние, а не поломка прогона: клиент держит бота в блоке, и само
    // оно не пройдёт. Ненулевой код горел бы каждые сутки подряд — ровно тот износ,
    // из-за которого отсюда исключён и незаполненный бриф. Повод доставляет
    // тревога `approval_undelivered`, а не код возврата.
    expect(optimizeNeedsHumanFix(summary({ approvalsUndelivered: 2 }))).toBe(false);
  });

  it('кампании без цели по CPA кодом возврата не сигналят', () => {
    // Незаполненный бриф — не поломка прогона: ненулевой код горел бы каждый
    // прогон подряд и перестал бы значить хоть что-нибудь.
    expect(optimizeNeedsHumanFix(summary({ noTargetCpa: 4 }))).toBe(false);
  });

  it('повтор в те же сутки — тоже не повод будить человека', () => {
    expect(
      optimizeNeedsHumanFix(summary({ autoApply: 0, approvals: 0, approvalsDuplicate: 2 })),
    ).toBe(false);
  });
});
