import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runIngestion: vi.fn(async () => ({ targets: 1, ok: 1, failures: [] })),
  runSearchQueryIngestion: vi.fn(async () => ({ targets: 1, ok: 1, written: 3, failures: [] })),
  refreshExpiringTokens: vi.fn(async () => ({ checked: 2, refreshed: 1, failures: [] })),
  expireApprovals: vi.fn(async () => ({ expired: 1, raced: 0, stuck: 0 })),
}));

vi.mock('@/ingestion/index.js', () => ({
  runIngestion: h.runIngestion,
  runSearchQueryIngestion: h.runSearchQueryIngestion,
  refreshExpiringTokens: h.refreshExpiringTokens,
}));
vi.mock('@/approval/index.js', () => ({ expireApprovals: h.expireApprovals }));

const { handlers } = await import('@/scheduler/handlers.js');
const { QUEUE_NAMES } = await import('@/scheduler/queues.js');

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

  it('wordstat-mine грузит поисковые запросы', async () => {
    const result = await handlers[QUEUE_NAMES.wordstatMine](job(), 'token');

    expect(h.runSearchQueryIngestion).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ written: 3 });
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

  it('нереализованные обработчики честно сообщают об этом', async () => {
    const result = await handlers[QUEUE_NAMES.dailyReport](job(), 'token');

    expect(result).toEqual({ skipped: true, reason: 'not implemented' });
  });
});
