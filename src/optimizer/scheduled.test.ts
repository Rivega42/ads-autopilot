import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalAction } from '@/approval/types.js';

interface CampaignRow {
  id: string;
  name: string;
  clientId: string;
  provider: 'YANDEX_DIRECT';
  externalId: string | null;
}

interface SearchQueryRow {
  adGroupId: string;
  query: string;
  date: Date;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}

interface NegatedUpdate {
  where: { adGroup: { campaignId: string }; query: { in: string[] }; negated: boolean };
  data: { negated: boolean };
}

const CAMPAIGN: CampaignRow = {
  id: 'c-1',
  name: 'Ремонт квартир',
  clientId: 'cl-1',
  provider: 'YANDEX_DIRECT',
  externalId: '777',
};

const h = vi.hoisted(() => {
  const state: {
    campaigns: unknown[];
    searchQueries: unknown[];
    brief: { data: unknown } | null;
    negated: unknown[];
    reservations: Set<string>;
  } = {
    campaigns: [],
    searchQueries: [],
    brief: null,
    negated: [],
    reservations: new Set<string>(),
  };

  return {
    state,
    createApproval: vi.fn(async (action: ApprovalAction) => ({ id: `ap-${action.kind}` })),
    runOptimizer: vi.fn(),
    applyDecisions: vi.fn(),
    prisma: {
      campaign: { findMany: vi.fn(async () => state.campaigns) },
      clientBrief: { findUnique: vi.fn(async () => state.brief) },
      searchQueryStat: {
        findMany: vi.fn(async () => state.searchQueries),
        updateMany: vi.fn(async (args: unknown) => {
          state.negated.push(args);
          return { count: 1 };
        }),
      },
      adGroup: { findMany: vi.fn(async () => []) },
      ad: { findMany: vi.fn(async () => []) },
      keyword: { findMany: vi.fn() },
    },
    runtime: {
      createApplyDb: vi.fn(() => ({})),
      createPlatformWriter: vi.fn(() => vi.fn()),
      createPrismaIdempotencyStore: vi.fn(() => ({
        reserve: vi.fn(async (key: string) => {
          if (state.reservations.has(key)) return 'duplicate';
          state.reservations.add(key);
          return 'reserved';
        }),
        release: vi.fn(async (key: string) => {
          state.reservations.delete(key);
        }),
      })),
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/approval/index.js', () => ({ createApproval: h.createApproval }));
vi.mock('./runtime.js', () => h.runtime);
vi.mock('./engine.js', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, runOptimizer: h.runOptimizer };
});
vi.mock('./apply.js', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, applyDecisions: h.applyDecisions };
});

const { runScheduledOptimization, approvalIdempotencyKey, readTargetCpaRub } =
  await import('./scheduled.js');
const { buildRunId } = await import('./engine.js');

const NOW = new Date('2026-08-16T00:00:00Z');
const RUN_ID = buildRunId('c-1', NOW);

interface DecisionLike {
  action: string;
  entityType: string;
  entityId: string;
  label?: string | null;
  prevValue: Record<string, unknown>;
  nextValue: Record<string, unknown>;
  reason: string;
  requiresApproval: boolean;
  layer: string;
  ruleId: string | null;
  approvalKind: string | null;
}

function pause(id: string): DecisionLike {
  return {
    action: 'PAUSE',
    entityType: 'KEYWORD',
    entityId: id,
    label: `фраза ${id}`,
    prevValue: { kind: 'status', status: 'ACTIVE' },
    nextValue: { kind: 'status', status: 'PAUSED' },
    reason: 'Пауза: 0 конверсий',
    requiresApproval: true,
    layer: 'rule',
    ruleId: 'pause-high-cpa',
    approvalKind: 'IMPORT_HANDOVER',
  };
}

function negative(phrase: string): DecisionLike {
  return {
    action: 'ADD_NEGATIVE_KEYWORD',
    entityType: 'ADGROUP',
    entityId: 'ag-1',
    label: `«${phrase}»`,
    prevValue: { kind: 'absent' },
    nextValue: { kind: 'negativeKeyword', phrase },
    reason: `Минус-слово «${phrase}»`,
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'add-negative-keyword',
    approvalKind: null,
  };
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: 'c-1',
    runId: RUN_ID,
    windowStart: NOW,
    windowEnd: NOW,
    dryRun: false,
    targets: { campaignId: 'c-1', targetCpa: 500, dailyBudget: 5000, dailySpend: 1000 },
    targetCpaSource: 'campaign',
    proposed: [],
    allowed: [],
    clamped: [],
    rejected: [],
    autoApply: [],
    approvals: [],
    skipped: null,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN_ID,
    campaignId: 'c-1',
    dryRun: false,
    applied: [],
    noop: [],
    skipped: [],
    failed: [],
    planned: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.campaigns = [CAMPAIGN];
  h.state.searchQueries = [];
  h.state.brief = null;
  h.state.negated = [];
  h.state.reservations = new Set<string>();
  h.runOptimizer.mockResolvedValue(run());
  h.applyDecisions.mockResolvedValue(report());
  // Реализацию возвращаем каждый раз: clearAllMocks чистит вызовы, но не поведение,
  // и mockResolvedValue из одного теста иначе протекает в следующий.
  h.prisma.keyword.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, externalId: `ext-${id}` })),
  );
});

describe('runScheduledOptimization: IMPORT_HANDOVER', () => {
  it('sends the OBSERVER batch to the human instead of dropping it', async () => {
    const decisions = [
      ...Array.from({ length: 11 }, (_unused, i) => pause(`kw-${i}`)),
      negative('скачать бесплатно'),
    ];
    h.runOptimizer.mockResolvedValue(
      run({
        approvals: [
          { kind: 'IMPORT_HANDOVER', decisions, summary: 'Режим передачи управления' },
        ],
      }),
    );

    const summary = await runScheduledOptimization({ dryRun: false, now: NOW });

    // Одна заявка режима передачи управления — две карточки: пауза и минус-слова.
    expect(h.createApproval).toHaveBeenCalledTimes(2);
    expect(summary.approvals).toBe(2);
    expect(summary.approvalsFailed).toBe(0);
    const kinds = h.createApproval.mock.calls.map(([action]) => action.kind);
    expect(kinds).toEqual(['pause_entities', 'add_negatives']);
  });

  it('shows the phrase rather than the internal cuid on the card', async () => {
    h.runOptimizer.mockResolvedValue(
      run({
        approvals: [
          {
            kind: 'IMPORT_HANDOVER',
            decisions: [pause('clx8f2k9a0001qz')],
            summary: 'Режим передачи управления',
          },
        ],
      }),
    );

    await runScheduledOptimization({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action?.reason).toContain('фраза clx8f2k9a0001qz');
    expect(action?.reason).not.toMatch(/KEYWORD clx8f2k9a0001qz/);
  });

  it('counts an unbuildable request instead of reporting success', async () => {
    h.prisma.keyword.findMany.mockImplementation(async () => []);
    h.runOptimizer.mockResolvedValue(
      run({ approvals: [{ kind: 'IMPORT_HANDOVER', decisions: [pause('kw-1')], summary: 'x' }] }),
    );

    const summary = await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(h.createApproval).not.toHaveBeenCalled();
    expect(summary.approvalsFailed).toBe(1);
  });
});

describe('runScheduledOptimization: approval idempotency', () => {
  it('does not post a second card when BullMQ retries the job', async () => {
    h.runOptimizer.mockResolvedValue(
      run({ approvals: [{ kind: 'MASS_PAUSE', decisions: [pause('kw-1')], summary: 'x' }] }),
    );

    const first = await runScheduledOptimization({ dryRun: false, now: NOW });
    const second = await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(first.approvals).toBe(1);
    expect(second.approvals).toBe(0);
    expect(second.approvalsDuplicate).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);
  });

  it('frees the key when the card could not be created, so the retry can try again', async () => {
    h.runOptimizer.mockResolvedValue(
      run({ approvals: [{ kind: 'MASS_PAUSE', decisions: [pause('kw-1')], summary: 'x' }] }),
    );
    h.createApproval.mockRejectedValueOnce(new Error('telegram down'));

    const first = await runScheduledOptimization({ dryRun: false, now: NOW });
    const second = await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(first.approvalsFailed).toBe(1);
    expect(second.approvals).toBe(1);
  });

  it('derives the same key from the same run and action', () => {
    const action: ApprovalAction = {
      kind: 'pause_entities',
      clientId: 'cl-1',
      channel: 'YANDEX_DIRECT',
      reason: 'причина',
      level: 'keyword',
      externalIds: ['ext-kw-1'],
    };
    expect(approvalIdempotencyKey(RUN_ID, action)).toBe(approvalIdempotencyKey(RUN_ID, action));
    expect(approvalIdempotencyKey(RUN_ID, action)).not.toBe(
      approvalIdempotencyKey('opt:c-1:2026-08-17', action),
    );
  });
});

describe('runScheduledOptimization: negative keywords', () => {
  const applied = (phrase: string): Record<string, unknown> => ({
    decision: negative(phrase),
    changeLogId: 'cl-1',
    idempotencyKey: 'k',
  });

  it('marks an applied phrase so tomorrow does not re-send it', async () => {
    h.applyDecisions.mockResolvedValue(report({ applied: [applied('скачать бесплатно')] }));

    await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(h.state.negated).toEqual([
      {
        where: {
          adGroup: { campaignId: 'c-1' },
          query: { in: ['скачать бесплатно'] },
          negated: false,
        },
        data: { negated: true },
      } satisfies NegatedUpdate,
    ]);
  });

  it('marks a phrase the platform already had, which is the case that burned units', async () => {
    h.applyDecisions.mockResolvedValue(
      report({ noop: [{ decision: negative('даром'), reason: 'площадке нечего было менять' }] }),
    );

    const summary = await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(summary.noop).toBe(1);
    expect(summary.autoApply).toBe(0);
    expect(h.state.negated).toHaveLength(1);
  });

  it('marks nothing in dry-run', async () => {
    h.applyDecisions.mockResolvedValue(report({ planned: [negative('даром')] }));

    await runScheduledOptimization({ dryRun: true, now: NOW });

    expect(h.prisma.searchQueryStat.updateMany).not.toHaveBeenCalled();
  });

  it('aggregates search queries campaign-wide, matching the campaign-level write', async () => {
    const day = (n: number): Date => new Date(`2026-08-1${n}T00:00:00Z`);
    const rows: SearchQueryRow[] = [
      // Одна фраза в двух группах: слив в первой, конверсии во второй.
      { adGroupId: 'ag-1', query: 'ремонт', date: day(4), impressions: 1000, clicks: 4, spend: 900, conversions: 0 },
      { adGroupId: 'ag-2', query: 'ремонт', date: day(4), impressions: 1000, clicks: 6, spend: 100, conversions: 3 },
      { adGroupId: 'ag-2', query: 'ремонт', date: day(5), impressions: 500, clicks: 2, spend: 50, conversions: 1 },
    ];
    h.state.searchQueries = rows;

    await runScheduledOptimization({ dryRun: false, now: NOW });

    const [, options] = h.runOptimizer.mock.calls[0] ?? [];
    const queries = (options as { searchQueries: unknown[] }).searchQueries;
    expect(queries).toEqual([
      {
        // Адрес — группа с наибольшим расходом; метрики сложены по всей кампании.
        adGroupId: 'ag-1',
        query: 'ремонт',
        impressions: 2500,
        clicks: 12,
        spend: 1050,
        conversions: 4,
        // Две разные даты в трёх строках — два дня, а не три.
        days: 2,
      },
    ]);
  });
});

describe('runScheduledOptimization: target CPA', () => {
  it('feeds the brief target to an imported campaign that has none of its own', async () => {
    h.state.brief = { data: { targetCpaRub: 1500 } };

    await runScheduledOptimization({ dryRun: false, now: NOW });

    const [, options] = h.runOptimizer.mock.calls[0] ?? [];
    expect(options).toMatchObject({ fallbackTargetCpa: 1500 });
  });

  it('reads the brief once per client, not once per campaign', async () => {
    h.state.campaigns = [CAMPAIGN, { ...CAMPAIGN, id: 'c-2' }];
    h.state.brief = { data: { targetCpaRub: 1500 } };

    await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(h.prisma.clientBrief.findUnique).toHaveBeenCalledTimes(1);
  });

  it('counts a campaign left without any target instead of failing silently', async () => {
    h.runOptimizer.mockResolvedValue(run({ targetCpaSource: null }));

    const summary = await runScheduledOptimization({ dryRun: false, now: NOW });

    expect(summary.noTargetCpa).toBe(1);
  });

  it('ignores a brief without a usable number', async () => {
    h.state.brief = { data: { targetCpaRub: 0 } };
    expect(readTargetCpaRub({ targetCpaRub: 0 })).toBeNull();
    expect(readTargetCpaRub({ targetCpaRub: '2000' })).toBeNull();
    expect(readTargetCpaRub(null)).toBeNull();

    await runScheduledOptimization({ dryRun: false, now: NOW });

    const [, options] = h.runOptimizer.mock.calls[0] ?? [];
    expect(options).toMatchObject({ fallbackTargetCpa: null });
  });
});
