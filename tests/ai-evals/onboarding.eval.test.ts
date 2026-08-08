import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildBaseline,
  compareToBaseline,
  runEvalCase,
  scoreCase,
  type CaseScore,
  type EvalBaseline,
  type EvalCase,
  type EvalRunResult,
} from '@/ai/evals/index.js';
import { PROMPT_VERSION } from '@/ai/prompt-loader.js';

/**
 * Eval-набор AI-онбординга (CLAUDE.md §8).
 *
 * По умолчанию — офлайн: ходы интервьюера берутся из записанных фикстур, живая
 * модель не вызывается, ключи не нужны, `pnpm test` остаётся бесплатным. Проверяется
 * всё, что стоит между моделью и БД: разбор ответов, защита от выдуманных цифр,
 * условие завершения интервью.
 *
 * Живой прогон (стоит денег, нужны ключи провайдера):
 *   AI_EVALS_LIVE=1 npx vitest run tests/ai-evals
 * Перезаписать фикстуры по живому прогону:
 *   AI_EVALS_LIVE=1 AI_EVALS_RECORD=1 npx vitest run tests/ai-evals
 * Записать baseline (делать ДО правки промпта, иначе регрессию не с чем сравнить):
 *   AI_EVALS_UPDATE_BASELINE=1 npx vitest run tests/ai-evals
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, 'onboarding', 'fixtures');
const BASELINE_PATH = join(HERE, 'onboarding', 'baseline.json');

const LIVE = process.env.AI_EVALS_LIVE === '1';
const RECORD = process.env.AI_EVALS_RECORD === '1';
const UPDATE_BASELINE = process.env.AI_EVALS_UPDATE_BASELINE === '1';

const PROMPT = PROMPT_VERSION['onboarding-interview'];

function loadCases(): EvalCase[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as EvalCase);
}

function loadBaseline(): EvalBaseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as EvalBaseline;
  } catch {
    return null;
  }
}

const cases = loadCases();
const results = new Map<string, EvalRunResult>();
const scores: CaseScore[] = [];

beforeAll(async () => {
  for (const evalCase of cases) {
    const result = await runEvalCase(evalCase, { live: LIVE });
    results.set(evalCase.id, result);
    scores.push(scoreCase(evalCase, result));

    if (LIVE && RECORD) {
      const updated: EvalCase = {
        ...evalCase,
        promptVersion: PROMPT,
        recorded: result.recorded,
        answers: result.answers,
      };
      mkdirSync(FIXTURES_DIR, { recursive: true });
      writeFileSync(
        join(FIXTURES_DIR, `${evalCase.id}.json`),
        `${JSON.stringify(updated, null, 2)}\n`,
        'utf8',
      );
    }
  }

  if (UPDATE_BASELINE) {
    const baseline = buildBaseline(scores, PROMPT);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  }
}, 600_000);

describe('онбординг: eval-набор', () => {
  it('фикстуры на месте', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const evalCase of cases) {
    it(`${evalCase.id}: ${evalCase.description}`, () => {
      const score = scores.find((s) => s.caseId === evalCase.id);
      expect(score, 'кейс не прогнан').toBeDefined();
      if (!score) return;

      const failed = score.checks.filter((c) => !c.ok);
      expect(failed.map((c) => `${c.name} → ${c.detail ?? ''}`)).toEqual([]);
    });
  }

  it('фикстуры записаны на текущей версии промпта', () => {
    // Офлайн-прогон не проверяет саму модель: если промпт поменяли, а фикстуры нет,
    // зелёный набор ничего не доказывает. Здесь это видно явно.
    const stale = cases.filter((c) => c.promptVersion !== PROMPT).map((c) => c.id);
    expect(stale, `перезапиши фикстуры: AI_EVALS_LIVE=1 AI_EVALS_RECORD=1`).toEqual([]);
  });

  it('нет регрессии относительно baseline', () => {
    const baseline = loadBaseline();
    expect(baseline, 'baseline не записан: AI_EVALS_UPDATE_BASELINE=1').not.toBeNull();
    if (!baseline) return;

    const comparison = compareToBaseline(scores, baseline, PROMPT);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.aggregate.current).toBeGreaterThanOrEqual(comparison.aggregate.baseline);
    expect(comparison.unknownCases, 'новые кейсы без baseline').toEqual([]);
    expect(
      comparison.promptChanged,
      'промпт правили без нового baseline: сначала запиши baseline на старом промпте',
    ).toBe(false);
  });
});
