import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { FAILURE_ROWS_PER_BATCH_CAP, recordFailures, type OptimizerFailure } from './errors.js';

import { ERROR_BURST_THRESHOLD } from '@/reporter/alerts.js';

interface Row {
  clientId: string;
  provider: string;
  scope: string;
  code: string;
  message: string;
}

function fakeDb(): { db: PrismaClient; rows: Row[]; createMany: ReturnType<typeof vi.fn> } {
  const rows: Row[] = [];
  const createMany = vi.fn(async ({ data }: { data: Row[] }) => {
    rows.push(...data);
    return { count: data.length };
  });
  return { db: { errorLog: { createMany } } as unknown as PrismaClient, rows, createMany };
}

function failure(index: number, over: Partial<OptimizerFailure> = {}): OptimizerFailure {
  return {
    clientId: 'cl-1',
    provider: 'YANDEX_DIRECT',
    campaignId: 'c-1',
    stage: 'apply',
    code: 'PLATFORM_WRITE_REFUSED',
    message: `отказ ${index}`,
    ...over,
  };
}

describe('FAILURE_ROWS_PER_BATCH_CAP', () => {
  it('строго выше порога тревоги — иначе массовый отказ одной кампании никого не разбудит', () => {
    // `detectAlerts` срабатывает на `inWindow.length > threshold`, поэтому потолка,
    // равного порогу, недостаточно: нужен хотя бы один отказ сверху.
    expect(FAILURE_ROWS_PER_BATCH_CAP).toBeGreaterThan(ERROR_BURST_THRESHOLD);
  });
});

describe('recordFailures', () => {
  it('пишет строку на каждый отказ: тревога считает строки, а не причины', async () => {
    const { db, rows, createMany } = fakeDb();

    await recordFailures(db, [failure(1), failure(2), failure(3)]);

    // Один запрос, три строки: кабинет уже лёг, добавлять к этому три round-trip'а незачем.
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.scope === 'optimizer:apply')).toBe(true);
    expect(rows.every((r) => r.clientId === 'cl-1' && r.provider === 'YANDEX_DIRECT')).toBe(true);
  });

  it('сверх потолка схлопывает хвост в одну строку, сохраняя число и коды', async () => {
    const { db, rows } = fakeDb();
    const failures = [
      ...Array.from({ length: FAILURE_ROWS_PER_BATCH_CAP + 5 }, (_u, i) => failure(i)),
      failure(999, { code: 'CHANGELOG_WRITE_FAILED' }),
    ];

    await recordFailures(db, failures);

    expect(rows).toHaveLength(FAILURE_ROWS_PER_BATCH_CAP + 1);
    const tail = rows.at(-1);
    expect(tail?.code).toBe('TRUNCATED');
    expect(tail?.message).toContain('ещё 6');
    expect(tail?.message).toContain('PLATFORM_WRITE_REFUSED: 5');
    expect(tail?.message).toContain('CHANGELOG_WRITE_FAILED: 1');
  });

  it('пустая пачка не ходит в базу', async () => {
    const { db, createMany } = fakeDb();
    await recordFailures(db, []);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('не роняет прогон, если журнал недоступен', async () => {
    const db = {
      errorLog: { createMany: vi.fn().mockRejectedValue(new Error('connection pool timeout')) },
    } as unknown as PrismaClient;

    await expect(recordFailures(db, [failure(1)])).resolves.toBeUndefined();
  });
});
