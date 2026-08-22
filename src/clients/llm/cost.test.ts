import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import {
  assertWithinMonthlyBudget,
  estimateCostUsd,
  getMonthlySpendUsd,
  monthStartMsk,
  type AiRunStore,
} from './cost.js';
import { LlmBudgetError } from './errors.js';

function storeWithSum(sum: unknown): { db: AiRunStore; aggregate: ReturnType<typeof vi.fn> } {
  const aggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: sum } });
  const db = { aiRun: { aggregate } } as unknown as Pick<PrismaClient, 'aiRun'>;
  return { db, aggregate };
}

describe('estimateCostUsd', () => {
  it('считает известную модель по прайсу', () => {
    // claude-opus-5: $5 за 1M входа, $25 за 1M выхода.
    expect(estimateCostUsd('claude-opus-5', 1_000_000, 100_000)).toBe(7.5);
    expect(estimateCostUsd('claude-opus-5', 0, 0)).toBe(0);
  });

  it('не теряет копейки на дешёвых моделях', () => {
    // deepseek-v4-flash: $0.14 / $0.28. 10k входа + 2k выхода = 0.0014 + 0.00056.
    expect(estimateCostUsd('deepseek-v4-flash', 10_000, 2_000)).toBeCloseTo(0.00196, 8);
  });

  it('для незнакомой модели возвращает null, а не ноль', () => {
    // Ноль был бы враньём и молча сломал бы месячный бюджет.
    expect(estimateCostUsd('some-unreleased-model', 1_000, 1_000)).toBeNull();
  });
});

describe('месячный бюджет клиента', () => {
  it('суммирует расход с начала месяца по МСК', async () => {
    const { db, aggregate } = storeWithSum('12.5');
    const now = new Date('2026-08-08T10:00:00Z');

    expect(await getMonthlySpendUsd('cl1', db, now)).toBe(12.5);

    const where = aggregate.mock.calls[0]![0].where;
    expect(where.clientId).toBe('cl1');
    expect(where.createdAt.gte.toISOString()).toBe(monthStartMsk(now).toISOString());
    // 1 августа 00:00 МСК = 31 июля 21:00 UTC.
    expect(monthStartMsk(now).toISOString()).toBe('2026-07-31T21:00:00.000Z');
  });

  it('считает отсутствие строк нулевым расходом', async () => {
    const { db } = storeWithSum(null);
    expect(await getMonthlySpendUsd('cl1', db)).toBe(0);
  });

  it('пропускает вызов, пока лимит не выбран', async () => {
    const { db } = storeWithSum('40');
    const status = await assertWithinMonthlyBudget('cl1', db, { limitUsd: 50 });
    expect(status).toMatchObject({ spentUsd: 40, limitUsd: 50, remainingUsd: 10, exceeded: false });
  });

  it('бросает LlmBudgetError, когда лимит исчерпан', async () => {
    const { db } = storeWithSum('60');
    await expect(assertWithinMonthlyBudget('cl1', db, { limitUsd: 50 })).rejects.toBeInstanceOf(
      LlmBudgetError,
    );
  });

  it('ошибка бюджета не ретраибельна', async () => {
    const { db } = storeWithSum('60');
    const err = await assertWithinMonthlyBudget('cl1', db, { limitUsd: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmBudgetError);
    expect((err as LlmBudgetError).retryable).toBe(false);
    expect((err as LlmBudgetError).context).toMatchObject({ clientId: 'cl1', spentUsd: 60 });
  });
});
