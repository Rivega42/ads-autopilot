import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/env.js';

const h = vi.hoisted(() => ({
  runIngestion: vi.fn(async () => ({ targets: 1, ok: 1, failures: [] })),
  runSearchQueryIngestion: vi.fn(async () => ({ targets: 1, ok: 1, written: 3, failures: [] })),
  refreshExpiringTokens: vi.fn(async () => ({ checked: 2, refreshed: 1, failures: [] })),
  expireApprovals: vi.fn(async () => ({ expired: 1, raced: 0, stuck: 0 })),
  runWeeklyKeywordRefresh: vi.fn(async () => ({ clients: 1, cores: 1, degraded: 1 })),
  runModerationCheck: vi.fn(async () => ({ polled: 4, repaired: 1, escalated: 0 })),
  runAbEvaluation: vi.fn(async (_options: { dryRun: boolean }) => ({
    adGroups: 3,
    winners: 1,
    approvals: 1,
  })),
  releaseAbApprovalKeys: vi.fn(async (_approval: { payload: unknown }) => 1),
  registerExpiredApprovalHandler: vi.fn(
    (_name: string, _handler: (approval: unknown) => Promise<void>) => undefined,
  ),
  purgeExpiredIdempotencyKeys: vi.fn(async () => 7),
}));

vi.mock('@/ingestion/index.js', () => ({
  runIngestion: h.runIngestion,
  runSearchQueryIngestion: h.runSearchQueryIngestion,
  refreshExpiringTokens: h.refreshExpiringTokens,
}));
vi.mock('@/approval/index.js', () => ({
  expireApprovals: h.expireApprovals,
  registerExpiredApprovalHandler: h.registerExpiredApprovalHandler,
}));
vi.mock('@/scheduler/purge.js', () => ({
  purgeExpiredIdempotencyKeys: h.purgeExpiredIdempotencyKeys,
}));
vi.mock('@/keywords/index.js', () => ({ runWeeklyKeywordRefresh: h.runWeeklyKeywordRefresh }));
vi.mock('@/moderation/index.js', () => ({ runModerationCheck: h.runModerationCheck }));
vi.mock('@/creatives/index.js', () => ({
  runAbEvaluation: h.runAbEvaluation,
  releaseAbApprovalKeys: h.releaseAbApprovalKeys,
}));

const { handlers } = await import('@/scheduler/handlers.js');
const { QUEUE_NAMES } = await import('@/scheduler/queues.js');

// Снимок делается сразу после импорта: подписка на истёкшие заявки происходит один раз
// при загрузке модуля, а `clearAllMocks` в beforeEach стёр бы её из истории вызовов.
const expiredSubscription = h.registerExpiredApprovalHandler.mock.calls[0];

const job = (id = 'job-1'): Job => ({ id }) as Job;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handlers', () => {
  it('на каждую очередь есть обработчик', () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      expect(typeof handlers[name]).toBe('function');
    }
  });

  it('fetch-stats-hourly запускает загрузку и отдаёт сводку', async () => {
    const result = await handlers[QUEUE_NAMES.fetchStats](job(), 'token');

    expect(h.runIngestion).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ targets: 1, ok: 1 });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('wordstat-mine грузит запросы, потом пересобирает ядро', async () => {
    const order: string[] = [];
    h.runSearchQueryIngestion.mockImplementationOnce(async () => {
      order.push('queries');
      return { targets: 1, ok: 1, written: 3, failures: [] };
    });
    h.runWeeklyKeywordRefresh.mockImplementationOnce(async () => {
      order.push('core');
      return { clients: 1, cores: 1, degraded: 1 };
    });

    const result = await handlers[QUEUE_NAMES.wordstatMine](job(), 'token');

    // Порядок важен: пересбор ядра читает SearchQueryStat, и на устаревших
    // данных предложит минус-слова по прошлой неделе.
    expect(order).toEqual(['queries', 'core']);
    expect(result).toMatchObject({ queries: { written: 3 }, core: { cores: 1 } });
  });

  it('refresh-tokens продлевает токены', async () => {
    const result = await handlers[QUEUE_NAMES.refreshTokens](job(), 'token');

    expect(h.refreshExpiringTokens).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ checked: 2, refreshed: 1 });
  });

  it('expire-approvals подключён к approval-модулю', async () => {
    const result = await handlers[QUEUE_NAMES.expireApprovals](job(), 'token');

    expect(h.expireApprovals).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ expired: 1 });
  });

  it('expire-approvals заодно чистит просроченные ключи идемпотентности', async () => {
    const result = await handlers[QUEUE_NAMES.expireApprovals](job(), 'token');

    expect(h.purgeExpiredIdempotencyKeys).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ purgedKeys: 7 });
  });

  it('истёкшая A/B-карточка освобождает свой ключ: решение обязано прийти снова', async () => {
    const [name, handler] = expiredSubscription ?? [];
    expect(name).toBe('creatives:ab');

    await handler?.({ id: 'ap-1', payload: { kind: 'pause_entities' } });
    expect(h.releaseAbApprovalKeys).toHaveBeenCalledTimes(1);
  });

  it('второй тик поверх незакончившегося первого не запускает работу повторно', async () => {
    let release = (): void => {};
    h.runIngestion.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = () => resolve({ targets: 1, ok: 1, failures: [] });
        }),
    );

    const first = handlers[QUEUE_NAMES.fetchStats](job('a'), 'token');
    const second = await handlers[QUEUE_NAMES.fetchStats](job('b'), 'token');

    expect(second).toEqual({ skipped: true, reason: 'already running' });
    expect(h.runIngestion).toHaveBeenCalledTimes(1);

    release();
    await first;

    // Замок снят — следующий тик снова работает.
    await handlers[QUEUE_NAMES.fetchStats](job('c'), 'token');
    expect(h.runIngestion).toHaveBeenCalledTimes(2);
  });

  it('замок снимается и после падения, а ошибка уходит в BullMQ', async () => {
    h.runIngestion.mockRejectedValueOnce(new Error('redis is down'));

    await expect(handlers[QUEUE_NAMES.fetchStats](job(), 'token')).rejects.toThrow('redis is down');

    await handlers[QUEUE_NAMES.fetchStats](job(), 'token');
    expect(h.runIngestion).toHaveBeenCalledTimes(2);
  });

  it('evaluate-ab-tests оценивает эксперименты с предохранителем из env', async () => {
    const result = await handlers[QUEUE_NAMES.evaluateAbTests](job(), 'token');

    expect(h.runAbEvaluation).toHaveBeenCalledTimes(1);
    // Крон не имеет права применять изменения в обход общего предохранителя.
    const [options] = h.runAbEvaluation.mock.calls[0] ?? [];
    expect(options).toEqual({ dryRun: env.DRY_RUN });
    expect(result).toMatchObject({ winners: 1, approvals: 1 });
  });

  it('check-moderation опрашивает статусы', async () => {
    const result = await handlers[QUEUE_NAMES.checkModeration](job(), 'token');

    expect(h.runModerationCheck).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ polled: 4, repaired: 1 });
  });
});
