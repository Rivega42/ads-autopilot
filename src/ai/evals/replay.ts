import type { EvalCase, EvalRunResult, ScriptedTurn } from './types.js';

import { createMemoryBriefStore, createMemoryClientStore } from '@/ai/evals/memory-store.js';
import {
  handleAnswer,
  startInterview,
  MAX_QUESTIONS,
  type InterviewStep,
  type RunInterviewTurn,
} from '@/ai/onboarding/interview.js';
import { parseDraft } from '@/ai/onboarding/state.js';
import { interviewTurnSchema, personaReplySchema } from '@/ai/onboarding/turn.schema.js';
import type { InterviewTurn } from '@/ai/onboarding/turn.schema.js';
import { loadPrompt, promptHeader, PROMPT_VERSION } from '@/ai/prompt-loader.js';
import { runAgent, type AgentRun, type LlmMessage } from '@/clients/llm/index.js';
import { describeError } from '@/lib/errors.js';

/**
 * Прогон eval-кейса через настоящую машину интервью.
 *
 * Два режима поверх одного и того же кода состояния:
 *  • offline (по умолчанию) — ходы интервьюера берутся из фикстуры. Проверяется всё,
 *    кроме самой модели: разбор ответа, защита от выдуманных цифр, условие завершения.
 *  • live (`AI_EVALS_LIVE=1`) — интервьюер настоящий, а клиента играет вторая модель
 *    по персоне кейса. Только этот режим говорит что-то о качестве промпта, поэтому
 *    им же перезаписываются фикстуры и baseline.
 */

const CLIENT_ID = 'eval-client';

export interface ReplayOptions {
  /** Живая модель вместо записанных ходов. Требует ключей провайдера и стоит денег. */
  live?: boolean;
}

export async function runEvalCase(
  evalCase: EvalCase,
  opts: ReplayOptions = {},
): Promise<EvalRunResult> {
  const store = createMemoryBriefStore();
  // Карточка клиента тоже в памяти: завершённый бриф пишет в неё настройку
  // Метрики, и без подмены прогон постучался бы в настоящий Postgres.
  const clients = createMemoryClientStore().clients;
  const observed: ScriptedTurn[] = [];
  const answers: string[] = [];

  const run = opts.live ? liveRun(observed) : recordedRun(evalCase, observed);
  const answer = opts.live ? await personaAnswerer(evalCase) : scriptedAnswerer(evalCase.answers);
  const maxSteps = opts.live ? MAX_QUESTIONS + 1 : evalCase.recorded.length + 1;

  try {
    let step: InterviewStep = await startInterview(CLIENT_ID, { db: store.db, clients, run });

    for (let i = 0; step.kind === 'question' && i < maxSteps; i += 1) {
      const next = await answer(step.text);
      if (next === null) break;
      answers.push(next);
      step = await handleAnswer(CLIENT_ID, next, { db: store.db, clients, run });
    }

    return {
      caseId: evalCase.id,
      outcome: step.kind,
      turns: observed.length,
      brief: parseDraft(store.get(CLIENT_ID)?.data),
      recorded: observed,
      answers,
    };
  } catch (err) {
    return {
      caseId: evalCase.id,
      outcome: 'error',
      turns: observed.length,
      brief: parseDraft(store.get(CLIENT_ID)?.data),
      recorded: observed,
      answers,
      error: describeError(err),
    };
  }
}

const INTERVIEW_PROMPT = 'onboarding-interview';

function recordedRun(evalCase: EvalCase, observed: ScriptedTurn[]): RunInterviewTurn {
  let index = 0;
  const expectedHeader = promptHeader(INTERVIEW_PROMPT, PROMPT_VERSION[INTERVIEW_PROMPT]);

  return (opts) => {
    // Ход берётся из записи, но системный промпт всё равно обязан быть тем самым:
    // иначе прогон «проверяет» интервью, собранное вообще другим текстом. Совпадение
    // самого текста с записью проверяет отпечаток в фикстуре (`provenance.ts`).
    if (opts.system === undefined || !opts.system.includes(expectedHeader)) {
      return Promise.reject(
        new Error(
          `eval "${evalCase.id}": интервью ушло в модель без промпта ${expectedHeader}. ` +
            'Записанные ходы к такому прогону отношения не имеют.',
        ),
      );
    }

    const scripted = evalCase.recorded[index];
    index += 1;
    if (scripted === undefined) {
      return Promise.reject(
        new Error(
          `eval "${evalCase.id}": в фикстуре ${evalCase.recorded.length} ходов, ` +
            `а интервью попросило ${index}-й. Перезапиши фикстуру.`,
        ),
      );
    }
    observed.push(scripted);
    // Фикстура проходит ту же схему, что и живой ответ: запись, разошедшаяся со
    // схемой хода, — это сломанный eval, а не зелёный прогон.
    return Promise.resolve(fakeRun(interviewTurnSchema.parse(scripted), index));
  };
}

function liveRun(observed: ScriptedTurn[]): RunInterviewTurn {
  return async (opts) => {
    const result = await runAgent(opts);
    observed.push(toScripted(result.data));
    return result;
  };
}

function fakeRun(data: InterviewTurn, index: number): AgentRun<InterviewTurn> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'anthropic',
    model: 'recorded-fixture',
    usage: { tokensIn: 0, tokensOut: 0 },
    costUsd: 0,
    latencyMs: 0,
    cached: true,
    aiRunId: `eval_${index}`,
  };
}

type Answerer = (question: string) => Promise<string | null> | string | null;

function scriptedAnswerer(answers: readonly string[]): Answerer {
  let i = 0;
  return () => {
    const next = answers[i];
    i += 1;
    return next ?? null;
  };
}

/**
 * Клиента играет модель. Отдельное имя агента в `AiRun` (`onboarding-eval-persona`),
 * чтобы стоимость eval-прогонов не смешивалась со стоимостью настоящих интервью.
 */
async function personaAnswerer(evalCase: EvalCase): Promise<Answerer> {
  const prompt = loadPrompt('onboarding-eval-persona', {
    persona: JSON.stringify(evalCase.persona, null, 2),
    style: evalCase.style,
  });

  // История с точки зрения персоны: вопрос интервьюера — это её `user`.
  const history: LlmMessage[] = [];

  return async (question: string): Promise<string> => {
    history.push({ role: 'user', content: question });
    const result = await runAgent({
      agent: 'onboarding-eval-persona',
      task: 'onboarding.interview',
      clientId: null,
      system: prompt.text,
      messages: [...history],
      schema: personaReplySchema,
      schemaName: 'onboarding.persona',
      cache: false,
    });
    history.push({ role: 'assistant', content: result.data.reply });
    return result.data.reply;
  };
}

function toScripted(turn: InterviewTurn): ScriptedTurn {
  return {
    reply: turn.reply,
    asking: turn.asking ?? null,
    updates: turn.updates,
    evidence: turn.evidence,
    done: turn.done,
  };
}
