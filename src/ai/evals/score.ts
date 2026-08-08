import type { EvalCase, EvalRunResult } from './types.js';

import type { BriefField, ClientBriefDraft } from '@/ai/onboarding/brief.schema.js';

/**
 * Оценка прогона и сравнение с baseline.
 *
 * Оценка намеренно грубая: доля пройденных проверок. Она нужна не для абсолютного
 * «качества агента», а чтобы CI мог сказать «стало хуже, чем было в baseline» —
 * ровно то, чего требует CLAUDE.md §8.
 */

export interface EvalCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface CaseScore {
  caseId: string;
  score: number;
  passed: boolean;
  checks: EvalCheck[];
}

export interface EvalBaseline {
  /** Версия промпта, на которой записан baseline. */
  promptVersion: string;
  recordedAt: string;
  /** caseId → score. */
  cases: Record<string, number>;
  aggregate: number;
}

export interface Regression {
  caseId: string;
  baseline: number;
  current: number;
}

export interface BaselineComparison {
  regressions: Regression[];
  /** Кейсы, которых нет в baseline: их не с чем сравнивать. */
  unknownCases: string[];
  aggregate: { baseline: number; current: number };
  /** true — промпт правили, а baseline не переписали. */
  promptChanged: boolean;
}

/** Стабильная сериализация: порядок ключей в JSON от модели произвольный. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function scoreCase(evalCase: EvalCase, result: EvalRunResult): CaseScore {
  const checks: EvalCheck[] = [];

  checks.push({
    name: 'без ошибок прогона',
    ok: result.outcome !== 'error',
    detail: result.error,
  });

  checks.push({
    name: `исход = ${evalCase.expect.outcome}`,
    ok: result.outcome === evalCase.expect.outcome,
    detail: `получено: ${result.outcome}`,
  });

  const brief: ClientBriefDraft = result.brief;

  for (const [field, expected] of Object.entries(evalCase.expect.brief ?? {})) {
    const actual = brief[field as BriefField];
    checks.push({
      name: `${field} = ${stableStringify(expected)}`,
      ok: jsonEqual(actual, expected),
      detail: `получено: ${stableStringify(actual)}`,
    });
  }

  for (const field of evalCase.expect.absent ?? []) {
    const actual = brief[field];
    checks.push({
      // Самая важная проверка набора: агент не должен выдумывать то, чего клиент не сказал.
      name: `${field} отсутствует (не выдумано)`,
      ok: actual === undefined,
      detail: actual === undefined ? undefined : `выдумано: ${stableStringify(actual)}`,
    });
  }

  if (evalCase.expect.maxTurns !== undefined) {
    checks.push({
      name: `ходов ≤ ${evalCase.expect.maxTurns}`,
      ok: result.turns <= evalCase.expect.maxTurns,
      detail: `ходов: ${result.turns}`,
    });
  }

  const ok = checks.filter((c) => c.ok).length;
  return {
    caseId: evalCase.id,
    score: checks.length === 0 ? 1 : ok / checks.length,
    passed: ok === checks.length,
    checks,
  };
}

export function aggregateScore(scores: readonly CaseScore[]): number {
  if (scores.length === 0) return 1;
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  return total / scores.length;
}

export function buildBaseline(
  scores: readonly CaseScore[],
  promptVersion: string,
  now: Date = new Date(),
): EvalBaseline {
  return {
    promptVersion,
    recordedAt: now.toISOString(),
    cases: Object.fromEntries(scores.map((s) => [s.caseId, round(s.score)])),
    aggregate: round(aggregateScore(scores)),
  };
}

/** Сравнение с допуском: score — доля дробных проверок, точное равенство тут неуместно. */
const TOLERANCE = 1e-6;

export function compareToBaseline(
  scores: readonly CaseScore[],
  baseline: EvalBaseline,
  promptVersion: string,
): BaselineComparison {
  const regressions: Regression[] = [];
  const unknownCases: string[] = [];

  for (const score of scores) {
    const previous = baseline.cases[score.caseId];
    if (previous === undefined) {
      unknownCases.push(score.caseId);
      continue;
    }
    if (score.score < previous - TOLERANCE) {
      regressions.push({ caseId: score.caseId, baseline: previous, current: round(score.score) });
    }
  }

  return {
    regressions,
    unknownCases,
    aggregate: { baseline: baseline.aggregate, current: round(aggregateScore(scores)) },
    promptChanged: baseline.promptVersion !== promptVersion,
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
