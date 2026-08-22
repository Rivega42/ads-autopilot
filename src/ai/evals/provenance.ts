import type { EvalBaseline } from './score.js';
import type { EvalCase, EvalRecordingSource } from './types.js';

/**
 * Происхождение eval-набора: что именно доказывает зелёный прогон.
 *
 * Офлайн-прогон гоняет записанные ходы модели через настоящую машину интервью. Он
 * проверяет код — разбор ответов, защиту от выдуманных цифр, условие завершения — и
 * ничего не проверяет в самом промпте: удали из промпта блок про Метрику, и записи
 * останутся прежними, а набор — зелёным.
 *
 * Отсюда правило: набор обязан говорить, на чём он стоит, в каждом прогоне. Провалить
 * прогон за это нельзя (вечно красный тест выключат, и станет только хуже), поэтому
 * заголовок уезжает в имя теста, а подробности — в stderr. Красным набор становится
 * только там, где враньё поправимо: пометка происхождения снята или фикстуры записаны
 * на другом тексте промпта.
 */

export type BaselineSource = EvalRecordingSource | 'offline-replay';

/** Кейс с точки зрения происхождения: остальные поля здесь не нужны. */
export type CaseProvenance = Pick<EvalCase, 'id'> &
  Partial<Pick<EvalCase, 'source' | 'promptFingerprint'>>;

export interface EvalTrustInput {
  /** Прогон с живой моделью (`AI_EVALS_LIVE=1`). */
  live: boolean;
  cases: readonly CaseProvenance[];
  baseline: EvalBaseline | null;
  /** Отпечаток текста промпта прямо сейчас. */
  promptFingerprint: string;
}

export interface EvalTrust {
  /** true — прогон действительно что-то говорит о промпте и модели. */
  trusted: boolean;
  /** Заголовок для имени теста: он попадает в вывод каждого прогона CI. */
  headline: string;
  /** Кейсы, чьи ходы записаны рукой, а не живым прогоном. */
  handwritten: string[];
  /** Кейсы без внятной пометки происхождения. */
  unmarked: string[];
  /** Кейсы, записанные на другом тексте промпта. */
  stale: string[];
  /** Подробности для stderr. */
  banner: string;
}

const SOURCES: readonly EvalRecordingSource[] = ['live', 'handwritten'];

function isKnownSource(value: unknown): value is EvalRecordingSource {
  return typeof value === 'string' && (SOURCES as readonly string[]).includes(value);
}

export function describeEvalTrust(input: EvalTrustInput): EvalTrust {
  const unmarked = input.cases
    .filter((c) => !isKnownSource(c.source) || (c.promptFingerprint ?? '') === '')
    .map((c) => c.id);

  const handwritten = input.cases.filter((c) => c.source === 'handwritten').map((c) => c.id);

  const stale = input.cases
    .filter(
      (c) => (c.promptFingerprint ?? '') !== '' && c.promptFingerprint !== input.promptFingerprint,
    )
    .map((c) => c.id);

  const trusted = input.live;
  const headline = buildHeadline(input, { trusted, handwritten });

  return { trusted, headline, handwritten, unmarked, stale, banner: buildBanner(input, headline) };
}

function buildHeadline(
  input: EvalTrustInput,
  state: { trusted: boolean; handwritten: readonly string[] },
): string {
  if (state.trusted) return `живой прогон модели: оценка относится к промпту, ${count(input)}`;
  if (state.handwritten.length > 0) {
    return (
      `⚠️ офлайн + фикстуры записаны рукой (${state.handwritten.length} из ${input.cases.length}): ` +
      'модель не вызывалась, промпт этим прогоном НЕ проверен'
    );
  }
  return `⚠️ офлайн-реплей записей живого прогона: проверяется код интервью, не модель, ${count(input)}`;
}

function count(input: EvalTrustInput): string {
  return `кейсов: ${input.cases.length}`;
}

function buildBanner(input: EvalTrustInput, headline: string): string {
  const lines = ['', '─── eval онбординга: чему верить ───', headline];

  const handwritten = input.cases.filter((c) => c.source === 'handwritten').map((c) => c.id);
  if (handwritten.length > 0) {
    lines.push(`  фикстуры не с живого прогона: ${handwritten.join(', ')}`);
  }

  const unmarked = input.cases.filter((c) => !isKnownSource(c.source)).map((c) => c.id);
  if (unmarked.length > 0) {
    lines.push(`  фикстуры без пометки происхождения: ${unmarked.join(', ')}`);
  }

  if (input.baseline === null) {
    lines.push('  baseline не записан: сравнивать не с чем');
  } else {
    lines.push(
      `  baseline: source=${input.baseline.source ?? 'без пометки'}, ` +
        `promptVersion=${input.baseline.promptVersion}, recordedAt=${input.baseline.recordedAt}`,
    );
  }

  lines.push(
    '  живой прогон: AI_EVALS_LIVE=1 (нужны ключи провайдера и деньги),',
    '  перезапись фикстур: + AI_EVALS_RECORD=1, baseline: AI_EVALS_UPDATE_BASELINE=1',
    '────────────────────────────────────',
    '',
  );
  return lines.join('\n');
}
