import { describe, expect, it } from 'vitest';

import {
  approvalKindFor,
  APPROVAL_CHANGE_THRESHOLD_PCT,
  classifyDecisions,
  MASS_PAUSE_THRESHOLD,
  relativeChange,
  type PolicyContext,
} from './policy.js';
import type { Decision, HandoverModeName } from './types.js';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'BID_DECREASE',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    prevValue: { kind: 'bid', amount: 100 },
    nextValue: { kind: 'bid', amount: 85 },
    reason: 'тест',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'test',
    approvalKind: null,
    ...overrides,
  };
}

function pause(entityId: string): Decision {
  return decision({
    action: 'PAUSE',
    entityId,
    prevValue: { kind: 'status', status: 'ACTIVE' },
    nextValue: { kind: 'status', status: 'PAUSED' },
  });
}

function budget(amount: number): Decision {
  return decision({
    action: 'BUDGET_CHANGE',
    entityType: 'CAMPAIGN',
    entityId: 'c-1',
    prevValue: { kind: 'budget', amount: 5000 },
    nextValue: { kind: 'budget', amount },
  });
}

function context(handoverMode: HandoverModeName = 'FULL'): PolicyContext {
  return { handoverMode };
}

describe('relativeChange', () => {
  it('measures bid and budget moves against the previous value', () => {
    expect(relativeChange(decision())).toBeCloseTo(0.15);
    expect(relativeChange(budget(6000))).toBeCloseTo(0.2);
  });

  it('is null when there is no comparable baseline', () => {
    expect(relativeChange(pause('kw-1'))).toBeNull();
    expect(relativeChange(decision({ prevValue: { kind: 'bid', amount: 0 } }))).toBeNull();
    expect(relativeChange(decision({ prevValue: { kind: 'absent' } }))).toBeNull();
  });
});

describe('approval threshold for money changes', () => {
  const cases: ReadonlyArray<{ name: string; next: number; approval: boolean }> = [
    { name: 'just below 20%', next: 5999, approval: false },
    { name: 'exactly 20%', next: 6000, approval: false },
    { name: 'just above 20%', next: 6001, approval: true },
    { name: 'a large cut', next: 3000, approval: true },
    { name: 'a small cut', next: 4900, approval: false },
  ];

  it.each(cases)('budget change $name → approval $approval', ({ next, approval }) => {
    expect(approvalKindFor(budget(next), context(), false)).toBe(approval ? 'BUDGET_CHANGE' : null);
  });

  it('routes an oversized bid change to BID_CHANGE, which builds a card', () => {
    const oversized = decision({ nextValue: { kind: 'bid', amount: 75 } });
    expect(approvalKindFor(oversized, context(), false)).toBe('BID_CHANGE');
  });

  it('auto-applies the MVP bid steps, which sit under the threshold', () => {
    expect(
      approvalKindFor(decision({ nextValue: { kind: 'bid', amount: 85 } }), context(), false),
    ).toBeNull();
    expect(
      approvalKindFor(decision({ nextValue: { kind: 'bid', amount: 110 } }), context(), false),
    ).toBeNull();
  });

  it('demands approval when the baseline is unknown', () => {
    const unmeasurable = decision({ prevValue: { kind: 'bid', amount: 0 } });
    expect(approvalKindFor(unmeasurable, context(), false)).toBe('BID_CHANGE');
  });

  it('keeps the documented threshold at 20%', () => {
    expect(APPROVAL_CHANGE_THRESHOLD_PCT).toBe(0.2);
  });
});

describe('mass pause', () => {
  it.each([
    { count: MASS_PAUSE_THRESHOLD - 1, approvals: 0 },
    { count: MASS_PAUSE_THRESHOLD, approvals: 0 },
    { count: MASS_PAUSE_THRESHOLD + 1, approvals: 1 },
  ])('pausing $count entities produces $approvals approval requests', ({ count, approvals }) => {
    const decisions = Array.from({ length: count }, (_unused, index) => pause(`kw-${index}`));
    const outcome = classifyDecisions(decisions, context());
    expect(outcome.approvals).toHaveLength(approvals);
    expect(outcome.autoApply).toHaveLength(approvals === 0 ? count : 0);
  });

  it('groups every pause into one request with a preview list', () => {
    const decisions = Array.from({ length: 12 }, (_unused, index) => pause(`kw-${index}`));
    const [request] = classifyDecisions(decisions, context()).approvals;
    expect(request?.kind).toBe('MASS_PAUSE');
    expect(request?.decisions).toHaveLength(12);
    expect(request?.summary).toContain('Массовое отключение: 12 сущностей');
    expect(request?.summary).toContain('…и ещё 2');
  });

  it('does not drag unrelated decisions into the mass-pause request', () => {
    const decisions = [
      ...Array.from({ length: 11 }, (_unused, index) => pause(`kw-${index}`)),
      decision({ entityId: 'kw-99' }),
    ];
    const outcome = classifyDecisions(decisions, context());
    expect(outcome.autoApply.map((d) => d.entityId)).toEqual(['kw-99']);
  });
});

describe('action kinds', () => {
  it.each([
    { action: 'NEW_CAMPAIGN' as const, kind: 'NEW_CAMPAIGN' },
    { action: 'STRATEGY_CHANGE' as const, kind: 'STRATEGY_CHANGE' },
  ])('$action always needs $kind approval', ({ action, kind }) => {
    expect(approvalKindFor(decision({ action }), context(), false)).toBe(kind);
  });

  it('auto-applies negative keywords', () => {
    const negative = decision({
      action: 'ADD_NEGATIVE_KEYWORD',
      entityType: 'ADGROUP',
      prevValue: { kind: 'absent' },
      nextValue: { kind: 'negativeKeyword', phrase: 'бесплатно' },
    });
    expect(approvalKindFor(negative, context(), false)).toBeNull();
  });

  it('auto-applies a lone pause', () => {
    expect(approvalKindFor(pause('kw-1'), context(), false)).toBeNull();
  });
});

describe('handover mode', () => {
  it('sends everything to approval in OBSERVER', () => {
    const outcome = classifyDecisions(
      [pause('kw-1'), decision(), budget(5100)],
      context('OBSERVER'),
    );
    expect(outcome.autoApply).toEqual([]);
    expect(outcome.approvals).toHaveLength(1);
    expect(outcome.approvals[0]?.kind).toBe('IMPORT_HANDOVER');
    expect(outcome.approvals[0]?.decisions).toHaveLength(3);
  });

  it('allows only reversible surgery in ASSIST', () => {
    const negative = decision({
      action: 'ADD_NEGATIVE_KEYWORD',
      entityId: 'ag-1',
      entityType: 'ADGROUP',
      prevValue: { kind: 'absent' },
      nextValue: { kind: 'negativeKeyword', phrase: 'бесплатно' },
    });
    const outcome = classifyDecisions(
      [pause('kw-1'), negative, decision(), budget(5100)],
      context('ASSIST'),
    );
    expect(outcome.autoApply.map((d) => d.action)).toEqual(['PAUSE', 'ADD_NEGATIVE_KEYWORD']);
    expect(outcome.approvals[0]?.kind).toBe('IMPORT_HANDOVER');
    expect(outcome.approvals[0]?.decisions.map((d) => d.action)).toEqual([
      'BID_DECREASE',
      'BUDGET_CHANGE',
    ]);
  });

  it('applies the normal policy in FULL', () => {
    const outcome = classifyDecisions([decision(), budget(5100)], context('FULL'));
    expect(outcome.autoApply).toHaveLength(2);
    expect(outcome.approvals).toEqual([]);
  });
});

describe('classifyDecisions bookkeeping', () => {
  it('stamps requiresApproval and approvalKind on the copies it returns', () => {
    const source = budget(9000);
    const outcome = classifyDecisions([source, decision()], context());
    expect(outcome.approvals[0]?.decisions[0]).toMatchObject({
      requiresApproval: true,
      approvalKind: 'BUDGET_CHANGE',
    });
    expect(outcome.autoApply[0]).toMatchObject({ requiresApproval: false, approvalKind: null });
    expect(source.requiresApproval).toBe(false);
  });

  it('never loses or duplicates a decision', () => {
    const decisions = [
      ...Array.from({ length: 11 }, (_unused, index) => pause(`kw-${index}`)),
      budget(9000),
      decision({ action: 'NEW_CAMPAIGN', entityId: 'c-2' }),
      decision({ entityId: 'kw-a' }),
    ];
    const outcome = classifyDecisions(decisions, context());
    const total =
      outcome.autoApply.length +
      outcome.approvals.reduce((sum, request) => sum + request.decisions.length, 0);
    expect(total).toBe(decisions.length);
  });

  it('orders approval requests most-restrictive first', () => {
    const decisions = [
      decision({ action: 'NEW_CAMPAIGN', entityId: 'c-2' }),
      budget(9000),
      ...Array.from({ length: 11 }, (_unused, index) => pause(`kw-${index}`)),
    ];
    const kinds = classifyDecisions(decisions, context()).approvals.map((r) => r.kind);
    expect(kinds).toEqual(['MASS_PAUSE', 'BUDGET_CHANGE', 'NEW_CAMPAIGN']);
  });

  it('puts the numbers a human needs into the budget summary', () => {
    const [request] = classifyDecisions([budget(9000)], context()).approvals;
    expect(request?.summary).toContain('5000.00 → 9000.00');
    expect(request?.summary).toContain('80.00%');
  });

  it('handles an empty batch', () => {
    expect(classifyDecisions([], context())).toEqual({ autoApply: [], approvals: [] });
  });
});
