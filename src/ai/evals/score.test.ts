import { describe, expect, it } from 'vitest';

import {
  aggregateScore,
  buildBaseline,
  compareToBaseline,
  jsonEqual,
  scoreCase,
  type EvalBaseline,
} from './score.js';
import type { EvalCase, EvalRunResult } from './types.js';

const evalCase: EvalCase = {
  id: 'demo',
  description: 'демо-кейс',
  promptVersion: '1.0.0',
  persona: {},
  style: 'коротко',
  answers: ['Курсы английского'],
  recorded: [],
  expect: {
    outcome: 'complete',
    brief: { targetCpaRub: 2_000 },
    absent: ['dailyBudgetRub'],
    maxTurns: 5,
  },
};

function result(patch: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    caseId: 'demo',
    outcome: 'complete',
    turns: 3,
    brief: { targetCpaRub: 2_000 },
    recorded: [],
    answers: [],
    ...patch,
  };
}

describe('jsonEqual', () => {
  it('не зависит от порядка ключей', () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('scoreCase', () => {
  it('даёт 1.0, когда сошлось всё', () => {
    const score = scoreCase(evalCase, result());
    expect(score.passed).toBe(true);
    expect(score.score).toBe(1);
  });

  it('штрафует выдуманное поле', () => {
    const score = scoreCase(
      evalCase,
      result({ brief: { targetCpaRub: 2_000, dailyBudgetRub: 5_000 } }),
    );
    expect(score.passed).toBe(false);
    expect(score.checks.find((c) => c.name.includes('dailyBudgetRub'))?.ok).toBe(false);
  });

  it('штрафует чужой исход и перебор ходов', () => {
    const score = scoreCase(evalCase, result({ outcome: 'needs_human', turns: 42 }));
    expect(score.score).toBeLessThan(1);
    expect(score.checks.filter((c) => !c.ok)).toHaveLength(2);
  });

  it('считает ошибку прогона проваленной проверкой', () => {
    const score = scoreCase(evalCase, result({ outcome: 'error', error: 'boom' }));
    expect(score.checks[0]).toMatchObject({ ok: false, detail: 'boom' });
  });
});

describe('compareToBaseline', () => {
  const baseline: EvalBaseline = {
    promptVersion: '1.0.0',
    recordedAt: '2026-08-08T00:00:00.000Z',
    cases: { demo: 1, other: 0.5 },
    aggregate: 0.75,
  };

  it('молчит, когда не стало хуже', () => {
    const comparison = compareToBaseline([scoreCase(evalCase, result())], baseline, '1.0.0');
    expect(comparison.regressions).toEqual([]);
    expect(comparison.promptChanged).toBe(false);
  });

  it('показывает регрессию с обеими цифрами', () => {
    const worse = scoreCase(evalCase, result({ outcome: 'needs_human' }));
    const comparison = compareToBaseline([worse], baseline, '1.0.0');
    expect(comparison.regressions).toEqual([{ caseId: 'demo', baseline: 1, current: worse.score }]);
  });

  it('отмечает, что промпт правили без нового baseline', () => {
    const comparison = compareToBaseline([scoreCase(evalCase, result())], baseline, '1.1.0');
    expect(comparison.promptChanged).toBe(true);
  });

  it('не сравнивает кейсы, которых в baseline нет', () => {
    const fresh = scoreCase({ ...evalCase, id: 'new' }, result({ caseId: 'new' }));
    expect(compareToBaseline([fresh], baseline, '1.0.0').unknownCases).toEqual(['new']);
  });
});

describe('buildBaseline', () => {
  it('записывает версию промпта и округлённые оценки', () => {
    const scores = [scoreCase(evalCase, result())];
    const baseline = buildBaseline(scores, '2.0.0', new Date('2026-08-08T10:00:00Z'));
    expect(baseline).toEqual({
      promptVersion: '2.0.0',
      recordedAt: '2026-08-08T10:00:00.000Z',
      cases: { demo: 1 },
      aggregate: 1,
    });
  });
});

describe('aggregateScore', () => {
  it('усредняет по кейсам', () => {
    expect(aggregateScore([])).toBe(1);
    expect(
      aggregateScore([
        { caseId: 'a', score: 1, passed: true, checks: [] },
        { caseId: 'b', score: 0.5, passed: false, checks: [] },
      ]),
    ).toBe(0.75);
  });
});
