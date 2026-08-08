import { describe, expect, it } from 'vitest';

import {
  applyGuardrails,
  DEFAULT_GUARDRAILS,
  observationKey,
  type GuardrailConfig,
  type GuardrailContext,
  type ObservationCounts,
} from './guardrails.js';
import { runMvpRules } from './rules.js';
import type { Decision, DecisionValue, EntityMetrics, OptimizationTargets, SearchQueryMetrics } from './types.js';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'BID_DECREASE',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    prevValue: { kind: 'bid', amount: 100 },
    nextValue: { kind: 'bid', amount: 90 },
    reason: 'тест',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'test',
    approvalKind: null,
    ...overrides,
  };
}

function context(
  overrides: Partial<GuardrailContext> = {},
  observations: ReadonlyArray<[string, ObservationCounts]> = [['KEYWORD:kw-1', { impressions: 1000, days: 7 }]],
): GuardrailContext {
  return {
    dailyBudget: 5000,
    observations: new Map(observations),
    ...overrides,
  };
}

function config(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return { ...DEFAULT_GUARDRAILS, ...overrides };
}

function bidAmount(value: DecisionValue): number | null {
  return value.kind === 'bid' ? value.amount : null;
}

describe('observationKey', () => {
  it('keys negative keywords by phrase, not only by ad group', () => {
    const first = observationKey(
      decision({ entityType: 'ADGROUP', entityId: 'ag-1', nextValue: { kind: 'negativeKeyword', phrase: 'a' } }),
    );
    const second = observationKey(
      decision({ entityType: 'ADGROUP', entityId: 'ag-1', nextValue: { kind: 'negativeKeyword', phrase: 'b' } }),
    );
    expect(first).not.toBe(second);
  });
});

describe('max bid change per day', () => {
  const cases: ReadonlyArray<{ name: string; next: number; clamped: boolean; expected: number }> = [
    { name: 'decrease just inside the limit', next: 70.5, clamped: false, expected: 70.5 },
    { name: 'decrease exactly at the limit', next: 70, clamped: false, expected: 70 },
    { name: 'decrease just past the limit', next: 69.99, clamped: true, expected: 70 },
    { name: 'increase just inside the limit', next: 129.5, clamped: false, expected: 129.5 },
    { name: 'increase exactly at the limit', next: 130, clamped: false, expected: 130 },
    { name: 'increase just past the limit', next: 130.01, clamped: true, expected: 130 },
    { name: 'absurd increase from an ML outlier', next: 100000, clamped: true, expected: 130 },
    { name: 'bid driven to zero', next: 0, clamped: true, expected: 70 },
  ];

  it.each(cases)('$name', ({ next, clamped, expected }) => {
    const outcome = applyGuardrails(
      [decision({ nextValue: { kind: 'bid', amount: next } })],
      context(),
    );
    expect(outcome.rejected).toEqual([]);
    expect(bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(expected);
    expect(outcome.clamped).toHaveLength(clamped ? 1 : 0);
  });

  it('annotates the reason so the clamp is visible in Telegram', () => {
    const outcome = applyGuardrails(
      [decision({ nextValue: { kind: 'bid', amount: 500 } })],
      context(),
    );
    expect(outcome.allowed[0]?.reason).toContain('ограничено guardrail');
    expect(outcome.clamped[0]?.rail).toBe('MAX_BID_CHANGE');
  });

  it('leaves the original decision untouched for the audit trail', () => {
    const original = decision({ nextValue: { kind: 'bid', amount: 500 } });
    const outcome = applyGuardrails([original], context());
    expect(original.nextValue).toEqual({ kind: 'bid', amount: 500 });
    expect(outcome.clamped[0]?.original).toBe(original);
  });

  it.each([0, -5])('rejects a bid change from an unusable previous bid of %s', (amount) => {
    const outcome = applyGuardrails(
      [decision({ prevValue: { kind: 'bid', amount }, nextValue: { kind: 'bid', amount: 10 } })],
      context(),
    );
    expect(outcome.allowed).toEqual([]);
    expect(outcome.rejected[0]?.rail).toBe('UNUSABLE_PREVIOUS_VALUE');
  });

  it('rejects a bid change whose previous value is not a bid at all', () => {
    const outcome = applyGuardrails(
      [decision({ prevValue: { kind: 'absent' }, nextValue: { kind: 'bid', amount: 10 } })],
      context(),
    );
    expect(outcome.rejected[0]?.rail).toBe('UNUSABLE_PREVIOUS_VALUE');
  });

  it('honours a stricter configured limit', () => {
    const outcome = applyGuardrails(
      [decision({ nextValue: { kind: 'bid', amount: 85 } })],
      context(),
      config({ maxBidChangePct: 0.1 }),
    );
    expect(bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(90);
  });
});

describe('daily budget ceiling', () => {
  const budgetDecision = (amount: number): Decision =>
    decision({
      action: 'BUDGET_CHANGE',
      entityType: 'CAMPAIGN',
      entityId: 'c-1',
      prevValue: { kind: 'budget', amount: 5000 },
      nextValue: { kind: 'budget', amount },
    });

  const observations: ReadonlyArray<[string, ObservationCounts]> = [
    ['CAMPAIGN:c-1', { impressions: 10000, days: 7 }],
  ];

  const cases: ReadonlyArray<{ name: string; next: number; clamped: boolean; expected: number }> = [
    { name: 'just below the ceiling', next: 5999.99, clamped: false, expected: 5999.99 },
    { name: 'exactly at the ceiling', next: 6000, clamped: false, expected: 6000 },
    { name: 'just above the ceiling', next: 6000.01, clamped: true, expected: 6000 },
    { name: 'far above the ceiling', next: 90000, clamped: true, expected: 6000 },
    { name: 'a decrease is never blocked', next: 1, clamped: false, expected: 1 },
  ];

  it.each(cases)('$name', ({ next, clamped, expected }) => {
    const outcome = applyGuardrails([budgetDecision(next)], context({}, observations));
    expect(outcome.rejected).toEqual([]);
    const allowed = outcome.allowed[0]?.nextValue;
    expect(allowed?.kind === 'budget' ? allowed.amount : null).toBe(expected);
    expect(outcome.clamped).toHaveLength(clamped ? 1 : 0);
  });

  it('reports the ceiling it clamped to', () => {
    const outcome = applyGuardrails([budgetDecision(99999)], context({}, observations));
    expect(outcome.clamped[0]?.rail).toBe('BUDGET_CEILING');
    expect(outcome.clamped[0]?.note).toContain('6000.00');
  });
});

describe('minimum observations floor', () => {
  it('rejects when the entity has no statistics at all', () => {
    const outcome = applyGuardrails([decision()], context({}, []));
    expect(outcome.allowed).toEqual([]);
    expect(outcome.rejected[0]?.rail).toBe('MIN_OBSERVATIONS');
  });

  const cases: ReadonlyArray<{ name: string; counts: ObservationCounts; allowed: boolean }> = [
    { name: 'impressions just below the floor', counts: { impressions: 99, days: 7 }, allowed: false },
    { name: 'impressions exactly at the floor', counts: { impressions: 100, days: 7 }, allowed: true },
    { name: 'impressions just above the floor', counts: { impressions: 101, days: 7 }, allowed: true },
    { name: 'days just below the floor', counts: { impressions: 5000, days: 2 }, allowed: false },
    { name: 'days exactly at the floor', counts: { impressions: 5000, days: 3 }, allowed: true },
    { name: 'zero impressions and zero days', counts: { impressions: 0, days: 0 }, allowed: false },
  ];

  it.each(cases)('$name', ({ counts, allowed }) => {
    const outcome = applyGuardrails([decision()], context({}, [['KEYWORD:kw-1', counts]]));
    expect(outcome.allowed).toHaveLength(allowed ? 1 : 0);
    expect(outcome.rejected).toHaveLength(allowed ? 0 : 1);
  });

  it('is checked before the value limits, so thin data is never merely clamped', () => {
    const outcome = applyGuardrails(
      [decision({ nextValue: { kind: 'bid', amount: 100000 } })],
      context({}, [['KEYWORD:kw-1', { impressions: 1, days: 1 }]]),
    );
    expect(outcome.clamped).toEqual([]);
    expect(outcome.rejected[0]?.rail).toBe('MIN_OBSERVATIONS');
  });
});

describe('share of entities changed per run', () => {
  const many = (count: number): Decision[] =>
    Array.from({ length: count }, (_unused, index) =>
      decision({ entityId: `kw-${index}`, action: 'PAUSE', prevValue: { kind: 'status', status: 'ACTIVE' }, nextValue: { kind: 'status', status: 'PAUSED' } }),
    );

  const observationsFor = (count: number): ReadonlyArray<[string, ObservationCounts]> =>
    Array.from({ length: count }, (_unused, index) => [
      `KEYWORD:kw-${index}`,
      { impressions: 1000, days: 7 } satisfies ObservationCounts,
    ]);

  it('lets through at most the configured share of the population', () => {
    const outcome = applyGuardrails(
      many(50),
      context({ eligibleEntityCount: 100 }, observationsFor(50)),
    );
    expect(outcome.allowed).toHaveLength(30);
    expect(outcome.rejected).toHaveLength(20);
    expect(outcome.rejected[0]?.rail).toBe('MAX_CHANGED_ENTITY_SHARE');
  });

  it('keeps the earliest decisions, which are the most protective ones', () => {
    const outcome = applyGuardrails(
      many(5),
      context({ eligibleEntityCount: 10 }, observationsFor(5)),
    );
    expect(outcome.allowed.map((d) => d.entityId)).toEqual(['kw-0', 'kw-1', 'kw-2']);
  });

  it('always allows at least one entity, so small accounts are not frozen', () => {
    const outcome = applyGuardrails(
      many(3),
      context({ eligibleEntityCount: 3 }, observationsFor(3)),
    );
    expect(outcome.allowed).toHaveLength(1);
  });

  it('counts entities, not decisions: several changes to one entity cost one slot', () => {
    const outcome = applyGuardrails(
      [
        decision({ entityId: 'kw-0' }),
        decision({ entityId: 'kw-0', action: 'PAUSE', prevValue: { kind: 'status', status: 'ACTIVE' }, nextValue: { kind: 'status', status: 'PAUSED' } }),
        decision({ entityId: 'kw-1' }),
      ],
      context({ eligibleEntityCount: 4 }, observationsFor(2)),
    );
    expect(outcome.allowed).toHaveLength(2);
    expect(outcome.rejected[0]?.decision.entityId).toBe('kw-1');
  });

  it('is disabled when the population is unknown', () => {
    const outcome = applyGuardrails(many(50), context({}, observationsFor(50)));
    expect(outcome.allowed).toHaveLength(50);
  });
});

describe('dry-run switch', () => {
  it('is reported on the outcome so no caller can write by accident', () => {
    const outcome = applyGuardrails([decision()], context(), config({ dryRun: true }));
    expect(outcome.dryRun).toBe(true);
    expect(outcome.allowed).toHaveLength(1);
  });

  it('defaults to off', () => {
    expect(DEFAULT_GUARDRAILS.dryRun).toBe(false);
    expect(applyGuardrails([decision()], context()).dryRun).toBe(false);
  });
});

describe('property: no rule output escapes the guardrails', () => {
  // Deterministic LCG instead of a property-testing dependency: reproducible failures matter more
  // than shrinking here, and the module must stay dependency-free.
  function createRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  function buildCase(random: () => number): {
    entities: EntityMetrics[];
    searchQueries: SearchQueryMetrics[];
    targets: OptimizationTargets;
  } {
    const entityCount = 1 + Math.floor(random() * 6);
    const entities: EntityMetrics[] = Array.from({ length: entityCount }, (_unused, index) => ({
      entityType: random() < 0.75 ? 'KEYWORD' : 'AD',
      entityId: `kw-${index}`,
      label: null,
      impressions: Math.floor(random() * 3000),
      clicks: Math.floor(random() * 300),
      spend: Math.round(random() * 20000) / 100,
      conversions: Math.floor(random() * 5),
      days: Math.floor(random() * 10),
      currentBid: random() < 0.15 ? null : Math.round(random() * 50000) / 100,
    }));

    const searchQueries: SearchQueryMetrics[] = Array.from(
      { length: Math.floor(random() * 4) },
      (_unused, index) => ({
        adGroupId: `ag-${index}`,
        query: `запрос ${index}`,
        impressions: Math.floor(random() * 5000),
        clicks: Math.floor(random() * 40),
        spend: Math.round(random() * 5000) / 100,
        conversions: 0,
        days: Math.floor(random() * 10),
      }),
    );

    const dailyBudget = Math.round(random() * 1000000) / 100;

    return {
      entities,
      searchQueries,
      targets: {
        campaignId: 'c-1',
        targetCpa: random() < 0.2 ? null : Math.round(random() * 200000) / 100,
        dailyBudget,
        dailySpend: Math.round(random() * dailyBudget * 100) / 100,
        handoverMode: 'FULL',
      },
    };
  }

  it('holds over 500 pseudo-random accounts', () => {
    const random = createRandom(20260808);
    const settings = config();
    const seen = { proposed: 0, allowed: 0, clamped: 0, rejected: 0 };

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const scenario = buildCase(random);
      const decisions = runMvpRules(
        { entities: scenario.entities, searchQueries: scenario.searchQueries },
        scenario.targets,
      );

      const observations = new Map<string, ObservationCounts>();
      for (const entity of scenario.entities) {
        observations.set(`${entity.entityType}:${entity.entityId}`, {
          impressions: entity.impressions,
          days: entity.days,
        });
      }
      for (const searchQuery of scenario.searchQueries) {
        observations.set(`ADGROUP:${searchQuery.adGroupId}:${searchQuery.query}`, {
          impressions: searchQuery.impressions,
          days: searchQuery.days,
        });
      }

      const outcome = applyGuardrails(
        decisions,
        {
          dailyBudget: scenario.targets.dailyBudget,
          observations,
          eligibleEntityCount: scenario.entities.length,
        },
        settings,
      );

      seen.proposed += decisions.length;
      seen.allowed += outcome.allowed.length;
      seen.clamped += outcome.clamped.length;
      seen.rejected += outcome.rejected.length;

      const ceiling = scenario.targets.dailyBudget * settings.budgetCeilingRatio;
      const touched = new Set(outcome.allowed.map((allowed) => allowed.entityId));

      expect(touched.size).toBeLessThanOrEqual(
        Math.max(1, Math.floor(scenario.entities.length * settings.maxChangedEntityShare)),
      );

      for (const allowed of outcome.allowed) {
        const observation = observations.get(observationKey(allowed));
        expect(observation?.impressions ?? 0).toBeGreaterThanOrEqual(settings.minImpressions);
        expect(observation?.days ?? 0).toBeGreaterThanOrEqual(settings.minObservationDays);

        if (allowed.nextValue.kind === 'bid') {
          const previous = allowed.prevValue.kind === 'bid' ? allowed.prevValue.amount : 0;
          expect(previous).toBeGreaterThan(0);
          const change = Math.abs(allowed.nextValue.amount - previous) / previous;
          expect(change).toBeLessThanOrEqual(settings.maxBidChangePct);
          expect(allowed.nextValue.amount).toBeGreaterThan(0);
        }

        if (allowed.nextValue.kind === 'budget') {
          expect(allowed.nextValue.amount).toBeLessThanOrEqual(ceiling);
        }
      }
    }

    // Guards against a vacuous property: the invariants above must have been exercised by real
    // decisions of every outcome class, not by empty batches.
    expect(seen.proposed).toBeGreaterThan(100);
    expect(seen.allowed).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
  });
});
