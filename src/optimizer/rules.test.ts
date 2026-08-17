import { describe, expect, it } from 'vitest';

import {
  addNegativeKeywords,
  decreaseBidOnHighCpa,
  deriveMetrics,
  increaseBidOnLowCpa,
  pauseHighCpaEntities,
  runMvpRules,
  RULE_IDS,
} from './rules.js';
import type { EntityMetrics, OptimizationTargets, RuleInput, SearchQueryMetrics } from './types.js';

function entity(overrides: Partial<EntityMetrics> = {}): EntityMetrics {
  return {
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    label: null,
    impressions: 1000,
    clicks: 50,
    spend: 1000,
    conversions: 1,
    days: 7,
    currentBid: 10,
    status: 'ACTIVE',
    ...overrides,
  };
}

function query(overrides: Partial<SearchQueryMetrics> = {}): SearchQueryMetrics {
  return {
    adGroupId: 'ag-1',
    query: 'скачать бесплатно',
    impressions: 2000,
    clicks: 6,
    spend: 120,
    conversions: 0,
    days: 7,
    ...overrides,
  };
}

function targets(overrides: Partial<OptimizationTargets> = {}): OptimizationTargets {
  return {
    campaignId: 'c-1',
    targetCpa: 500,
    dailyBudget: 5000,
    dailySpend: 1000,
    handoverMode: 'FULL',
    ...overrides,
  };
}

function input(entities: EntityMetrics[], searchQueries: SearchQueryMetrics[] = []): RuleInput {
  return { entities, searchQueries };
}

describe('deriveMetrics', () => {
  it('returns null CTR when there are no impressions', () => {
    expect(deriveMetrics({ impressions: 0, clicks: 0, spend: 0, conversions: 0 }).ctr).toBeNull();
  });

  it('returns null CPC when there are no clicks', () => {
    expect(deriveMetrics({ impressions: 10, clicks: 0, spend: 5, conversions: 0 }).cpc).toBeNull();
  });

  it('returns infinite CPA when money was spent without conversions', () => {
    const { cpa } = deriveMetrics({ impressions: 10, clicks: 5, spend: 500, conversions: 0 });
    expect(cpa).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns null CPA when there is neither spend nor conversions', () => {
    const { cpa } = deriveMetrics({ impressions: 10, clicks: 0, spend: 0, conversions: 0 });
    expect(cpa).toBeNull();
  });

  it('computes plain ratios when all inputs are present', () => {
    const derived = deriveMetrics({ impressions: 1000, clicks: 100, spend: 500, conversions: 5 });
    expect(derived.ctr).toBe(0.1);
    expect(derived.cpc).toBe(5);
    expect(derived.cpa).toBe(100);
  });
});

describe('pauseHighCpaEntities (impressions > 500 AND CPA > 3× target)', () => {
  const cases: ReadonlyArray<{
    name: string;
    metrics: Partial<EntityMetrics>;
    targetCpa?: number | null;
    expected: boolean;
  }> = [
    {
      name: 'impressions just below the threshold',
      metrics: { impressions: 499, spend: 2000 },
      expected: false,
    },
    {
      name: 'impressions exactly at the threshold',
      metrics: { impressions: 500, spend: 2000 },
      expected: false,
    },
    {
      name: 'impressions just above the threshold',
      metrics: { impressions: 501, spend: 2000 },
      expected: true,
    },
    {
      name: 'CPA just below 3× target',
      metrics: { impressions: 600, spend: 1499, conversions: 1 },
      expected: false,
    },
    {
      name: 'CPA exactly 3× target',
      metrics: { impressions: 600, spend: 1500, conversions: 1 },
      expected: false,
    },
    {
      name: 'CPA just above 3× target',
      metrics: { impressions: 600, spend: 1500.01, conversions: 1 },
      expected: true,
    },
    {
      name: 'zero conversions with spend',
      metrics: { impressions: 600, spend: 900, conversions: 0 },
      expected: true,
    },
    {
      name: 'zero conversions and zero spend',
      metrics: { impressions: 600, spend: 0, conversions: 0 },
      expected: false,
    },
    {
      name: 'zero impressions',
      metrics: { impressions: 0, clicks: 0, spend: 900, conversions: 0 },
      expected: false,
    },
    {
      name: 'zero clicks but heavy impressions',
      metrics: { impressions: 900, clicks: 0, spend: 0, conversions: 0 },
      expected: false,
    },
    {
      name: 'missing targetCpa',
      metrics: { impressions: 900, spend: 9000, conversions: 0 },
      targetCpa: null,
      expected: false,
    },
    {
      name: 'zero targetCpa',
      metrics: { impressions: 900, spend: 9000, conversions: 0 },
      targetCpa: 0,
      expected: false,
    },
  ];

  it.each(cases)('$name → $expected', ({ metrics, targetCpa, expected }) => {
    const decisions = pauseHighCpaEntities(
      input([entity(metrics)]),
      targets(targetCpa === undefined ? {} : { targetCpa }),
    );
    expect(decisions).toHaveLength(expected ? 1 : 0);
  });

  it('pauses ads as well as keywords', () => {
    const decisions = pauseHighCpaEntities(
      input([
        entity({
          entityType: 'AD',
          entityId: 'ad-1',
          impressions: 600,
          spend: 5000,
          conversions: 0,
        }),
      ]),
      targets(),
    );
    expect(decisions[0]?.entityType).toBe('AD');
  });

  it.each(['PAUSED', 'ARCHIVED'] as const)('never pauses an already %s entity', (status) => {
    const decisions = pauseHighCpaEntities(
      input([
        entity({
          entityType: 'AD',
          entityId: 'ad-1',
          impressions: 600,
          spend: 5000,
          conversions: 0,
          status,
        }),
      ]),
      targets(),
    );
    expect(decisions).toEqual([]);
  });

  it('пауза предлагается, когда статус неизвестен', () => {
    const decisions = pauseHighCpaEntities(
      input([
        entity({
          entityType: 'AD',
          entityId: 'ad-1',
          impressions: 600,
          spend: 5000,
          conversions: 0,
          status: null,
        }),
      ]),
      targets(),
    );
    expect(decisions).toHaveLength(1);
  });

  it.each(['CAMPAIGN', 'ADGROUP'] as const)('never pauses a whole %s', (entityType) => {
    const decisions = pauseHighCpaEntities(
      input([entity({ entityType, impressions: 5000, spend: 50000, conversions: 0 })]),
      targets(),
    );
    expect(decisions).toEqual([]);
  });

  it('emits a decision the approval layer can consume verbatim', () => {
    const [decision] = pauseHighCpaEntities(
      input([entity({ impressions: 620, spend: 1860, conversions: 1 })]),
      targets(),
    );
    expect(decision).toMatchObject({
      action: 'PAUSE',
      entityType: 'KEYWORD',
      entityId: 'kw-1',
      prevValue: { kind: 'status', status: 'ACTIVE' },
      nextValue: { kind: 'status', status: 'PAUSED' },
      requiresApproval: false,
      layer: 'rule',
      ruleId: RULE_IDS.pauseHighCpa,
      approvalKind: null,
    });
    expect(decision?.reason).toContain('CPA 1860.00');
    expect(decision?.reason).toContain('3.72× цели 500.00');
    expect(decision?.reason).toContain('показов 620');
  });

  it('explains a zero-conversion pause without printing Infinity', () => {
    const [decision] = pauseHighCpaEntities(
      input([entity({ impressions: 620, spend: 1860, conversions: 0 })]),
      targets(),
    );
    expect(decision?.reason).toContain('0 конверсий при расходе 1860.00');
    expect(decision?.reason).not.toContain('Infinity');
  });
});

describe('decreaseBidOnHighCpa (impressions > 200 AND CPA > 1.5× target)', () => {
  const cases: ReadonlyArray<{
    name: string;
    metrics: Partial<EntityMetrics>;
    targetCpa?: number | null;
    expected: boolean;
  }> = [
    {
      name: 'impressions just below the threshold',
      metrics: { impressions: 199, spend: 1000, conversions: 1 },
      expected: false,
    },
    {
      name: 'impressions exactly at the threshold',
      metrics: { impressions: 200, spend: 1000, conversions: 1 },
      expected: false,
    },
    {
      name: 'impressions just above the threshold',
      metrics: { impressions: 201, spend: 1000, conversions: 1 },
      expected: true,
    },
    {
      name: 'CPA just below 1.5× target',
      metrics: { impressions: 300, spend: 749, conversions: 1 },
      expected: false,
    },
    {
      name: 'CPA exactly 1.5× target',
      metrics: { impressions: 300, spend: 750, conversions: 1 },
      expected: false,
    },
    {
      name: 'CPA just above 1.5× target',
      metrics: { impressions: 300, spend: 750.01, conversions: 1 },
      expected: true,
    },
    {
      name: 'zero conversions with spend',
      metrics: { impressions: 300, spend: 400, conversions: 0 },
      expected: true,
    },
    {
      name: 'zero conversions and zero spend',
      metrics: { impressions: 300, spend: 0, conversions: 0 },
      expected: false,
    },
    {
      name: 'zero clicks',
      metrics: { impressions: 300, clicks: 0, spend: 0, conversions: 0 },
      expected: false,
    },
    {
      name: 'missing bid',
      metrics: { impressions: 300, spend: 1000, conversions: 1, currentBid: null },
      expected: false,
    },
    {
      name: 'zero bid',
      metrics: { impressions: 300, spend: 1000, conversions: 1, currentBid: 0 },
      expected: false,
    },
    {
      name: 'bid too small to move by 15%',
      metrics: { impressions: 300, spend: 1000, conversions: 1, currentBid: 0.01 },
      expected: false,
    },
    {
      name: 'non-keyword entity',
      metrics: { entityType: 'AD', impressions: 300, spend: 1000, conversions: 1 },
      expected: false,
    },
    {
      name: 'missing targetCpa',
      metrics: { impressions: 300, spend: 1000, conversions: 1 },
      targetCpa: null,
      expected: false,
    },
  ];

  it.each(cases)('$name → $expected', ({ metrics, targetCpa, expected }) => {
    const decisions = decreaseBidOnHighCpa(
      input([entity(metrics)]),
      targets(targetCpa === undefined ? {} : { targetCpa }),
    );
    expect(decisions).toHaveLength(expected ? 1 : 0);
  });

  it('cuts the bid by exactly 15% and reports both values', () => {
    const [decision] = decreaseBidOnHighCpa(
      input([entity({ impressions: 300, spend: 900, conversions: 1, currentBid: 12 })]),
      targets(),
    );
    expect(decision).toMatchObject({
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: 12 },
      nextValue: { kind: 'bid', amount: 10.2 },
      ruleId: RULE_IDS.decreaseBidHighCpa,
    });
    expect(decision?.reason).toContain('Снижение ставки на 15.00%: 12.00 → 10.20');
  });

  it.each(['PAUSED', 'ARCHIVED'] as const)('не двигает ставку %s фразы', (status) => {
    // Ставка выключенной фразы ничего не решает, но правило предлагало её менять
    // каждую ночь, и апрув реально уезжал в кабинет.
    const decisions = decreaseBidOnHighCpa(
      input([entity({ impressions: 300, spend: 900, conversions: 1, status })]),
      targets(),
    );
    expect(decisions).toEqual([]);
  });

  it('при неизвестном статусе ставку менять можно', () => {
    const decisions = decreaseBidOnHighCpa(
      input([entity({ impressions: 300, spend: 900, conversions: 1, status: null })]),
      targets(),
    );
    expect(decisions).toHaveLength(1);
  });
});

describe('increaseBidOnLowCpa (CPA < 0.7× target AND daily spend < 50% of budget)', () => {
  const cases: ReadonlyArray<{
    name: string;
    metrics: Partial<EntityMetrics>;
    target: Partial<OptimizationTargets>;
    expected: boolean;
  }> = [
    {
      name: 'CPA just below 0.7× target',
      metrics: { spend: 349, conversions: 1 },
      target: {},
      expected: true,
    },
    {
      name: 'CPA exactly 0.7× target',
      metrics: { spend: 350, conversions: 1 },
      target: {},
      expected: false,
    },
    {
      name: 'CPA just above 0.7× target',
      metrics: { spend: 351, conversions: 1 },
      target: {},
      expected: false,
    },
    {
      name: 'daily spend just below half the budget',
      metrics: { spend: 100, conversions: 1 },
      target: { dailySpend: 2499.99 },
      expected: true,
    },
    {
      name: 'daily spend exactly half the budget',
      metrics: { spend: 100, conversions: 1 },
      target: { dailySpend: 2500 },
      expected: false,
    },
    {
      name: 'daily spend just above half the budget',
      metrics: { spend: 100, conversions: 1 },
      target: { dailySpend: 2500.01 },
      expected: false,
    },
    {
      name: 'zero conversions with spend',
      metrics: { spend: 100, conversions: 0 },
      target: {},
      expected: false,
    },
    {
      name: 'zero conversions and zero spend',
      metrics: { spend: 0, conversions: 0 },
      target: {},
      expected: false,
    },
    { name: 'free conversions', metrics: { spend: 0, conversions: 3 }, target: {}, expected: true },
    {
      name: 'missing bid',
      metrics: { spend: 100, conversions: 1, currentBid: null },
      target: {},
      expected: false,
    },
    {
      name: 'missing targetCpa',
      metrics: { spend: 100, conversions: 1 },
      target: { targetCpa: null },
      expected: false,
    },
    {
      name: 'zero daily budget',
      metrics: { spend: 100, conversions: 1 },
      target: { dailyBudget: 0, dailySpend: 0 },
      expected: false,
    },
  ];

  it.each(cases)('$name → $expected', ({ metrics, target, expected }) => {
    const decisions = increaseBidOnLowCpa(input([entity(metrics)]), targets(target));
    expect(decisions).toHaveLength(expected ? 1 : 0);
  });

  it('raises the bid by exactly 10% and reports budget headroom', () => {
    const [decision] = increaseBidOnLowCpa(
      input([entity({ spend: 300, conversions: 1, currentBid: 10 })]),
      targets({ dailySpend: 1200 }),
    );
    expect(decision).toMatchObject({
      action: 'BID_INCREASE',
      prevValue: { kind: 'bid', amount: 10 },
      nextValue: { kind: 'bid', amount: 11 },
      ruleId: RULE_IDS.increaseBidLowCpa,
    });
    expect(decision?.reason).toContain('расход 1200.00 из 5000.00/сут');
  });

  it.each(['PAUSED', 'ARCHIVED'] as const)('не поднимает ставку %s фразе', (status) => {
    const decisions = increaseBidOnLowCpa(
      input([entity({ spend: 300, conversions: 1, currentBid: 10, status })]),
      targets({ dailySpend: 1200 }),
    );
    expect(decisions).toEqual([]);
  });

  it('при неизвестном статусе ставку поднять можно', () => {
    const decisions = increaseBidOnLowCpa(
      input([entity({ spend: 300, conversions: 1, currentBid: 10, status: null })]),
      targets({ dailySpend: 1200 }),
    );
    expect(decisions).toHaveLength(1);
  });
});

describe('addNegativeKeywords (CTR < 0.5% AND clicks > 5)', () => {
  const cases: ReadonlyArray<{
    name: string;
    metrics: Partial<SearchQueryMetrics>;
    expected: boolean;
  }> = [
    {
      name: 'clicks just below the threshold',
      metrics: { clicks: 4, impressions: 5000 },
      expected: false,
    },
    {
      name: 'clicks exactly at the threshold',
      metrics: { clicks: 5, impressions: 5000 },
      expected: false,
    },
    {
      name: 'clicks just above the threshold',
      metrics: { clicks: 6, impressions: 5000 },
      expected: true,
    },
    { name: 'CTR just below 0.5%', metrics: { clicks: 6, impressions: 1201 }, expected: true },
    { name: 'CTR exactly 0.5%', metrics: { clicks: 6, impressions: 1200 }, expected: false },
    { name: 'CTR just above 0.5%', metrics: { clicks: 6, impressions: 1199 }, expected: false },
    { name: 'zero impressions', metrics: { clicks: 6, impressions: 0 }, expected: false },
    { name: 'zero clicks', metrics: { clicks: 0, impressions: 5000 }, expected: false },
  ];

  it.each(cases)('$name → $expected', ({ metrics, expected }) => {
    const decisions = addNegativeKeywords(input([], [query(metrics)]), targets());
    expect(decisions).toHaveLength(expected ? 1 : 0);
  });

  it('fires even without a targetCpa, since it does not depend on CPA', () => {
    const decisions = addNegativeKeywords(input([], [query()]), targets({ targetCpa: null }));
    expect(decisions).toHaveLength(1);
  });

  it('targets the ad group and carries the phrase', () => {
    const [decision] = addNegativeKeywords(
      input([], [query({ impressions: 2000, clicks: 6 })]),
      targets(),
    );
    expect(decision).toMatchObject({
      action: 'ADD_NEGATIVE_KEYWORD',
      entityType: 'ADGROUP',
      entityId: 'ag-1',
      prevValue: { kind: 'absent' },
      nextValue: { kind: 'negativeKeyword', phrase: 'скачать бесплатно' },
      ruleId: RULE_IDS.addNegativeKeyword,
    });
    expect(decision?.reason).toContain('CTR 0.30%');
  });
});

describe('runMvpRules', () => {
  it('is pure: repeated calls on the same input produce identical output', () => {
    const ruleInput = input([entity({ impressions: 600, spend: 5000, conversions: 1 })], [query()]);
    const first = runMvpRules(ruleInput, targets());
    const second = runMvpRules(ruleInput, targets());
    expect(second).toEqual(first);
  });

  it('does not mutate its input', () => {
    const entities = [entity({ impressions: 600, spend: 5000, conversions: 1 })];
    const snapshot = structuredClone(entities);
    runMvpRules(input(entities, [query()]), targets());
    expect(entities).toEqual(snapshot);
  });

  it('emits protective decisions before expansive ones', () => {
    const decisions = runMvpRules(
      input(
        [
          entity({ entityId: 'kw-loser', impressions: 900, spend: 9000, conversions: 1 }),
          entity({ entityId: 'kw-winner', impressions: 900, spend: 100, conversions: 1 }),
        ],
        [query()],
      ),
      targets({ dailySpend: 100 }),
    );
    expect(decisions.map((decision) => decision.action)).toEqual([
      'PAUSE',
      'BID_DECREASE',
      'BID_INCREASE',
      'ADD_NEGATIVE_KEYWORD',
    ]);
  });

  it('returns nothing at all when the campaign has no targetCpa and no search queries', () => {
    const decisions = runMvpRules(
      input([entity({ impressions: 5000, spend: 50000, conversions: 0 })]),
      targets({ targetCpa: null }),
    );
    expect(decisions).toEqual([]);
  });
});
