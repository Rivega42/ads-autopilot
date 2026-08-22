import { afterEach, describe, expect, it, vi } from 'vitest';

import { bidHistoryKey, noBidHistory, type BidHistory } from './bid-history.js';
import {
  applyGuardrails,
  DEFAULT_GUARDRAILS,
  observationKey,
  type GuardrailConfig,
  type GuardrailContext,
  type ObservationCounts,
} from './guardrails.js';
import { runMvpRules } from './rules.js';
import type {
  Decision,
  DecisionValue,
  EntityMetrics,
  OptimizationTargets,
  SearchQueryMetrics,
} from './types.js';

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
  observations: ReadonlyArray<[string, ObservationCounts]> = [
    ['KEYWORD:kw-1', { impressions: 1000, days: 7 }],
  ],
): GuardrailContext {
  return {
    dailyBudget: 5000,
    observations: new Map(observations),
    bidHistory: noBidHistory(WINDOW_DAYS),
    ...overrides,
  };
}

const WINDOW_DAYS = 7;

/** История, в которой ставка сущности на начало окна была `anchor`. */
function history(anchor: number, entityId = 'kw-1'): BidHistory {
  return {
    windowDays: WINDOW_DAYS,
    anchors: new Map([[bidHistoryKey('KEYWORD', entityId), anchor]]),
    unavailable: new Set(),
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
      decision({
        entityType: 'ADGROUP',
        entityId: 'ag-1',
        nextValue: { kind: 'negativeKeyword', phrase: 'a' },
      }),
    );
    const second = observationKey(
      decision({
        entityType: 'ADGROUP',
        entityId: 'ag-1',
        nextValue: { kind: 'negativeKeyword', phrase: 'b' },
      }),
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

describe('max bid change per window', () => {
  /**
   * Ставка уже опустилась со 100 до 80 внутри окна, то есть на 20% из тридцати.
   * Остаток хода вниз — до 70, и предохранитель обязан считать его от 100, а не от 80.
   */
  const moved = (next: number): Decision =>
    decision({ prevValue: { kind: 'bid', amount: 80 }, nextValue: { kind: 'bid', amount: next } });

  it('шаг, помещающийся в остаток лимита, проходит целиком', () => {
    const outcome = applyGuardrails([moved(72)], context({ bidHistory: history(100) }));
    expect(outcome.rejected).toEqual([]);
    expect(bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(72);
    expect(outcome.clamped).toEqual([]);
  });

  it('шаг, перебирающий остаток, урезается до остатка, а не до шагового лимита', () => {
    const outcome = applyGuardrails([moved(68)], context({ bidHistory: history(100) }));
    // Шаговый лимит от 80 разрешил бы 56 — и ставка ушла бы за −30% от начала окна.
    expect(bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(70);
    expect(outcome.clamped[0]?.rail).toBe('MAX_BID_CHANGE_WINDOW');
    expect(outcome.allowed[0]?.reason).toContain('за 7 сут.');
  });

  it('исчерпанный лимит отклоняет решение, а не превращает его в изменение на ноль', () => {
    const outcome = applyGuardrails([moved(70)], context({ bidHistory: history(100) }));
    expect(outcome.allowed).toHaveLength(1);

    const exhausted = applyGuardrails(
      [
        decision({
          prevValue: { kind: 'bid', amount: 70 },
          nextValue: { kind: 'bid', amount: 60 },
        }),
      ],
      context({ bidHistory: history(100) }),
    );
    expect(exhausted.allowed).toEqual([]);
    expect(exhausted.clamped).toEqual([]);
    expect(exhausted.rejected[0]?.rail).toBe('MAX_BID_CHANGE_WINDOW');
    expect(exhausted.rejected[0]?.note).toContain('исчерпан');
  });

  it('лимит за окно считается по модулю: обратный ход после спуска разрешён', () => {
    const outcome = applyGuardrails(
      [
        decision({
          prevValue: { kind: 'bid', amount: 70 },
          nextValue: { kind: 'bid', amount: 77 },
        }),
      ],
      context({ bidHistory: history(100) }),
    );
    expect(bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(77);
  });

  it('шаговый лимит остаётся главным, когда он строже оконного', () => {
    // Якорь ниже текущей ставки: за окно ставка уже росла, вверх хода почти нет,
    // а вниз шаговый лимит от 200 не пускает дальше 140.
    const outcome = applyGuardrails(
      [
        decision({
          prevValue: { kind: 'bid', amount: 200 },
          nextValue: { kind: 'bid', amount: 10 },
        }),
      ],
      context({ bidHistory: history(180) }),
    );
    expect(bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(140);
    expect(outcome.clamped[0]?.rail).toBe('MAX_BID_CHANGE');
  });

  it('ставка, уже вынесенная за коридор окна, может только возвращаться в него', () => {
    // Человек поднял ставку руками до 200 при якоре 100: коридор окна — 70…130.
    const up = applyGuardrails(
      [
        decision({
          action: 'BID_INCREASE',
          prevValue: { kind: 'bid', amount: 200 },
          nextValue: { kind: 'bid', amount: 220 },
        }),
      ],
      context({ bidHistory: history(100) }),
    );
    expect(up.allowed).toEqual([]);
    expect(up.rejected[0]?.rail).toBe('MAX_BID_CHANGE_WINDOW');

    const down = applyGuardrails(
      [
        decision({
          prevValue: { kind: 'bid', amount: 200 },
          nextValue: { kind: 'bid', amount: 150 },
        }),
      ],
      context({ bidHistory: history(100) }),
    );
    expect(bidAmount(down.allowed[0]?.nextValue ?? { kind: 'absent' })).toBe(150);
  });

  it('недостоверная история отклоняет изменение ставки, а не пропускает его', () => {
    const outcome = applyGuardrails(
      [decision()],
      context({
        bidHistory: {
          windowDays: 7,
          anchors: new Map(),
          unavailable: new Set([bidHistoryKey('KEYWORD', 'kw-1')]),
        },
      }),
    );
    expect(outcome.allowed).toEqual([]);
    expect(outcome.rejected[0]?.rail).toBe('BID_HISTORY_UNAVAILABLE');
  });

  it('недостоверная история не мешает поставить сущность на паузу', () => {
    const outcome = applyGuardrails(
      [
        decision({
          action: 'PAUSE',
          prevValue: { kind: 'status', status: 'ACTIVE' },
          nextValue: { kind: 'status', status: 'PAUSED' },
        }),
      ],
      context({
        bidHistory: {
          windowDays: 7,
          anchors: new Map(),
          unavailable: new Set([bidHistoryKey('KEYWORD', 'kw-1')]),
        },
      }),
    );
    expect(outcome.allowed).toHaveLength(1);
  });

  it('семь шагов правила по −15% упираются в лимит, а не складываются', () => {
    // Тот же сюжет, что в сценарии tests/e2e/optimization-cycle.e2e.ts, но без БД:
    // здесь видно арифметику, там — что она доезжает до кабинета.
    const anchorBid = 200;
    let bid = anchorBid;
    const applied: number[] = [];

    for (let day = 0; day < 7; day += 1) {
      const proposed = Math.round(bid * 0.85 * 100) / 100;
      const outcome = applyGuardrails(
        [
          decision({
            prevValue: { kind: 'bid', amount: bid },
            nextValue: { kind: 'bid', amount: proposed },
          }),
        ],
        context({ bidHistory: day === 0 ? noBidHistory(7) : history(anchorBid) }),
      );
      const next = bidAmount(outcome.allowed[0]?.nextValue ?? { kind: 'absent' });
      if (next === null) continue;
      bid = next;
      applied.push(next);
    }

    expect(applied).toEqual([170, 144.5, 140]);
    expect(1 - bid / anchorBid).toBeCloseTo(DEFAULT_GUARDRAILS.maxBidChangePct, 10);
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
    {
      name: 'impressions just below the floor',
      counts: { impressions: 99, days: 7 },
      allowed: false,
    },
    {
      name: 'impressions exactly at the floor',
      counts: { impressions: 100, days: 7 },
      allowed: true,
    },
    {
      name: 'impressions just above the floor',
      counts: { impressions: 101, days: 7 },
      allowed: true,
    },
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
      decision({
        entityId: `kw-${index}`,
        action: 'PAUSE',
        prevValue: { kind: 'status', status: 'ACTIVE' },
        nextValue: { kind: 'status', status: 'PAUSED' },
      }),
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
        decision({
          entityId: 'kw-0',
          action: 'PAUSE',
          prevValue: { kind: 'status', status: 'ACTIVE' },
          nextValue: { kind: 'status', status: 'PAUSED' },
        }),
        decision({ entityId: 'kw-1' }),
      ],
      context({ eligibleEntityCount: 4 }, observationsFor(2)),
    );
    expect(outcome.allowed).toHaveLength(2);
    expect(outcome.rejected[0]?.decision.entityId).toBe('kw-1');
  });

  it('does not spend the quota on negative keywords', () => {
    const negatives = Array.from({ length: 5 }, (_unused, index) =>
      decision({
        action: 'ADD_NEGATIVE_KEYWORD',
        entityType: 'ADGROUP',
        entityId: `ag-${index}`,
        prevValue: { kind: 'absent' },
        nextValue: { kind: 'negativeKeyword', phrase: `минус ${index}` },
      }),
    );
    const observations = negatives.map((_negative, index): [string, ObservationCounts] => [
      `ADGROUP:ag-${index}:минус ${index}`,
      { impressions: 1000, days: 7 },
    ]);
    const outcome = applyGuardrails(
      [...negatives, ...many(2)],
      context({ eligibleEntityCount: 4 }, [...observations, ...observationsFor(2)]),
    );
    expect(outcome.allowed).toHaveLength(6);
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
    // Группы объявлений здесь наравне с фразами: у VK ставка живёт на них, и
    // предохранитель обязан ловить её тем же коридором, а не только уровень фраз.
    const entities: EntityMetrics[] = Array.from({ length: entityCount }, (_unused, index) => ({
      entityType: entityTypeOf(random()),
      entityId: `e-${index}`,
      label: null,
      impressions: Math.floor(random() * 3000),
      clicks: Math.floor(random() * 300),
      spend: Math.round(random() * 20000) / 100,
      conversions: Math.floor(random() * 5),
      days: Math.floor(random() * 10),
      currentBid: random() < 0.15 ? null : Math.round(random() * 50000) / 100,
      status: 'ACTIVE',
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
        bidLevel: random() < 0.5 ? 'ADGROUP' : 'KEYWORD',
      },
    };
  }

  function entityTypeOf(draw: number): EntityMetrics['entityType'] {
    if (draw < 0.55) return 'KEYWORD';
    return draw < 0.8 ? 'ADGROUP' : 'AD';
  }

  it('holds over 500 pseudo-random accounts', () => {
    const random = createRandom(20260808);
    const settings = config();
    const seen = { proposed: 0, allowed: 0, clamped: 0, rejected: 0, groupBids: 0 };

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

      // Часть сущностей уже двигалась внутри окна: без якорей свойство проверяло бы
      // только шаговый коридор, то есть ровно ту половину предохранителя, что была и до
      // суммарного лимита.
      const anchors = new Map<string, number>();
      for (const entity of scenario.entities) {
        if (entity.currentBid === null || entity.currentBid <= 0) continue;
        if (random() < 0.5) continue;
        anchors.set(
          `${entity.entityType}:${entity.entityId}`,
          Math.round(entity.currentBid * (0.8 + random() * 0.45) * 100) / 100,
        );
      }

      const outcome = applyGuardrails(
        decisions,
        {
          dailyBudget: scenario.targets.dailyBudget,
          observations,
          eligibleEntityCount: scenario.entities.length,
          bidHistory: { windowDays: 7, anchors, unavailable: new Set() },
        },
        settings,
      );

      seen.proposed += decisions.length;
      seen.groupBids += outcome.allowed.filter(
        (allowed) => allowed.entityType === 'ADGROUP' && allowed.nextValue.kind === 'bid',
      ).length;
      seen.allowed += outcome.allowed.length;
      seen.clamped += outcome.clamped.length;
      seen.rejected += outcome.rejected.length;

      const ceiling = scenario.targets.dailyBudget * settings.budgetCeilingRatio;
      const touched = new Set(
        outcome.allowed
          .filter((allowed) => allowed.nextValue.kind !== 'negativeKeyword')
          .map((allowed) => allowed.entityId),
      );

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
          // Ставка не может стать дальше от коридора окна, чем уже была: внутри коридора
          // она обязана в нём остаться, а снаружи — только приближаться.
          const anchor = anchors.get(`${allowed.entityType}:${allowed.entityId}`) ?? previous;
          const away = (value: number): number =>
            Math.max(
              0,
              anchor * (1 - settings.maxBidChangePct) - value,
              value - anchor * (1 + settings.maxBidChangePct),
            );
          expect(away(allowed.nextValue.amount)).toBeLessThanOrEqual(away(previous) + 0.01);
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
    // Уровень группы обязан быть не только сгенерирован, но и пройден насквозь:
    // иначе расширение свойства проверяло бы ровно то же, что и раньше.
    expect(seen.groupBids).toBeGreaterThan(0);
  });
});

/**
 * Потолок дневного бюджета — вторая переменная того же класса, что и
 * `MAX_BID_CHANGE_PCT`: `DAILY_BUDGET_HARD_LIMIT_MULT` объявлена в `.env.example`,
 * а `budgetCeilingRatio` хранил ту же цифру отдельно. Тест смотрит на сумму в
 * решении, вышедшем из `applyGuardrails`, — единственной точки, через которую
 * проходит любое изменение.
 */
describe('потолок бюджета из окружения', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const budgetDecision = decision({
    action: 'BUDGET_CHANGE',
    entityType: 'CAMPAIGN',
    entityId: 'c-1',
    prevValue: { kind: 'budget', amount: 5000 },
    nextValue: { kind: 'budget', amount: 20000 },
  });
  const budgetContext = context({}, [['CAMPAIGN:c-1', { impressions: 1000, days: 7 }]]);

  it('DAILY_BUDGET_HARD_LIMIT_MULT задаёт потолок, до которого урезан бюджет', async () => {
    vi.stubEnv('DAILY_BUDGET_HARD_LIMIT_MULT', '1.05');
    vi.resetModules();
    const fresh = await import('./guardrails.js');

    const outcome = fresh.applyGuardrails([budgetDecision], budgetContext);

    expect(outcome.allowed[0]?.nextValue).toEqual({ kind: 'budget', amount: 5250 });
    expect(outcome.clamped[0]?.rail).toBe('BUDGET_CEILING');
  });

  it('без переменной потолок остаётся прежним', async () => {
    vi.resetModules();
    const fresh = await import('./guardrails.js');

    const outcome = fresh.applyGuardrails([budgetDecision], budgetContext);

    expect(outcome.allowed[0]?.nextValue).toEqual({ kind: 'budget', amount: 6000 });
  });
});
