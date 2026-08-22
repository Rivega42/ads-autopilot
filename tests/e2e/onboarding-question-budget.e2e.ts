import { BriefStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';

import {
  getInterviewState,
  handleAnswer,
  startInterview,
  parseTranscript,
  MAX_QUESTIONS,
  QUESTION_BUDGET_REPLY,
  type InterviewStep,
  type RunInterviewTurn,
} from '@/ai/onboarding/index.js';
import { interviewTurnSchema } from '@/ai/onboarding/turn.schema.js';
import { prisma } from '@/db/prisma.js';

/**
 * Клиент, с которым модель не договорилась за отведённые ходы.
 *
 * Потолок ходов вызывал «нужен человек», но не оставлял следа: строка оставалась
 * той же, пометки об остановке не было, и следующее сообщение клиента снова
 * уезжало в модель. Ходов при этом не двадцать пять, а сколько угодно — и каждый
 * оплаченный. Проверяется на живой БД, потому что вся остановка — это одна
 * Json-колонка: если она не долетела до Postgres, паузы нет.
 *
 * Модель подменена записанным ходом: она здесь ни при чём, проверяется машина
 * состояний.
 */

const STUBBORN_QUESTION = 'А поточнее?';

function runner(): { run: RunInterviewTurn; calls: number } {
  const state = { calls: 0 };
  const run: RunInterviewTurn = (_opts) => {
    state.calls += 1;
    const data = interviewTurnSchema.parse({ reply: STUBBORN_QUESTION });
    return Promise.resolve({
      data,
      text: JSON.stringify(data),
      provider: 'anthropic' as const,
      model: 'e2e-recorded',
      usage: { tokensIn: 0, tokensOut: 0 },
      costUsd: 0,
      latencyMs: 1,
      cached: false,
      aiRunId: null,
    });
  };
  return {
    run,
    get calls() {
      return state.calls;
    },
  };
}

type HaltedStep = Extract<InterviewStep, { kind: 'needs_human' }>;

/** Сужение типа шага: у `question` и `complete` нет полей, которые тут проверяются. */
function needsHuman(step: InterviewStep): HaltedStep {
  if (step.kind !== 'needs_human') throw new Error(`ожидалось needs_human, а не ${step.kind}`);
  return step;
}

let clientId: string;
let script: { run: RunInterviewTurn; calls: number };
let stopped: HaltedStep;
let paidTurns: number;

beforeAll(async () => {
  await resetDatabase();
  const client = await prisma.client.create({
    data: { tgUserId: 960_001n, name: 'Немногословный' },
    select: { id: true },
  });
  clientId = client.id;

  script = runner();
  let step: InterviewStep = await startInterview(clientId, { run: script.run });
  for (let i = 0; step.kind === 'question' && i < MAX_QUESTIONS + 2; i += 1) {
    step = await handleAnswer(clientId, 'не знаю', { run: script.run });
  }
  stopped = needsHuman(step);
  paidTurns = script.calls;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('интервью, упёршееся в потолок ходов', () => {
  it('говорит клиенту про человека, а не задаёт следующий вопрос', () => {
    expect(stopped.kind).toBe('needs_human');
    expect(stopped.text).toBe(QUESTION_BUDGET_REPLY);
    expect(paidTurns).toBe(MAX_QUESTIONS);
  });

  it('остановка долетела до Postgres, а строка осталась незаконченной', async () => {
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { status: true, transcript: true },
    });
    expect(row?.status).toBe(BriefStatus.IN_PROGRESS);
    expect(parseTranscript(row?.transcript).halted?.reason).toBe('question-budget');
  });

  it('следующие сообщения клиента не оплачиваются моделью', async () => {
    for (const text of ['ладно', 'а что не так?', 'вот ещё сайт okna-spb.ru']) {
      const step = needsHuman(await handleAnswer(clientId, text, { run: script.run }));
      // Основание письма Роману — набор недостающих полей. Лишний ход модели мог бы
      // его подвинуть, и дедупликация эскалаций законно пропустила бы новое письмо.
      expect(step.missing).toEqual(stopped.missing);
    }
    expect(script.calls).toBe(paidTurns);

    // Сообщения при этом не потеряны: разбирать это будет человек, и по расшифровке.
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { transcript: true },
    });
    expect(parseTranscript(row?.transcript).turns.map((t) => t.text)).toContain('а что не так?');
  });

  it('пауза читается из БД после перезапуска процесса, а не из памяти', async () => {
    const snapshot = await getInterviewState(clientId);
    expect(snapshot?.haltedReason).toBe('question-budget');
    expect(snapshot?.askedCount).toBe(MAX_QUESTIONS);

    const fresh = runner();
    const step = await startInterview(clientId, { run: fresh.run });
    expect(fresh.calls).toBe(0);
    expect(step.kind).toBe('needs_human');
    expect(step.text).toBe(QUESTION_BUDGET_REPLY);
  });
});
