import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildBaseline,
  compareToBaseline,
  describeEvalTrust,
  runEvalCase,
  scoreCase,
  type CaseScore,
  type EvalBaseline,
  type EvalCase,
  type EvalRunResult,
  type EvalTrust,
} from '@/ai/evals/index.js';
import { promptFingerprint, PROMPT_VERSION } from '@/ai/prompt-loader.js';

/**
 * Eval-набор AI-онбординга (CLAUDE.md §8).
 *
 * По умолчанию — офлайн: ходы интервьюера берутся из записанных фикстур, живая
 * модель не вызывается, ключи не нужны, `pnpm test` остаётся бесплатным. Проверяется
 * всё, что стоит между моделью и БД: разбор ответов, защита от выдуманных цифр,
 * условие завершения интервью.
 *
 * Чего офлайн-прогон НЕ проверяет — сам промпт. Поэтому набор в каждом прогоне
 * говорит, на чём он стоит: заголовок с происхождением фикстур уезжает в имя теста
 * и в stderr (`ai/evals/provenance.ts`). Красным он становится там, где враньё
 * поправимо: снятая пометка происхождения или фикстуры, записанные на другом
 * тексте промпта.
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
const FINGERPRINT = promptFingerprint('onboarding-interview');
const STAMP = { promptVersion: PROMPT, promptFingerprint: FINGERPRINT };

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

const trust: EvalTrust = describeEvalTrust({
  live: LIVE,
  cases,
  baseline: loadBaseline(),
  promptFingerprint: FINGERPRINT,
});

beforeAll(async () => {
  // Баннер печатается всегда: зелёный набор не должен молча сходить за доказательство.
  process.stderr.write(trust.banner);

  for (const evalCase of cases) {
    const result = await runEvalCase(evalCase, { live: LIVE });
    results.set(evalCase.id, result);
    scores.push(scoreCase(evalCase, result));

    if (LIVE && RECORD) {
      const updated: EvalCase = {
        ...evalCase,
        promptVersion: PROMPT,
        promptFingerprint: FINGERPRINT,
        source: 'live',
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
    // Происхождение baseline проставляет код, а не человек: baseline, снятый с
    // реплея, обязан выглядеть как baseline, снятый с реплея.
    const baseline = buildBaseline(scores, {
      ...STAMP,
      source: LIVE ? 'live' : 'offline-replay',
    });
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

  // Имя теста — единственное, что видно в выводе CI всегда. Поэтому в нём стоит
  // не «провенанс ок», а прямая оценка того, чему этот прогон вообще свидетель.
  it(`чему верить в этом прогоне — ${trust.headline}`, () => {
    // Красным становится только снятая пометка: вечно падающий тест выключат, а
    // выключенный набор хуже честного предупреждения.
    expect(
      trust.unmarked,
      'фикстура без source/promptFingerprint: происхождение записей неизвестно',
    ).toEqual([]);
  });

  it('фикстуры записаны на текущей версии промпта', () => {
    // Офлайн-прогон не проверяет саму модель: если промпт поменяли, а фикстуры нет,
    // зелёный набор ничего не доказывает. Здесь это видно явно.
    const stale = cases.filter((c) => c.promptVersion !== PROMPT).map((c) => c.id);
    expect(stale, `перезапиши фикстуры: AI_EVALS_LIVE=1 AI_EVALS_RECORD=1`).toEqual([]);
  });

  it('фикстуры записаны на текущем ТЕКСТЕ промпта', () => {
    // Версию можно поправить рукой — так набор и обманули при переходе на 1.1.0.
    // Отпечаток текста рукой не подделаешь: удали из промпта блок про Метрику —
    // и этот тест покраснеет, даже если версия осталась прежней.
    expect(trust.stale, `перезапиши фикстуры: AI_EVALS_LIVE=1 AI_EVALS_RECORD=1`).toEqual([]);
  });

  it('нет регрессии относительно baseline', () => {
    const baseline = loadBaseline();
    expect(baseline, 'baseline не записан: AI_EVALS_UPDATE_BASELINE=1').not.toBeNull();
    if (!baseline) return;

    const comparison = compareToBaseline(scores, baseline, STAMP);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.aggregate.current).toBeGreaterThanOrEqual(comparison.aggregate.baseline);
    expect(comparison.unknownCases, 'новые кейсы без baseline').toEqual([]);
    expect(
      comparison.promptChanged,
      'промпт правили без нового baseline: сначала запиши baseline на старом промпте',
    ).toBe(false);
  });
});
