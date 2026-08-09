import { BriefStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Настоящий PrismaClient в юнит-тестах не нужен: интервью всегда получает
// хранилище через deps.db, но модуль импортируется в interview.ts.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import type { ClientBriefData } from './brief.schema.js';
import {
  getInterviewState,
  handleAnswer,
  startInterview,
  InterviewConflictError,
  InterviewNotStartedError,
  MAX_QUESTIONS,
  type RunInterviewTurn,
} from './interview.js';
import type { ClientConfigStore } from './metrika-config.js';
import { parseTranscript } from './state.js';
import { interviewTurnSchema, type InterviewTurn } from './turn.schema.js';

import { createMemoryBriefStore, type MemoryBriefStore } from '@/ai/evals/memory-store.js';
import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';

const CLIENT = 'cl1';

const FULL_BRIEF: ClientBriefData = {
  product: 'Курсы английского для айтишников',
  audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
  geo: ['Москва'],
  negativeCities: [],
  usp: ['Преподаватели из IT'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [{ name: 'Skyeng', site: 'https://skyeng.ru' }],
  conversionGoals: [{ name: 'заявка на пробный урок' }],
};

/** Ответ клиента, из которого обе денежные цитаты действительно находятся. */
const MONEY_ANSWER = 'CPA 2000, бюджет 5000 на канал';
const MONEY_EVIDENCE = { targetCpaRub: 'CPA 2000', dailyBudgetRub: 'бюджет 5000' };

interface Scripted {
  reply?: string;
  updates?: Record<string, unknown>;
  evidence?: Record<string, string>;
  done?: boolean;
  asking?: string | null;
}

interface Runner {
  run: RunInterviewTurn;
  calls: RunAgentOptions<InterviewTurn>[];
}

function runner(script: Scripted[], onCall?: () => void): Runner {
  const calls: RunAgentOptions<InterviewTurn>[] = [];
  let i = 0;

  const run: RunInterviewTurn = (opts) => {
    calls.push(opts);
    onCall?.();
    const scripted = script[Math.min(i, script.length - 1)] ?? {};
    i += 1;
    const data = interviewTurnSchema.parse({ reply: `Вопрос ${i}?`, ...scripted });
    const result: AgentRun<InterviewTurn> = {
      data,
      text: JSON.stringify(data),
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usage: { tokensIn: 10, tokensOut: 5 },
      costUsd: 0.001,
      latencyMs: 12,
      cached: false,
      aiRunId: `run_${i}`,
    };
    return Promise.resolve(result);
  };

  return { run, calls };
}

let store: MemoryBriefStore;

beforeEach(() => {
  store = createMemoryBriefStore();
});

describe('startInterview', () => {
  it('создаёт бриф, задаёт первый вопрос и всё записывает в БД', async () => {
    const { run, calls } = runner([{ reply: 'Привет! Что продаём?' }]);

    const step = await startInterview(CLIENT, { db: store.db, run });

    expect(step).toMatchObject({ kind: 'question', text: 'Привет! Что продаём?', resumed: false });
    const row = store.get(CLIENT);
    expect(row?.status).toBe(BriefStatus.IN_PROGRESS);
    expect(parseTranscript(row?.transcript).turns).toHaveLength(1);
    expect(calls[0]?.task).toBe('onboarding.interview');
    expect(calls[0]?.agent).toBe('onboarding');
    expect(calls[0]?.clientId).toBe(CLIENT);
  });

  it('передаёт модели версию промпта и список недостающих полей', async () => {
    const { run, calls } = runner([{}]);
    await startInterview(CLIENT, { db: store.db, run });

    const system = calls[0]?.system ?? '';
    expect(system).toMatch(/^<!-- prompt: onboarding-interview@\d+\.\d+\.\d+ -->/);
    expect(system).toContain('targetCpaRub');
  });

  it('после перезапуска возвращает последний вопрос, не тревожа модель', async () => {
    const first = runner([{ reply: 'Что продаём?' }]);
    await startInterview(CLIENT, { db: store.db, run: first.run });

    const second = runner([{ reply: 'Не должно вызваться' }]);
    const step = await startInterview(CLIENT, { db: store.db, run: second.run });

    expect(step).toMatchObject({ kind: 'question', text: 'Что продаём?', resumed: true });
    expect(second.calls).toHaveLength(0);
  });

  it('на собранном брифе возвращает результат без вызова модели', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Готово', updates: FULL_BRIEF, evidence: MONEY_EVIDENCE, done: true },
    ]);
    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, MONEY_ANSWER, { db: store.db, run });

    const again = runner([{}]);
    const step = await startInterview(CLIENT, { db: store.db, run: again.run });

    expect(step.kind).toBe('complete');
    expect(again.calls).toHaveLength(0);
  });
});

describe('handleAnswer', () => {
  it('требует начатого интервью', async () => {
    const { run } = runner([{}]);
    await expect(handleAnswer(CLIENT, 'привет', { db: store.db, run })).rejects.toBeInstanceOf(
      InterviewNotStartedError,
    );
  });

  it('не принимает пустой ответ', async () => {
    const { run } = runner([{}]);
    await startInterview(CLIENT, { db: store.db, run });
    await expect(handleAnswer(CLIENT, '   ', { db: store.db, run })).rejects.toThrow(
      /Empty answer/,
    );
  });

  it('складывает узнанное в ClientBrief.data и продолжает спрашивать', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Кто клиент?', updates: { product: 'Курсы английского' } },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, 'Курсы английского', { db: store.db, run });

    expect(step.kind).toBe('question');
    expect(store.get(CLIENT)?.data).toMatchObject({ product: 'Курсы английского' });
    if (step.kind === 'question') expect(step.missing).toContain('targetCpaRub');
  });

  it('переживает перезапуск процесса: состояние читается из БД', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Гео?', updates: { product: 'Курсы английского' } },
      { reply: 'Бюджет?', updates: { geo: ['Москва'] } },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, 'Курсы английского', { db: store.db, run });

    // Между ходами процесс «умер»: ни одной переменной не сохранилось,
    // следующий ход читает всё из строки ClientBrief.
    const afterRestart = await handleAnswer(CLIENT, 'Москва', { db: store.db, run });

    expect(afterRestart.kind).toBe('question');
    expect(store.get(CLIENT)?.data).toMatchObject({
      product: 'Курсы английского',
      geo: ['Москва'],
    });
  });

  it('не записывает сумму, которой клиент не называл', async () => {
    const { run } = runner([
      { reply: 'Какой целевой CPA?' },
      {
        reply: 'Понял, ставлю 3500',
        updates: { targetCpaRub: 3_500 },
        evidence: { targetCpaRub: 'в вашей нише обычно 3500' },
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, 'не знаю, сколько обычно?', { db: store.db, run });

    expect(store.get(CLIENT)?.data).not.toHaveProperty('targetCpaRub');
    if (step.kind === 'question') expect(step.missing).toContain('targetCpaRub');
  });

  it('записывает сумму, подтверждённую цитатой из ответа', async () => {
    const { run } = runner([
      { reply: 'Какой целевой CPA?' },
      {
        reply: 'Записал 2000 ₽',
        updates: { targetCpaRub: 2_000 },
        evidence: { targetCpaRub: '2 тыщи' },
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, 'ну, 2 тыщи за заявку', { db: store.db, run });

    expect(store.get(CLIENT)?.data).toMatchObject({ targetCpaRub: 2_000 });
  });

  it('игнорирует done, пока схема брифа не сошлась', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Всё, запускаем!', updates: { product: 'Курсы' }, done: true },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, 'Курсы', { db: store.db, run });

    expect(step.kind).toBe('question');
    expect(store.get(CLIENT)?.status).toBe(BriefStatus.IN_PROGRESS);
  });

  it('завершает интервью, когда собраны все обязательные поля', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Собрал бриф. Стартуем?',
        updates: FULL_BRIEF,
        evidence: MONEY_EVIDENCE,
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, MONEY_ANSWER, { db: store.db, run });

    expect(step.kind).toBe('complete');
    if (step.kind === 'complete') {
      expect(step.brief.targetCpaRub).toBe(2_000);
      expect(step.warnings).toEqual([]);
    }
    const row = store.get(CLIENT);
    expect(row?.status).toBe(BriefStatus.COMPLETE);
    expect(row?.completedAt).toBeInstanceOf(Date);
  });

  it('готовый бриф проставляет цель Метрики в карточке клиента', async () => {
    // До сих пор эти колонки не заполнял никто, поэтому загрузка конверсий из
    // Метрики не включалась ни у одного клиента.
    const updates: Array<Record<string, unknown>> = [];
    const clients = {
      client: {
        update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push({ id: args.where.id, ...args.data });
          return Promise.resolve({ id: args.where.id });
        },
      },
    } as unknown as ClientConfigStore;

    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Собрал бриф. Стартуем?',
        updates: {
          ...FULL_BRIEF,
          conversionGoals: [{ name: 'заявка на пробный урок', metrikaGoalId: 555 }],
        },
        evidence: MONEY_EVIDENCE,
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, clients, run });
    const step = await handleAnswer(CLIENT, MONEY_ANSWER, { db: store.db, clients, run });

    expect(step.kind).toBe('complete');
    expect(updates).toEqual([{ id: CLIENT, metrikaGoalId: 555 }]);
  });

  it('сбой записи конфигурации не отменяет собранный бриф', async () => {
    const clients = {
      client: { update: () => Promise.reject(new Error('нет такой строки')) },
    } as unknown as ClientConfigStore;

    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Собрал бриф.',
        updates: {
          ...FULL_BRIEF,
          conversionGoals: [{ name: 'заявка', metrikaGoalId: 555 }],
        },
        evidence: MONEY_EVIDENCE,
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, clients, run });
    const step = await handleAnswer(CLIENT, MONEY_ANSWER, { db: store.db, clients, run });

    expect(step.kind).toBe('complete');
    expect(store.get(CLIENT)?.status).toBe(BriefStatus.COMPLETE);
  });

  it('возвращает предупреждения по формально валидному брифу', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Готово',
        updates: { ...FULL_BRIEF, dailyBudgetRub: 1_000, targetCpaRub: 3_000 },
        evidence: { targetCpaRub: 'CPA 3000', dailyBudgetRub: 'бюджет 1000' },
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, 'CPA 3000, бюджет 1000', { db: store.db, run });

    expect(step.kind).toBe('complete');
    if (step.kind === 'complete') expect(step.warnings.join(' ')).toContain('CPA');
  });

  it('после исчерпания лимита вопросов зовёт человека, а не выдумывает', async () => {
    const { run } = runner([{ reply: 'Ещё вопрос?' }]);

    let step = await startInterview(CLIENT, { db: store.db, run });
    for (let i = 0; step.kind === 'question' && i < MAX_QUESTIONS + 2; i += 1) {
      step = await handleAnswer(CLIENT, 'не знаю', { db: store.db, run });
    }

    expect(step.kind).toBe('needs_human');
    if (step.kind === 'needs_human') {
      expect(step.askedCount).toBe(MAX_QUESTIONS);
      expect(step.missing).toContain('targetCpaRub');
    }
    expect(store.get(CLIENT)?.status).toBe(BriefStatus.IN_PROGRESS);
  });

  it('отклоняет ход, если строку успел переписать другой процесс', async () => {
    const { run: firstRun } = runner([{ reply: 'Что продаём?' }]);
    await startInterview(CLIENT, { db: store.db, run: firstRun });

    // Второй воркер дописал свой ход, пока этот ходил в модель.
    const { run } = runner([{ reply: 'Ответ на устаревшее состояние' }], () => {
      const row = store.get(CLIENT);
      if (row) row.updatedAt = new Date(row.updatedAt.getTime() + 60_000);
    });

    await expect(handleAnswer(CLIENT, 'Курсы', { db: store.db, run })).rejects.toBeInstanceOf(
      InterviewConflictError,
    );
  });

  it('на собранном брифе возвращает результат и не идёт в модель', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Готово', updates: FULL_BRIEF, evidence: MONEY_EVIDENCE },
    ]);
    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, MONEY_ANSWER, { db: store.db, run });

    const again = runner([{}]);
    const step = await handleAnswer(CLIENT, 'ещё что-то', { db: store.db, run: again.run });

    expect(step.kind).toBe('complete');
    expect(again.calls).toHaveLength(0);
  });
});

describe('getInterviewState', () => {
  it('возвращает null, когда интервью не начиналось', async () => {
    expect(await getInterviewState(CLIENT, { db: store.db })).toBeNull();
  });

  it('отдаёт Telegram-слою прогресс и последний вопрос', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Кто клиент?', updates: { product: 'Курсы' } },
    ]);
    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, 'Курсы', { db: store.db, run });

    const snapshot = await getInterviewState(CLIENT, { db: store.db });

    expect(snapshot).toMatchObject({
      status: BriefStatus.IN_PROGRESS,
      askedCount: 2,
      lastQuestion: 'Кто клиент?',
      brief: null,
    });
    expect(snapshot?.draft.product).toBe('Курсы');
  });
});
