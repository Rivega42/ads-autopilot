import type { Provider } from '@prisma/client';

import { loadPrompt } from '@/ai/prompt-loader.js';
import { runAgent, type AgentRun, type RunAgentOptions } from '@/clients/llm/index.js';
import { hintCategories, rulesForRejection } from '@/moderation/rules.js';
import {
  rejectionClassificationSchema,
  type RejectionClassificationDraft,
} from '@/moderation/schema.js';
import {
  CATEGORY_TITLE,
  REJECTION_CATEGORIES,
  type AdText,
  type ClassifiedRejection,
} from '@/moderation/types.js';

/**
 * Шаг 2 из TZ §13.4: причина отказа площадки → категория запрета.
 *
 * Модель здесь занята одним — разбором формулировки, поэтому задача отправлена в
 * `moderation.classify` (дешёвая модель из TASK_MODELS). Всё, что дороже одного
 * решения, — выбор правил под категорию — делает код.
 */

export const CLASSIFIER_AGENT = 'moderation-classifier';

/** Площадка не всегда присылает текст причины. Пустая строка модель только путает. */
const NO_REASON = 'Площадка не указала причину — определи претензию по самому объявлению.';

const EMPTY_FIELD = '—';

export type RunClassifyAgent = (
  opts: RunAgentOptions<RejectionClassificationDraft>,
) => Promise<AgentRun<RejectionClassificationDraft>>;

export interface ClassifyRejectionInput {
  clientId: string;
  channel: Provider;
  /** Причина ровно в том виде, в каком её вернула площадка. */
  reason: string;
  ad: AdText;
}

export interface ClassifyOptions {
  run?: RunClassifyAgent;
}

function categoriesBlock(): string {
  return REJECTION_CATEGORIES.map((code) => `- \`${code}\` — ${CATEGORY_TITLE[code]}`).join('\n');
}

function hintsBlock(reason: string): string {
  const hints = hintCategories(reason);
  if (hints.length === 0) return 'подсказок нет, решай по смыслу';
  return hints.map((code) => `\`${code}\``).join(', ');
}

export async function classifyRejection(
  input: ClassifyRejectionInput,
  opts: ClassifyOptions = {},
): Promise<ClassifiedRejection> {
  const reason = input.reason.trim() === '' ? NO_REASON : input.reason.trim();
  const prompt = loadPrompt('moderation-classify', {
    channel: input.channel,
    reason,
    title: input.ad.title,
    title2: input.ad.title2 ?? EMPTY_FIELD,
    text: input.ad.text,
    hints: hintsBlock(reason),
    categories: categoriesBlock(),
  });

  const run = await (opts.run ?? runAgent)({
    agent: CLASSIFIER_AGENT,
    task: 'moderation.classify',
    clientId: input.clientId,
    system: prompt.text,
    messages: 'Определи категорию отказа.',
    schema: rejectionClassificationSchema,
    schemaName: 'moderation.classification',
  });

  return {
    category: run.data.category,
    confidence: run.data.confidence,
    explanation: run.data.explanation,
    fragments: run.data.fragments ?? [],
    rules: rulesForRejection(run.data.category, input.channel, reason),
    promptVersion: `${prompt.name}@${prompt.version}`,
  };
}
