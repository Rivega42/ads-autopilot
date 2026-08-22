import { describe, expect, it } from 'vitest';

import {
  cycleWindow,
  judgeCycle,
  judgeDay,
  type CycleEvidence,
  type DbEvidence,
  type QueueHistory,
} from '@/acceptance/cycle.js';
import { CYCLE_QUEUES, expectedRunsPerDay } from '@/acceptance/spec.js';
import { QUEUE_NAMES, type QueueName } from '@/scheduler/schedule.js';

const DAY = '2026-08-19';
const DAY_START = new Date('2026-08-18T21:00:00.000Z');
const DAY_END = new Date('2026-08-19T21:00:00.000Z');

/** Сводка, которую обработчик вернул бы на живом, ничем не примечательном кабинете. */
const SUMMARY: Record<QueueName, Record<string, unknown>> = {
  [QUEUE_NAMES.fetchStats]: { targets: 2, ok: 2, statsWritten: 40, failures: [] },
  [QUEUE_NAMES.checkModeration]: { targets: 2, ok: 2, failures: [] },
  [QUEUE_NAMES.optimizeBids]: {
    campaigns: 3,
    autoApply: 1,
    failed: 0,
    applyFailed: 0,
    approvalsFailed: 0,
    approvalsUndelivered: 0,
    localStateFailed: 0,
  },
  [QUEUE_NAMES.pauseLosers]: {
    campaigns: 3,
    autoApply: 0,
    failed: 0,
    applyFailed: 0,
    approvalsFailed: 0,
    approvalsUndelivered: 0,
    localStateFailed: 0,
  },
  [QUEUE_NAMES.evaluateAbTests]: {
    adGroups: 0,
    failed: 0,
    approvalsFailed: 0,
    unbuildable: 0,
  },
  [QUEUE_NAMES.dailyReport]: { clients: 2, sent: 2, skipped: 0, failures: [] },
  [QUEUE_NAMES.refreshTokens]: { checked: 2, refreshed: 0, failures: [] },
  [QUEUE_NAMES.expireApprovals]: { expired: 0, raced: 0, purgedKeys: 0 },
  [QUEUE_NAMES.alertScan]: { detected: 0, sent: 0 },
  [QUEUE_NAMES.wordstatMine]: {},
  [QUEUE_NAMES.weeklyReport]: {},
};

const HEALTHY_DB: DbEvidence = {
  activeClients: 2,
  clientsWithCredentials: 2,
  activeCampaigns: 3,
  errors: 0,
  errorSample: [],
  manualTouches: [],
  humanApprovals: 0,
  approvalsExpired: 0,
  approvalsFailed: 0,
  dailyReportsSent: 2,
};

function history(queue: QueueName, overrides: Partial<QueueHistory> = {}): QueueHistory {
  const runs = Array.from({ length: expectedRunsPerDay(queue) }, (_, i) => ({
    queue,
    jobId: `${queue}:${i}`,
    enqueuedAt: new Date(DAY_START.getTime() + i * 60_000),
    finishedAt: new Date(DAY_START.getTime() + i * 60_000 + 1_000),
    state: 'completed' as const,
    result: SUMMARY[queue],
    failedReason: null,
    attemptsMade: 1,
  }));
  return {
    queue,
    scheduled: true,
    // История достаёт до прошлых суток: значит «прогонов нет» — это про прогоны,
    // а не про подчищенную историю.
    oldestSeen: new Date(DAY_START.getTime() - 3_600_000),
    runs,
    ...overrides,
  };
}

function evidence(overrides: Partial<CycleEvidence> = {}): CycleEvidence {
  return {
    date: DAY,
    dayStart: DAY_START,
    dayEnd: DAY_END,
    queues: CYCLE_QUEUES.map((q) => history(q)),
    db: HEALTHY_DB,
    ...overrides,
  };
}

describe('judgeDay', () => {
  it('здоровые сутки засчитываются', () => {
    const verdict = judgeDay(evidence());
    expect(verdict.status).toBe('passed');
    expect(verdict.checks.filter((c) => c.status !== 'pass')).toEqual([]);
  });

  it('пустая база не читается как «всё хорошо»', () => {
    const verdict = judgeDay(
      evidence({
        db: {
          ...HEALTHY_DB,
          activeClients: 0,
          clientsWithCredentials: 0,
          activeCampaigns: 0,
          dailyReportsSent: 0,
        },
        queues: CYCLE_QUEUES.map((q) =>
          history(q, {
            runs: history(q).runs.map((run) => ({
              ...run,
              result: emptyBaseSummary(q),
            })),
          }),
        ),
      }),
    );
    expect(verdict.status).toBe('no-data');
    expect(verdict.status).not.toBe('passed');
    expect(verdict.checks.some((c) => c.id === 'db:clients' && c.status === 'unknown')).toBe(true);
  });

  it('пустая история Redis — это «нет данных», а не «сорвано»', () => {
    const verdict = judgeDay(
      evidence({ queues: CYCLE_QUEUES.map((q) => history(q, { oldestSeen: null, runs: [] })) }),
    );
    expect(verdict.status).toBe('no-data');
    expect(
      verdict.checks.filter((c) => c.id.startsWith('cron:')).every((c) => c.status === 'unknown'),
    ).toBe(true);
  });

  it('частичный прогон: два крона из трёх отработали — сутки сорваны', () => {
    const partial = CYCLE_QUEUES.map((q) =>
      q === QUEUE_NAMES.dailyReport ? history(q, { runs: [] }) : history(q),
    );
    const verdict = judgeDay(
      evidence({ queues: partial, db: { ...HEALTHY_DB, dailyReportsSent: 0 } }),
    );
    expect(verdict.status).toBe('failed');
    const cron = verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.dailyReport}`);
    expect(cron?.status).toBe('fail');
    expect(cron?.detail).toContain('0 из 1');
  });

  it('недобор тиков у частого крона тоже срывает сутки', () => {
    const short = CYCLE_QUEUES.map((q) =>
      q === QUEUE_NAMES.fetchStats
        ? history(q, { runs: history(q).runs.slice(0, 20) })
        : history(q),
    );
    const verdict = judgeDay(evidence({ queues: short }));
    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.fetchStats}`)?.detail).toContain(
      '20 из 24',
    );
  });

  it('упавшая задача срывает сутки и называет причину', () => {
    const broken = CYCLE_QUEUES.map((q) => {
      if (q !== QUEUE_NAMES.optimizeBids) return history(q);
      const base = history(q);
      return {
        ...base,
        runs: [
          {
            ...base.runs[0]!,
            state: 'failed' as const,
            result: null,
            failedReason: 'ECONNREFUSED api.direct.yandex.com',
          },
        ],
      };
    });
    const verdict = judgeDay(evidence({ queues: broken }));
    expect(verdict.status).toBe('failed');
    expect(
      verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.optimizeBids}`)?.detail,
    ).toContain('ECONNREFUSED');
  });

  it('холостой прогон на живой базе — срыв, а не успех', () => {
    const idle = CYCLE_QUEUES.map((q) =>
      q === QUEUE_NAMES.fetchStats
        ? history(q, {
            runs: history(q).runs.map((r) => ({
              ...r,
              result: { targets: 0, ok: 0, failures: [] },
            })),
          })
        : history(q),
    );
    const verdict = judgeDay(evidence({ queues: idle }));
    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.fetchStats}`)?.detail).toContain(
      'targets',
    );
  });

  it('отказ внутри сводки виден, даже когда задача завершилась успехом', () => {
    const withFailures = CYCLE_QUEUES.map((q) =>
      q === QUEUE_NAMES.fetchStats
        ? history(q, {
            runs: history(q).runs.map((r, i) =>
              i === 3 ? { ...r, result: { targets: 2, ok: 1, failures: [{ code: 'AUTH' }] } } : r,
            ),
          })
        : history(q),
    );
    const verdict = judgeDay(evidence({ queues: withFailures }));
    expect(verdict.status).toBe('failed');
  });

  it('строки в ErrorLog срывают сутки', () => {
    const verdict = judgeDay(
      evidence({ db: { ...HEALTHY_DB, errors: 4, errorSample: ['ingestion: 401'] } }),
    );
    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((c) => c.id === 'db:errors')?.detail).toContain('401');
  });

  it('ручной запуск CLI внутри суток срывает их', () => {
    const verdict = judgeDay(
      evidence({ db: { ...HEALTHY_DB, manualTouches: ['cli:credentials · credential.save'] } }),
    );
    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((c) => c.id === 'db:manual')?.detail).toContain('cli:credentials');
  });

  it('нажатие апрува человеком — штатный ход, а не вмешательство', () => {
    const verdict = judgeDay(evidence({ db: { ...HEALTHY_DB, humanApprovals: 3 } }));
    expect(verdict.status).toBe('passed');
    expect(verdict.notes.join(' ')).toContain('3');
  });

  it('незарегистрированное расписание срывает сутки', () => {
    const unscheduled = CYCLE_QUEUES.map((q) =>
      q === QUEUE_NAMES.alertScan ? history(q, { scheduled: false }) : history(q),
    );
    const verdict = judgeDay(evidence({ queues: unscheduled }));
    expect(verdict.status).toBe('failed');
  });

  it('нет ни расписания, ни истории — воркер здесь не работал, а не сорвался', () => {
    const fresh = CYCLE_QUEUES.map((q) =>
      history(q, { scheduled: false, oldestSeen: null, runs: [] }),
    );
    const verdict = judgeDay(evidence({ queues: fresh }));
    expect(verdict.status).toBe('no-data');
    expect(verdict.checks.find((c) => c.id === `cron:${QUEUE_NAMES.alertScan}`)?.detail).toContain(
      'воркер здесь ещё не работал',
    );
  });

  it('прогон, отложенный наложением, не засчитывается за тик', () => {
    const overlapped = CYCLE_QUEUES.map((q) => {
      if (q !== QUEUE_NAMES.fetchStats) return history(q);
      const base = history(q);
      return {
        ...base,
        runs: base.runs.map((r, i) =>
          i === 5 ? { ...r, result: { skipped: true, reason: 'already running' } } : r,
        ),
      };
    });
    const verdict = judgeDay(evidence({ queues: overlapped }));
    expect(verdict.status).toBe('failed');
    expect(verdict.notes.join(' ')).toContain('наложени');
  });

  it('отчёт за сутки не ушёл ни одному клиенту — сутки сорваны', () => {
    const verdict = judgeDay(evidence({ db: { ...HEALTHY_DB, dailyReportsSent: 0 } }));
    expect(verdict.status).toBe('failed');
    expect(verdict.checks.find((c) => c.id === 'db:report')?.status).toBe('fail');
  });
});

describe('judgeCycle', () => {
  it('трое здоровых суток закрывают пункт', () => {
    const days = ['2026-08-19', '2026-08-20', '2026-08-21'].map((date) =>
      judgeDay(evidence({ date })),
    );
    const cycle = judgeCycle(days, 3);
    expect(cycle.status).toBe('passed');
    expect(cycle.passed).toBe(3);
  });

  it('одни сорванные сутки обнуляют серию', () => {
    const days = [
      judgeDay(evidence({ date: '2026-08-19' })),
      judgeDay(evidence({ date: '2026-08-20', db: { ...HEALTHY_DB, errors: 1 } })),
      judgeDay(evidence({ date: '2026-08-21' })),
    ];
    const cycle = judgeCycle(days, 3);
    expect(cycle.status).toBe('failed');
    expect(cycle.passed).toBe(2);
  });

  it('нехватка суток — это «нет данных», а не «пройдено»', () => {
    const cycle = judgeCycle([judgeDay(evidence())], 3);
    expect(cycle.status).toBe('no-data');
  });
});

describe('cycleWindow', () => {
  it('окно кончается вчерашними сутками по МСК', () => {
    // 22 августа, 00:30 МСК — вчера ещё 21-е, а не 20-е.
    const window = cycleWindow(3, new Date('2026-08-21T21:30:00.000Z'));
    expect(window).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
  });
});

/** Что вернут обработчики, если базу подняли, но клиентов в неё не завели. */
function emptyBaseSummary(queue: QueueName): Record<string, unknown> {
  switch (queue) {
    case QUEUE_NAMES.fetchStats:
    case QUEUE_NAMES.checkModeration:
      return { targets: 0, ok: 0, failures: [] };
    case QUEUE_NAMES.optimizeBids:
    case QUEUE_NAMES.pauseLosers:
      return {
        campaigns: 0,
        failed: 0,
        applyFailed: 0,
        approvalsFailed: 0,
        approvalsUndelivered: 0,
        localStateFailed: 0,
      };
    case QUEUE_NAMES.dailyReport:
      return { clients: 0, sent: 0, skipped: 0, failures: [] };
    case QUEUE_NAMES.refreshTokens:
      return { checked: 0, refreshed: 0, failures: [] };
    default:
      return SUMMARY[queue];
  }
}
