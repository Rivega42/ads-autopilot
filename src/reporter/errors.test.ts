import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb } from '@/reporter/__tests__/fake-db.js';
import {
  describeFailure,
  recordFailure,
  ReportDeliveryError,
  REPORT_FAILURE_CODES,
} from '@/reporter/errors.js';

describe('describeFailure', () => {
  it('отличает неушедший отчёт от несобравшегося', () => {
    const delivery = describeFailure(
      'cl1',
      'daily',
      new ReportDeliveryError('cl1', 'rep-1', new Error('Telegram down')),
    );
    const build = describeFailure('cl1', 'daily', new Error('metrics query exploded'));

    // Этап у обоих один и тот же — `daily`. Различает их только код ошибки, и
    // раньше это различие терялось: в журнал уходил один код на оба случая.
    expect(delivery.code).toBe(REPORT_FAILURE_CODES.delivery);
    expect(build.code).toBe(REPORT_FAILURE_CODES.build);
  });

  it('видит ошибку доставки и на служебном этапе', () => {
    const failure = describeFailure(
      null,
      'alerts',
      new ReportDeliveryError('cl1', 'rep-1', new Error('Telegram down')),
    );

    expect(failure.code).toBe(REPORT_FAILURE_CODES.delivery);
  });
});

describe('recordFailure', () => {
  it('пишет в журнал тот код, который различает виды отказа', async () => {
    const db = new FakeDb();

    await recordFailure(
      db.asDb(),
      describeFailure(
        'cl1',
        'daily',
        new ReportDeliveryError('cl1', 'rep-1', new Error('Telegram down')),
      ),
    );
    await recordFailure(db.asDb(), describeFailure('cl1', 'weekly', new Error('LLM exploded')));

    expect(db.errors.map((row) => [row.scope, row.code])).toEqual([
      ['reporter:daily', REPORT_FAILURE_CODES.delivery],
      ['reporter:weekly', REPORT_FAILURE_CODES.build],
    ]);
  });

  it('не роняет прогон, когда журнал недоступен', async () => {
    const db = new FakeDb();
    const failing = {
      ...db.asDb(),
      errorLog: {
        create: () => Promise.reject(new Error('db down')),
      },
    } as unknown as Parameters<typeof recordFailure>[0];

    await expect(
      recordFailure(failing, describeFailure('cl1', 'daily', new Error('boom'))),
    ).resolves.toBeUndefined();
  });
});
