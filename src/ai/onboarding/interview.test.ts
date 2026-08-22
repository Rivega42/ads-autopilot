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
  LANDING_URL_ATTEMPTS,
  MAX_QUESTIONS,
  NO_LANDING_REPLY,
  QUESTION_BUDGET_REPLY,
  UNCONFIRMED_LANDING_REPLY,
  type InterviewStep,
  type RunInterviewTurn,
} from './interview.js';
import type { ClientConfigStore } from './metrika-config.js';
import { parseTranscript } from './state.js';
import { interviewTurnSchema, type InterviewTurn } from './turn.schema.js';

import {
  createMemoryBriefStore,
  createMemoryClientStore,
  type MemoryBriefRow,
  type MemoryBriefStore,
} from '@/ai/evals/memory-store.js';
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
  metrika: { counterId: 12_345_678, goalId: 555, attribution: 'LASTSIGN' },
  landingUrl: 'https://it-english.ru/trial',
};

/** Тот же бриф у клиента, у которого сайта нет. */
const BRIEF_WITHOUT_SITE: ClientBriefData = (() => {
  const { landingUrl: _landingUrl, ...rest } = FULL_BRIEF;
  return rest;
})();

/** Ответ клиента, из которого все требующие цитаты значения действительно находятся. */
const QUOTED_ANSWER =
  'Сайт it-english.ru/trial, CPA 2000, бюджет 5000 на канал, счётчик 12345678, цель 555';

/** Тот же ответ от клиента без сайта: ссылку в нём взять неоткуда. */
const ANSWER_WITHOUT_SITE = 'CPA 2000, бюджет 5000 на канал, счётчик 12345678, цель 555';
const QUOTED_EVIDENCE = {
  targetCpaRub: 'CPA 2000',
  dailyBudgetRub: 'бюджет 5000',
  // Цитата обязана содержать оба числа блока: и счётчик, и id цели-заявки.
  metrika: 'счётчик 12345678, цель 555',
};

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

type HaltedStep = Extract<InterviewStep, { kind: 'needs_human' }>;

/** Сужение типа шага: у `question` и `complete` нет полей, которые тут проверяются. */
function needsHuman(step: InterviewStep): HaltedStep {
  if (step.kind !== 'needs_human') throw new Error(`ожидалось needs_human, а не ${step.kind}`);
  return step;
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
      { reply: 'Готово', updates: FULL_BRIEF, evidence: QUOTED_EVIDENCE, done: true },
    ]);
    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, QUOTED_ANSWER, { db: store.db, run });

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
        evidence: QUOTED_EVIDENCE,
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, QUOTED_ANSWER, { db: store.db, run });

    expect(step.kind).toBe('complete');
    if (step.kind === 'complete') {
      expect(step.brief.targetCpaRub).toBe(2_000);
      expect(step.warnings).toEqual([]);
    }
    const row = store.get(CLIENT);
    expect(row?.status).toBe(BriefStatus.COMPLETE);
    expect(row?.completedAt).toBeInstanceOf(Date);
  });

  it('готовый бриф проставляет настройку Метрики в карточке клиента', async () => {
    // До сих пор эти колонки не заполнял никто, поэтому загрузка конверсий из
    // Метрики не включалась ни у одного клиента.
    const spy = createMemoryClientStore();

    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Собрал бриф. Стартуем?',
        updates: FULL_BRIEF,
        evidence: QUOTED_EVIDENCE,
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, clients: spy.clients, run });
    const step = await handleAnswer(CLIENT, QUOTED_ANSWER, {
      db: store.db,
      clients: spy.clients,
      run,
    });

    expect(step.kind).toBe('complete');
    expect(spy.updates).toEqual([
      {
        id: CLIENT,
        metrikaCounterId: 12_345_678,
        metrikaGoalId: 555,
        metrikaAttribution: 'LASTSIGN',
      },
    ]);
  });

  it('без ответа про Метрику интервью не заканчивается, даже если модель сказала done', async () => {
    const { metrika: _metrika, ...withoutMetrika } = FULL_BRIEF;
    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Собрал бриф.', updates: withoutMetrika, evidence: QUOTED_EVIDENCE, done: true },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const step = await handleAnswer(CLIENT, QUOTED_ANSWER, { db: store.db, run });

    expect(step.kind).toBe('question');
    if (step.kind === 'question') expect(step.missing).toEqual(['metrika']);
  });

  it('«Метрики нет» завершает бриф и оставляет колонки пустыми', async () => {
    // Штатный путь, а не ошибка: конверсии тогда считает сама площадка.
    const spy = createMemoryClientStore();
    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Собрал бриф.',
        updates: { ...FULL_BRIEF, metrika: null },
        evidence: QUOTED_EVIDENCE,
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, clients: spy.clients, run });
    const step = await handleAnswer(CLIENT, QUOTED_ANSWER, {
      db: store.db,
      clients: spy.clients,
      run,
    });

    expect(step.kind).toBe('complete');
    expect(spy.updates).toEqual([]);
  });

  it('сбой записи конфигурации не отменяет собранный бриф', async () => {
    const clients = {
      client: { update: () => Promise.reject(new Error('нет такой строки')) },
    } as unknown as ClientConfigStore;

    const { run } = runner([
      { reply: 'Что продаём?' },
      { reply: 'Собрал бриф.', updates: FULL_BRIEF, evidence: QUOTED_EVIDENCE, done: true },
    ]);

    await startInterview(CLIENT, { db: store.db, clients, run });
    const step = await handleAnswer(CLIENT, QUOTED_ANSWER, { db: store.db, clients, run });

    expect(step.kind).toBe('complete');
    expect(store.get(CLIENT)?.status).toBe(BriefStatus.COMPLETE);
  });

  it('возвращает предупреждения по формально валидному брифу', async () => {
    const { run } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'Готово',
        updates: { ...FULL_BRIEF, dailyBudgetRub: 1_000, targetCpaRub: 3_000 },
        evidence: { ...QUOTED_EVIDENCE, targetCpaRub: 'CPA 3000', dailyBudgetRub: 'бюджет 1000' },
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    const answer = 'Сайт it-english.ru/trial, CPA 3000, бюджет 1000, счётчик 12345678, цель 555';
    const step = await handleAnswer(CLIENT, answer, {
      db: store.db,
      run,
    });

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

  /**
   * Клиент без сайта (TZ §13.1 + `campaigns/planner.ts`).
   *
   * Объявление Директа обязано куда-то вести: `Ads.add` требует хотя бы один из
   * `Href`, `TurboPageId`, `VCardId`, `BusinessId`, а система умеет только ссылку.
   * Пока ссылка была необязательной, интервью говорило «бриф собран», а отказ
   * прилетал этажом ниже — клиент к тому времени уже потратил своё время и наши
   * деньги на модель.
   */
  describe('клиент без сайта', () => {
    it('не заканчивает интервью, даже если модель сказала done', async () => {
      const { run } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'Собрал бриф. Стартуем?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          done: true,
        },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      const step = await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });

      expect(step.kind).toBe('question');
      if (step.kind === 'question') expect(step.missing).toEqual(['landingUrl']);
      expect(store.get(CLIENT)?.status).toBe(BriefStatus.IN_PROGRESS);
    });

    it('даёт ответить на все три вопроса про ссылку, а не на два', async () => {
      // Счётчик считает заданные вопросы, а не заданные плюс текущий: при
      // LANDING_URL_ATTEMPTS = 3 клиент должен успеть ответить трижды.
      const { run, calls } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'А сайт какой?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          asking: 'landingUrl',
        },
        { reply: 'Пришли ссылку, пожалуйста.', asking: 'landingUrl' },
        { reply: 'Всё-таки нужна ссылка.', asking: 'landingUrl' },
        { reply: 'И ещё раз про ссылку.', asking: 'landingUrl' },
        { reply: 'Этого хода быть не должно.' },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });

      const answers = ['сайта нет', 'нет, только группа в ВК', 'нет и не будет'];
      let step = await handleAnswer(CLIENT, answers[0] ?? '', { db: store.db, run });
      expect(step.kind).toBe('question');
      step = await handleAnswer(CLIENT, answers[1] ?? '', { db: store.db, run });
      expect(step.kind).toBe('question');
      step = await handleAnswer(CLIENT, answers[2] ?? '', { db: store.db, run });

      expect(answers).toHaveLength(LANDING_URL_ATTEMPTS);
      expect(step.kind).toBe('needs_human');
      if (step.kind === 'needs_human') {
        expect(step.missing).toEqual(['landingUrl']);
        expect(step.text).toBe(NO_LANDING_REPLY);
        // Не молчаливое «бриф завершён» и не 25 вопросов до потолка.
        expect(step.askedCount).toBeLessThan(MAX_QUESTIONS);
      }
      // Пять ходов: приветствие и три вопроса про ссылку, на которые клиент ответил.
      // Шестой уже не оплачен.
      expect(calls).toHaveLength(5);
      expect(store.get(CLIENT)?.status).toBe(BriefStatus.IN_PROGRESS);
    });

    it('считает вопросы про ссылку, даже если модель не заполнила asking', async () => {
      // Поле `asking` промпт заполнять не обязан, а на нём держалась вся ветка:
      // без него интервью спрашивало бы про ссылку до потолка в 25 ходов.
      const { run, calls } = runner([
        { reply: 'Что продаём?' },
        { reply: 'А сайт какой?', updates: BRIEF_WITHOUT_SITE, evidence: QUOTED_EVIDENCE },
        { reply: 'Пришли ссылку, пожалуйста.' },
        { reply: 'Всё-таки нужна ссылка.' },
        { reply: 'И ещё раз про ссылку.' },
        { reply: 'Этого хода быть не должно.' },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
      await handleAnswer(CLIENT, 'сайта нет', { db: store.db, run });
      await handleAnswer(CLIENT, 'нет', { db: store.db, run });
      const step = await handleAnswer(CLIENT, 'нет и не будет', { db: store.db, run });

      expect(step.kind).toBe('needs_human');
      expect(calls).toHaveLength(5);
    });

    it('клиенту, который прислал ссылку, не говорит, что сайта нет', async () => {
      // Отказ нашей проверки — не отсутствие сайта. Сказать «Директ не примет
      // объявление» человеку с работающим сайтом значит потерять клиента.
      const { run } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'А сайт какой?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          asking: 'landingUrl',
        },
        { reply: 'Не понял, повтори ссылку.', asking: 'landingUrl' },
        { reply: 'Ещё раз, пожалуйста.', asking: 'landingUrl' },
        { reply: 'Последний раз: какой сайт?', asking: 'landingUrl' },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
      await handleAnswer(CLIENT, 'сайт okna-spb.ru', { db: store.db, run });
      await handleAnswer(CLIENT, 'ну okna-spb.ru же', { db: store.db, run });
      const step = await handleAnswer(CLIENT, 'okna-spb.ru', { db: store.db, run });

      expect(step.kind).toBe('needs_human');
      if (step.kind === 'needs_human') {
        expect(step.text).toBe(UNCONFIRMED_LANDING_REPLY);
        expect(step.text).not.toBe(NO_LANDING_REPLY);
      }
    });

    it('клиенту, назвавшему только почту, говорит правду про сайт', async () => {
      // Почта — не ссылка. Пока домен из неё считался адресом, клиент без сайта
      // слышал «адрес ушёл на проверку человеку» вместо «Директ так не умеет».
      const { run } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'А сайт какой?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          asking: 'landingUrl',
        },
        { reply: 'Пришли ссылку, пожалуйста.', asking: 'landingUrl' },
        { reply: 'Всё-таки нужна ссылка.', asking: 'landingUrl' },
        { reply: 'И ещё раз про ссылку.', asking: 'landingUrl' },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
      await handleAnswer(CLIENT, 'сайта нет', { db: store.db, run });
      await handleAnswer(CLIENT, 'нет, пиши на ivan@mail.ru', { db: store.db, run });
      const step = await handleAnswer(CLIENT, 'нет и не будет', { db: store.db, run });

      expect(step.kind).toBe('needs_human');
      expect(step.text).toBe(NO_LANDING_REPLY);
      expect(parseTranscript(store.get(CLIENT)?.transcript).halted?.reason).toBe('no-landing');
    });

    it('останавливается на done без ссылки, а не досиживает до потолка вопросов', async () => {
      // Модель, упорно возвращающая done при пустой ссылке, не заполнит и `asking`:
      // без остановки интервью дойдёт до MAX_QUESTIONS, двадцать раз повторив
      // клиенту «бриф собран» и столько же раз сходив в модель за деньги.
      const { run, calls } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'А сайт какой?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          asking: 'landingUrl',
        },
        { reply: 'Пришли ссылку, пожалуйста.', asking: 'landingUrl' },
        { reply: 'Всё-таки нужна ссылка.', asking: 'landingUrl' },
        { reply: 'Бриф собран, стартуем!', done: true },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
      await handleAnswer(CLIENT, 'сайта нет', { db: store.db, run });
      await handleAnswer(CLIENT, 'нет', { db: store.db, run });
      const step = await handleAnswer(CLIENT, 'нет и не будет', { db: store.db, run });

      expect(step.kind).toBe('needs_human');
      expect(step.text).toBe(NO_LANDING_REPLY);
      expect(calls).toHaveLength(5);
    });

    it('после перезапуска повторяет тот же ответ, а не последний вопрос модели', async () => {
      const { run } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'А сайт какой?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          asking: 'landingUrl',
        },
        { reply: 'Пришли ссылку, пожалуйста.', asking: 'landingUrl' },
        { reply: 'Всё-таки нужна ссылка.', asking: 'landingUrl' },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
      await handleAnswer(CLIENT, 'сайта нет', { db: store.db, run });
      await handleAnswer(CLIENT, 'нет', { db: store.db, run });
      const stopped = await handleAnswer(CLIENT, 'нет и не будет', { db: store.db, run });

      const resumed = runner([{ reply: 'Этого хода быть не должно.' }]);
      const step = await startInterview(CLIENT, { db: store.db, run: resumed.run });

      expect(resumed.calls).toHaveLength(0);
      expect(step.kind).toBe('needs_human');
      expect(step.text).toBe(stopped.text);
    });

    it('присланная позже ссылка доводит бриф до конца', async () => {
      const { run } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'А сайт какой?',
          updates: BRIEF_WITHOUT_SITE,
          evidence: QUOTED_EVIDENCE,
          asking: 'landingUrl',
        },
        { reply: 'Пришли ссылку.', asking: 'landingUrl' },
        { reply: 'Без ссылки никак.', asking: 'landingUrl' },
        { reply: 'Совсем никак без ссылки.', asking: 'landingUrl' },
        {
          reply: 'Записал, бриф собран.',
          updates: { landingUrl: 'https://it-english.ru/trial' },
          done: true,
        },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
      await handleAnswer(CLIENT, 'сайта нет', { db: store.db, run });
      await handleAnswer(CLIENT, 'нет', { db: store.db, run });
      await handleAnswer(CLIENT, 'нет и не будет', { db: store.db, run });
      const step = await handleAnswer(CLIENT, 'нашёл: it-english.ru/trial', { db: store.db, run });

      expect(step.kind).toBe('complete');
      expect(store.get(CLIENT)?.status).toBe(BriefStatus.COMPLETE);
      expect(store.get(CLIENT)?.data).toMatchObject({
        landingUrl: 'https://it-english.ru/trial',
      });
    });

    it('ссылку, которой клиент не называл, в бриф не пускает', async () => {
      // Обязательное поле модель заполнить хочет, а выдуманный адрес — это чужой
      // сайт, на который клиент купит трафик.
      const { run } = runner([
        { reply: 'Что продаём?' },
        {
          reply: 'Собрал бриф. Стартуем?',
          updates: { ...BRIEF_WITHOUT_SITE, landingUrl: 'https://it-english.ru' },
          evidence: QUOTED_EVIDENCE,
          done: true,
        },
      ]);

      await startInterview(CLIENT, { db: store.db, run });
      const step = await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });

      expect(step.kind).toBe('question');
      expect(store.get(CLIENT)?.data).not.toHaveProperty('landingUrl');
    });
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
      { reply: 'Готово', updates: FULL_BRIEF, evidence: QUOTED_EVIDENCE },
    ]);
    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, QUOTED_ANSWER, { db: store.db, run });

    const again = runner([{}]);
    const step = await handleAnswer(CLIENT, 'ещё что-то', { db: store.db, run: again.run });

    expect(step.kind).toBe('complete');
    expect(again.calls).toHaveLength(0);
  });
});

/**
 * Потолок ходов (задача 3).
 *
 * `needs_human` по исчерпанному бюджету вопросов не оставлял после себя ничего:
 * статус строки прежний, пометки об остановке нет. Каждое следующее сообщение
 * клиента снова уезжало в модель и снова возвращало «нужен человек» — а заодно
 * могло подвинуть набор недостающих полей, на котором держится дедупликация писем
 * Роману. То есть без остановки два фикса гасили друг друга.
 */
describe('после потолка вопросов интервью останавливается, а не спрашивает дальше', () => {
  async function exhausted(): Promise<{ script: Runner; step: HaltedStep }> {
    const script = runner([{ reply: 'Ещё вопрос?' }]);
    let step: InterviewStep = await startInterview(CLIENT, { db: store.db, run: script.run });
    for (let i = 0; step.kind === 'question' && i < MAX_QUESTIONS + 2; i += 1) {
      step = await handleAnswer(CLIENT, 'не знаю', { db: store.db, run: script.run });
    }
    return { script, step: needsHuman(step) };
  }

  it('говорит клиенту про человека, а не задаёт двадцать шестой вопрос', async () => {
    const { step } = await exhausted();

    expect(step.text).toBe(QUESTION_BUDGET_REPLY);
    expect(parseTranscript(store.get(CLIENT)?.transcript).halted?.reason).toBe('question-budget');
  });

  it('следующие сообщения клиента не оплачиваются моделью', async () => {
    const { script, step } = await exhausted();
    const paidTurns = script.calls.length;

    for (const text of ['ладно', 'а что не так?', 'спасибо']) {
      const next = needsHuman(await handleAnswer(CLIENT, text, { db: store.db, run: script.run }));
      // Основание письма Роману — набор недостающих полей: лишний ход модели мог
      // его подвинуть, и дедупликация законно пропустила бы второе письмо.
      expect(next.missing).toEqual(step.missing);
    }

    expect(script.calls).toHaveLength(paidTurns);
    expect(parseTranscript(store.get(CLIENT)?.transcript).turns.map((t) => t.text)).toContain(
      'а что не так?',
    );
  });

  it('ссылка не снимает эту паузу: кончились вопросы, а не сайт', async () => {
    const { script } = await exhausted();
    const paidTurns = script.calls.length;

    const step = await handleAnswer(CLIENT, 'вот сайт okna-spb.ru', {
      db: store.db,
      run: script.run,
    });

    expect(step.kind).toBe('needs_human');
    expect(script.calls).toHaveLength(paidTurns);
  });

  it('пауза читается из БД после перезапуска процесса', async () => {
    await exhausted();

    const fresh = runner([{ reply: 'Этого хода быть не должно.' }]);
    const step = await startInterview(CLIENT, { db: store.db, run: fresh.run });

    expect(fresh.calls).toHaveLength(0);
    expect(step.kind).toBe('needs_human');
    expect(step.text).toBe(QUESTION_BUDGET_REPLY);
    const snapshot = await getInterviewState(CLIENT, { db: store.db });
    expect(snapshot?.haltedReason).toBe('question-budget');
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

/**
 * Брифы, собранные до того, как ссылка стала обязательной (`REQUIRED_BRIEF_FIELDS`).
 *
 * Такая строка помечена COMPLETE и схему проходит — `landingUrl` в ней необязателен.
 * До сих пор это был тупик: `/launch` отвечал `landing_missing` и советовал прислать
 * ссылку в интервью, `/onboarding` отвечал «Бриф уже собран», а свободный текст
 * посредник в боте не пропускал, потому что статус COMPLETE. Инструкция, которую
 * система сама выдала, не работала, и клиент становился ручной задачей.
 */
describe('бриф, собранный до обязательной ссылки', () => {
  function legacyStore(data: unknown = BRIEF_WITHOUT_SITE): MemoryBriefStore {
    const row: MemoryBriefRow = {
      id: 'brief_legacy',
      clientId: CLIENT,
      status: BriefStatus.COMPLETE,
      data: JSON.parse(JSON.stringify(data)) as MemoryBriefRow['data'],
      transcript: null,
      completedAt: new Date('2026-07-01T10:00:00.000Z'),
      updatedAt: new Date('2026-07-01T10:00:00.000Z'),
    };
    return createMemoryBriefStore([row]);
  }

  it('/onboarding спрашивает недостающую ссылку, а не отвечает «Бриф уже собран»', async () => {
    const legacy = legacyStore();
    const { run, calls } = runner([{ reply: 'Пришли ссылку на сайт.', asking: 'landingUrl' }]);

    const step = await startInterview(CLIENT, { db: legacy.db, run });

    expect(step.kind).toBe('question');
    expect(step.text).toBe('Пришли ссылку на сайт.');
    expect(calls).toHaveLength(1);
    // Строка снова открыта — иначе следующий ответ клиента снова пройдёт мимо.
    expect(legacy.get(CLIENT)?.status).toBe(BriefStatus.IN_PROGRESS);
  });

  it('ответ клиента со ссылкой достраивает бриф до конца', async () => {
    const legacy = legacyStore();
    const { run } = runner([
      { reply: 'Пришли ссылку на сайт.', asking: 'landingUrl' },
      {
        reply: 'Записал, бриф собран.',
        updates: { landingUrl: 'https://it-english.ru/trial' },
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: legacy.db, run });
    const step = await handleAnswer(CLIENT, 'it-english.ru/trial', { db: legacy.db, run });

    expect(step.kind).toBe('complete');
    expect(legacy.get(CLIENT)?.status).toBe(BriefStatus.COMPLETE);
    expect(legacy.get(CLIENT)?.data).toMatchObject({ landingUrl: 'https://it-english.ru/trial' });
  });

  it('свободный текст доходит до интервью: слой Telegram видит, что ответа ждут', async () => {
    const legacy = legacyStore();

    const snapshot = await getInterviewState(CLIENT, { db: legacy.db });

    expect(snapshot?.status).toBe(BriefStatus.COMPLETE);
    expect(snapshot?.missing).toEqual(['landingUrl']);
    expect(snapshot?.expectsAnswer).toBe(true);
  });

  it('собранный целиком бриф остаётся собранным', async () => {
    const legacy = legacyStore(FULL_BRIEF);
    const { run, calls } = runner([{ reply: 'Этого хода быть не должно.' }]);

    const step = await startInterview(CLIENT, { db: legacy.db, run });

    expect(step.kind).toBe('complete');
    expect(calls).toHaveLength(0);
    const snapshot = await getInterviewState(CLIENT, { db: legacy.db });
    expect(snapshot?.expectsAnswer).toBe(false);
  });

  it('строку, не проходящую схему, по-прежнему отдаёт человеку', async () => {
    // Дневной бюджет 50 ₽ — это не пробел в брифе, а сломанное значение:
    // спрашивать по кругу тут нечего, чинить должен человек.
    const legacy = legacyStore({ ...FULL_BRIEF, dailyBudgetRub: 50 });
    const { run, calls } = runner([{ reply: 'Этого хода быть не должно.' }]);

    const step = await startInterview(CLIENT, { db: legacy.db, run });

    expect(step.kind).toBe('needs_human');
    expect(calls).toHaveLength(0);
  });
});

/**
 * Остановка после честного отказа (задача 2).
 *
 * `needs_human` не менял статус строки, поэтому каждое следующее сообщение клиента —
 * «ладно», «а без сайта никак?», «спасибо» — снова уезжало в модель, а её ответ тут
 * же заменялся константой. Ходов при этом не двадцать, а сколько угодно.
 */
describe('после остановки интервью не платит за модель', () => {
  async function stopped(): Promise<{ run: RunInterviewTurn; calls: unknown[] }> {
    const { run, calls } = runner([
      { reply: 'Что продаём?' },
      {
        reply: 'А сайт какой?',
        updates: BRIEF_WITHOUT_SITE,
        evidence: QUOTED_EVIDENCE,
        asking: 'landingUrl',
      },
      { reply: 'Пришли ссылку.', asking: 'landingUrl' },
      { reply: 'Без ссылки никак.', asking: 'landingUrl' },
      { reply: 'Совсем никак.', asking: 'landingUrl' },
      {
        reply: 'Записал, бриф собран.',
        updates: { landingUrl: 'https://it-english.ru/trial' },
        done: true,
      },
    ]);

    await startInterview(CLIENT, { db: store.db, run });
    await handleAnswer(CLIENT, ANSWER_WITHOUT_SITE, { db: store.db, run });
    await handleAnswer(CLIENT, 'сайта нет', { db: store.db, run });
    await handleAnswer(CLIENT, 'нет', { db: store.db, run });
    const step = await handleAnswer(CLIENT, 'нет и не будет', { db: store.db, run });
    expect(step.kind).toBe('needs_human');
    return { run, calls };
  }

  it('следующие сообщения клиента не идут в модель', async () => {
    const { run, calls } = await stopped();
    const paidTurns = calls.length;

    for (const text of ['ладно', 'а без сайта никак?', 'спасибо']) {
      const step = await handleAnswer(CLIENT, text, { db: store.db, run });
      expect(step.kind).toBe('needs_human');
    }

    expect(calls).toHaveLength(paidTurns);
  });

  it('повтор почты не снимает паузу и не оплачивается моделью', async () => {
    // «Пиши на почту» — не присланная ссылка: иначе отказ платить за модель
    // обходит любой клиент, который повторяет свой e-mail.
    const { run, calls } = await stopped();
    const paidTurns = calls.length;

    const step = await handleAnswer(CLIENT, 'ну пиши на ivan@mail.ru', { db: store.db, run });

    expect(step.kind).toBe('needs_human');
    expect(calls).toHaveLength(paidTurns);
  });

  it('сообщение в паузу не стирает дату готовности брифа', async () => {
    // Строка с остановкой и статусом COMPLETE сегодня не собирается, но обнулять
    // чужую колонку «на всякий случай» — это тихая порча данных завтра.
    const completedAt = new Date('2026-07-01T10:00:00.000Z');
    const halted = createMemoryBriefStore([
      {
        id: 'brief_halted',
        clientId: CLIENT,
        status: BriefStatus.COMPLETE,
        data: JSON.parse(JSON.stringify(BRIEF_WITHOUT_SITE)) as MemoryBriefRow['data'],
        transcript: {
          version: 1,
          askedCount: 4,
          turns: [{ role: 'assistant', text: NO_LANDING_REPLY, at: completedAt.toISOString() }],
          halted: { reason: 'no-landing', at: completedAt.toISOString() },
        } as MemoryBriefRow['transcript'],
        completedAt,
        updatedAt: completedAt,
      },
    ]);
    const { run, calls } = runner([{ reply: 'Этого хода быть не должно.' }]);

    const step = await handleAnswer(CLIENT, 'ладно', { db: halted.db, run });

    expect(step.kind).toBe('needs_human');
    expect(calls).toHaveLength(0);
    expect(halted.get(CLIENT)?.completedAt).toEqual(completedAt);
  });

  it('записывает эти сообщения — человеку разбирать по расшифровке, а не по логу', async () => {
    const { run } = await stopped();
    await handleAnswer(CLIENT, 'а без сайта никак?', { db: store.db, run });

    const texts = parseTranscript(store.get(CLIENT)?.transcript).turns.map((t) => t.text);
    expect(texts).toContain('а без сайта никак?');
  });

  it('присланная позже ссылка снимает паузу и доводит бриф', async () => {
    const { run, calls } = await stopped();
    const paidTurns = calls.length;

    const step = await handleAnswer(CLIENT, 'нашёл: it-english.ru/trial', { db: store.db, run });

    expect(step.kind).toBe('complete');
    expect(calls).toHaveLength(paidTurns + 1);
    expect(store.get(CLIENT)?.status).toBe(BriefStatus.COMPLETE);
  });
});
