import { describe, expect, it } from 'vitest';

import { classifyDecisions, type ApprovalRequest } from './policy.js';
import { toApprovalActions, type ApprovalTarget } from './to-approval.js';
import type { Decision } from './types.js';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'PAUSE',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    label: 'купить слона дёшево',
    prevValue: { kind: 'status', status: 'ACTIVE' },
    nextValue: { kind: 'status', status: 'PAUSED' },
    reason: 'Пауза: 0 конверсий при расходе 4 500.00',
    requiresApproval: true,
    layer: 'rule',
    ruleId: 'pause-high-cpa',
    approvalKind: 'MASS_PAUSE',
    ...overrides,
  };
}

function request(kind: ApprovalRequest['kind'], decisions: Decision[]): ApprovalRequest {
  return { kind, decisions, summary: 'сводка' };
}

function target(overrides: Partial<ApprovalTarget> = {}): ApprovalTarget {
  return {
    clientId: 'cl-1',
    channel: 'YANDEX_DIRECT',
    campaignExternalId: '777',
    campaignName: 'Ремонт квартир',
    externalIdOf: (entityId) => `ext-${entityId}`,
    ...overrides,
  };
}

describe('toApprovalActions: MASS_PAUSE', () => {
  it('splits a wave that mixes keywords and ads into one card per level', () => {
    const decisions = [
      ...Array.from({ length: 8 }, (_unused, i) => decision({ entityId: `kw-${i}` })),
      ...Array.from({ length: 4 }, (_unused, i) =>
        decision({ entityId: `ad-${i}`, entityType: 'AD' }),
      ),
    ];

    const actions = toApprovalActions(request('MASS_PAUSE', decisions), target());

    expect(actions).toHaveLength(2);
    expect(actions.map((a) => a.kind)).toEqual(['pause_entities', 'pause_entities']);
    const [ads, keywords] = actions;
    // Порядок уровней фиксирован: campaign → adgroup → ad → keyword.
    expect(ads).toMatchObject({ level: 'ad' });
    expect(keywords).toMatchObject({ level: 'keyword' });
    if (ads?.kind !== 'pause_entities' || keywords?.kind !== 'pause_entities') {
      throw new Error('ожидались карточки отключения');
    }
    expect(ads.externalIds).toHaveLength(4);
    expect(keywords.externalIds).toHaveLength(8);
  });

  it('keeps the card text in step with the ids that actually resolved', () => {
    const decisions = [
      decision({ entityId: 'kw-1' }),
      decision({ entityId: 'kw-2' }),
      decision({ entityId: 'kw-3' }),
    ];
    const [action] = toApprovalActions(
      request('MASS_PAUSE', decisions),
      target({ externalIdOf: (id) => (id === 'kw-3' ? null : `ext-${id}`) }),
    );

    if (action?.kind !== 'pause_entities') throw new Error('ожидалась карточка отключения');
    expect(action.externalIds).toEqual(['ext-kw-1', 'ext-kw-2']);
    // «Отключить 2 фразы» не должно соседствовать со списком из трёх причин.
    expect(action.reason).toContain('2 сущностей');
    expect(action.reason).not.toContain('3 сущностей');
  });

  it('names the phrase instead of the internal cuid', () => {
    const [action] = toApprovalActions(
      request('MASS_PAUSE', [decision({ entityId: 'clx8f2k9a0001qz', label: 'слон оптом' })]),
      target(),
    );

    expect(action?.reason).toContain('слон оптом');
    expect(action?.reason).not.toContain('clx8f2k9a0001qz');
  });

  it('falls back to the internal id only when there is no name at all', () => {
    const [action] = toApprovalActions(
      request('MASS_PAUSE', [decision({ entityId: 'kw-9', label: null })]),
      target(),
    );

    expect(action?.reason).toContain('KEYWORD kw-9');
  });
});

describe('toApprovalActions: bid changes', () => {
  const bid = (overrides: Partial<Decision> = {}): Decision =>
    decision({
      action: 'BID_INCREASE',
      prevValue: { kind: 'bid', amount: 10 },
      nextValue: { kind: 'bid', amount: 13 },
      approvalKind: 'BID_CHANGE',
      reason: 'Повышение ставки на 30%',
      ...overrides,
    });

  it('builds a card for a clamped +30% bid, the case policy sends to a human', () => {
    const actions = toApprovalActions(request('BID_CHANGE', [bid()]), target());

    expect(actions).toHaveLength(1);
    const [action] = actions;
    if (action?.kind !== 'bid_change') throw new Error('ожидалась карточка ставок');
    expect(action.changes).toEqual([{ keywordExternalId: 'ext-kw-1', bid: 13, bidBefore: 10 }]);
  });

  it('keeps every decision of the bucket, not just the first', () => {
    const actions = toApprovalActions(
      request('BID_CHANGE', [bid({ entityId: 'kw-1' }), bid({ entityId: 'kw-2' })]),
      target(),
    );

    const [action] = actions;
    if (action?.kind !== 'bid_change') throw new Error('ожидалась карточка ставок');
    expect(action.changes.map((c) => c.keywordExternalId)).toEqual(['ext-kw-1', 'ext-kw-2']);
  });

  it('still builds a card when policy routed bids through the budget bucket', () => {
    const actions = toApprovalActions(request('BUDGET_CHANGE', [bid()]), target());
    expect(actions.map((a) => a.kind)).toEqual(['bid_change']);
  });
});

describe('toApprovalActions: budget changes', () => {
  const budget = decision({
    action: 'BUDGET_CHANGE',
    entityType: 'CAMPAIGN',
    entityId: 'c-1',
    label: 'Ремонт квартир',
    prevValue: { kind: 'budget', amount: 5000 },
    nextValue: { kind: 'budget', amount: 9000 },
    approvalKind: 'BUDGET_CHANGE',
    reason: 'Бюджет недобирает',
  });

  it('carries before and after into the card', () => {
    const [action] = toApprovalActions(request('BUDGET_CHANGE', [budget]), target());
    expect(action).toMatchObject({
      kind: 'budget_change',
      campaignExternalId: '777',
      campaignName: 'Ремонт квартир',
      before: 5000,
      after: 9000,
    });
  });

  it('drops the card when the campaign has no external id', () => {
    expect(
      toApprovalActions(request('BUDGET_CHANGE', [budget]), target({ campaignExternalId: null })),
    ).toEqual([]);
  });
});

describe('toApprovalActions: IMPORT_HANDOVER', () => {
  const negative = decision({
    action: 'ADD_NEGATIVE_KEYWORD',
    entityType: 'ADGROUP',
    entityId: 'ag-1',
    label: '«скачать бесплатно»',
    prevValue: { kind: 'absent' },
    nextValue: { kind: 'negativeKeyword', phrase: 'скачать бесплатно' },
    approvalKind: 'IMPORT_HANDOVER',
    reason: 'Минус-слово «скачать бесплатно»: CTR 0.30%',
  });

  it('reaches the human instead of silently vanishing', () => {
    const actions = toApprovalActions(
      request('IMPORT_HANDOVER', [decision({ approvalKind: 'IMPORT_HANDOVER' })]),
      target(),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'pause_entities', level: 'keyword' });
  });

  it('splits a mixed OBSERVER batch into one card per operation', () => {
    const decisions = [
      decision({ entityId: 'kw-1', approvalKind: 'IMPORT_HANDOVER' }),
      decision({ entityId: 'ad-1', entityType: 'AD', approvalKind: 'IMPORT_HANDOVER' }),
      decision({
        action: 'BID_DECREASE',
        entityId: 'kw-2',
        prevValue: { kind: 'bid', amount: 10 },
        nextValue: { kind: 'bid', amount: 8.5 },
        approvalKind: 'IMPORT_HANDOVER',
      }),
      negative,
    ];

    const actions = toApprovalActions(request('IMPORT_HANDOVER', decisions), target());

    expect(actions.map((a) => a.kind)).toEqual([
      'pause_entities',
      'pause_entities',
      'bid_change',
      'add_negatives',
    ]);
    expect(actions.every((a) => a.reason.length > 0)).toBe(true);
  });

  it('covers every decision an OBSERVER campaign produces', () => {
    const raw = [
      ...Array.from({ length: 11 }, (_unused, i) =>
        decision({ entityId: `kw-${i}`, requiresApproval: false, approvalKind: null }),
      ),
      { ...negative, requiresApproval: false, approvalKind: null },
    ];
    const { approvals } = classifyDecisions(raw, { handoverMode: 'OBSERVER' });

    expect(approvals[0]?.kind).toBe('IMPORT_HANDOVER');
    const actions = toApprovalActions(approvals[0] as ApprovalRequest, target());
    const covered = actions.reduce(
      (sum, action) =>
        sum +
        (action.kind === 'pause_entities'
          ? action.externalIds.length
          : action.kind === 'add_negatives'
            ? action.phrases.length
            : 0),
      0,
    );
    expect(covered).toBe(raw.length);
  });
});
