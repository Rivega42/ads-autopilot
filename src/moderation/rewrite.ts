import type { Provider } from '@prisma/client';

import { loadPrompt } from '@/ai/prompt-loader.js';
import {
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  findAdTextViolations,
} from '@/campaigns/limits.js';
import { runAgent, type AgentRun, type RunAgentOptions } from '@/clients/llm/index.js';
import { findForbidden, formatRules } from '@/moderation/rules.js';
import { adRewriteSchema, type AdRewriteDraft } from '@/moderation/schema.js';
import { CATEGORY_TITLE, type AdText, type ClassifiedRejection } from '@/moderation/types.js';

/**
 * Шаги 3–4 из TZ §13.4: safe-версия текста по базе правил.
 *
 * Ключевое отличие от планировщика кампаний: здесь нельзя «подрезать и отправить».
 * Планировщик рисует карточку, которую увидит человек, а тут результат уходит прямо
 * в кабинет и снова попадает на модерацию. Поэтому невлезающий или нарушающий
 * вариант не чинится обрезкой, а отправляется модели на переписывание; кончились
 * попытки — объявление уходит человеку, а не в кабинет.
 */

export const REWRITER_AGENT = 'moderation-rewriter';

/** Сколько раз зовём модель за один прогон, включая первую попытку. */
export const REWRITE_CALLS = 3;

const EMPTY_FIELD = '—';

export type RunRewriteAgent = (
  opts: RunAgentOptions<AdRewriteDraft>,
) => Promise<AgentRun<AdRewriteDraft>>;

export interface RewriteInput {
  clientId: string;
  channel: Provider;
  reason: string;
  classification: ClassifiedRejection;
  ad: AdText;
  /** Сколько раз это объявление уже переписывалось и снова получало отказ. */
  moderationAttempt: number;
}

export interface RewriteOptions {
  run?: RunRewriteAgent;
}

export type RewriteResult =
  | {
      ok: true;
      ad: AdText;
      changes: string;
      /** Сколько раз ответ модели пришлось забраковать до годного. */
      regenerated: number;
      promptVersion: string;
    }
  | {
      ok: false;
      /** Почему сдались. Уезжает человеку в письмо эскалации. */
      problems: string[];
      regenerated: number;
      promptVersion: string;
    };

/** Сравнение «то же самое»: регистр и лишние пробелы объявление не меняют. */
function normalise(ad: AdText): string {
  return [ad.title, ad.title2 ?? '', ad.text].join(' ').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function toAdText(draft: AdRewriteDraft): AdText {
  const ad: AdText = { title: draft.title.trim(), text: draft.text.trim() };
  const title2 = draft.title2?.trim();
  if (title2) ad.title2 = title2;
  return ad;
}

/**
 * Проверка переписанного объявления теми же правилами, что и у нового.
 *
 * Пустой массив — можно отправлять. Всё остальное едет в промпт следующей попытки
 * дословно: модель чинит по конкретной претензии заметно лучше, чем по «сделай лучше».
 */
export function validateRewrite(original: AdText, candidate: AdText, channel: Provider): string[] {
  const problems: string[] = [];

  if (candidate.title === '' || candidate.text === '') {
    problems.push('пустой заголовок или текст');
    return problems;
  }

  for (const violation of findAdTextViolations(candidate)) {
    problems.push(
      `поле ${violation.field}: ${violation.actual} символов при лимите ${violation.limit}`,
    );
  }

  const joined = [candidate.title, candidate.title2 ?? '', candidate.text].join('\n');
  for (const hit of findForbidden(joined, channel)) {
    problems.push(`правило ${hit.ruleId}: в тексте осталось «${hit.match}»`);
  }

  // Площадка сказала «отклонено» — значит, текст обязан измениться. Модель, решившая,
  // что объявление и так в порядке, спорит не с нами, а с модератором площадки.
  if (normalise(original) === normalise(candidate)) {
    problems.push('текст не изменился: площадка уже отклонила именно эту формулировку');
  }

  return problems;
}

function attemptNote(input: RewriteInput, problems: readonly string[]): string {
  const lines: string[] = [];
  if (input.moderationAttempt > 0) {
    lines.push(
      `## Важно\n\nЭто попытка №${input.moderationAttempt + 1}. Предыдущие переписанные ` +
        'варианты площадка тоже отклонила — не повторяй прежний ход, зайди с другой стороны.',
    );
  }
  if (problems.length > 0) {
    lines.push(
      ['## Что не так с твоим прошлым ответом', ...problems.map((p) => `- ${p}`)].join('\n'),
    );
  }
  return lines.length > 0 ? lines.join('\n\n') : '';
}

export async function rewriteRejectedAd(
  input: RewriteInput,
  opts: RewriteOptions = {},
): Promise<RewriteResult> {
  const run = opts.run ?? runAgent;
  const { classification } = input;
  let problems: string[] = [];
  let version = 'moderation-rewrite';

  for (let call = 0; call < REWRITE_CALLS; call += 1) {
    const prompt = loadPrompt('moderation-rewrite', {
      channel: input.channel,
      category: `${classification.category} — ${CATEGORY_TITLE[classification.category]}`,
      reason: input.reason.trim() === '' ? 'площадка не указала причину' : input.reason.trim(),
      explanation: classification.explanation,
      fragments:
        classification.fragments.length > 0
          ? classification.fragments.map((f) => `«${f}»`).join(', ')
          : 'площадка не указала конкретный фрагмент',
      rules: formatRules(classification.rules),
      title: input.ad.title,
      title2: input.ad.title2 ?? EMPTY_FIELD,
      text: input.ad.text,
      titleMax: DIRECT_TITLE_MAX,
      title2Max: DIRECT_TITLE2_MAX,
      textMax: DIRECT_TEXT_MAX,
      attemptNote: attemptNote(input, problems),
    });
    version = `${prompt.name}@${prompt.version}`;

    const draft = await run({
      agent: REWRITER_AGENT,
      task: 'moderation.rewrite',
      clientId: input.clientId,
      system: prompt.text,
      messages: 'Перепиши объявление так, чтобы оно прошло модерацию.',
      schema: adRewriteSchema,
      schemaName: 'moderation.rewrite',
      // Повторный вызов с тем же кешем вернул бы забракованный вариант дословно.
      cache: call === 0 && input.moderationAttempt === 0,
    });

    const candidate = toAdText(draft.data);
    problems = validateRewrite(input.ad, candidate, input.channel);
    if (problems.length === 0) {
      return {
        ok: true,
        ad: candidate,
        changes: draft.data.changes,
        regenerated: call,
        promptVersion: version,
      };
    }
  }

  return { ok: false, problems, regenerated: REWRITE_CALLS, promptVersion: version };
}
