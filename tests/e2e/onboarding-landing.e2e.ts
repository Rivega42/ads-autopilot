import { BriefStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { plannerStubs, seedCampaignClient, structureOf } from './support/campaign-create-seed.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import {
  getInterviewState,
  handleAnswer,
  startInterview,
  parseTranscript,
  NO_LANDING_REPLY,
  type InterviewStep,
  type RunInterviewTurn,
} from '@/ai/onboarding/index.js';
import { interviewTurnSchema } from '@/ai/onboarding/turn.schema.js';
import { checkCampaignEntry } from '@/campaigns/entry.js';
import { EmptyPlanError, planCampaigns } from '@/campaigns/planner.js';
import { prisma } from '@/db/prisma.js';

/**
 * Ссылка на сайт у брифов, собранных до того, как она стала обязательной.
 *
 * Сценарий проверяет круг, из которого клиент не мог выйти сам: `/launch` отвечал
 * `landing_missing` и советовал прислать ссылку в интервью, `/onboarding` отвечал
 * «Бриф уже собран», а свободный текст до интервью не доходил, потому что строка
 * помечена COMPLETE. Ни один из трёх шагов по отдельности не выглядел сломанным —
 * поэтому проверять их нужно вместе и на живой БД: состояние интервью целиком
 * лежит в Postgres, в двух Json-колонках, и именно там ломается.
 *
 * Модель подменена записанными ходами: платить за интервью, чтобы проверить машину
 * состояний, незачем. Всё остальное настоящее — Prisma, ClientBrief, вход в кампанию.
 */

const CLIENT_SITE = 'окна-спб.рф';
/** Тот же домен, как его возвращает модель: `new URL` приводит его к punycode. */
const MODEL_URL = 'https://xn----7sbe7apelp.xn--p1ai/';

/** Бриф, собранный до того, как ссылка стала обязательной: всё есть, ссылки нет. */
function legacyBrief(): ClientBriefData {
  return {
    product: 'Пластиковые окна и остекление балконов',
    audience: { description: 'Собственники квартир 30-60 лет', ageFrom: 30, ageTo: 60 },
    geo: ['Санкт-Петербург'],
    negativeCities: [],
    usp: ['Монтаж за один день', 'Гарантия 5 лет'],
    targetCpaRub: 2_500,
    dailyBudgetRub: 8_000,
    budgetScope: 'total',
    competitors: [],
    conversionGoals: [{ name: 'заявка на замер' }],
    metrika: null,
  };
}

interface Scripted {
  reply: string;
  asking?: string | null;
  updates?: Record<string, unknown>;
  done?: boolean;
}

/** Записанные ходы модели: тот же вызов, что делает `runAgent`, но без сети и денег. */
function runner(script: readonly Scripted[]): { run: RunInterviewTurn; calls: number } {
  const state = { calls: 0 };
  const run: RunInterviewTurn = (_opts) => {
    const scripted = script[Math.min(state.calls, script.length - 1)];
    state.calls += 1;
    if (scripted === undefined) throw new Error('в сценарии кончились ходы модели');
    const data = interviewTurnSchema.parse(scripted);
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

let nextUser = 950_001n;

async function seedLegacyClient(): Promise<string> {
  const tgUserId = nextUser;
  nextUser += 1n;
  return seedCampaignClient({
    tgUserId,
    name: `Окна ${tgUserId}`,
    token: 'onboarding-landing-e2e-token',
    brief: legacyBrief(),
  });
}

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('бриф без ссылки: круг, из которого клиент не мог выйти', () => {
  let clientId: string;
  let launchBefore: string;
  let started: InterviewStep;
  let finished: InterviewStep;

  beforeAll(async () => {
    clientId = await seedLegacyClient();

    // 1. Клиент просит запуск и слышит: пришли ссылку ответом в интервью.
    launchBefore = (await checkCampaignEntry(clientId)).kind;

    // 2. Он идёт в интервью — и раньше слышал «Бриф уже собран».
    const script = runner([
      { reply: 'Почти всё есть. Куда вести людей — какой сайт?', asking: 'landingUrl' },
      { reply: 'Записал, бриф собран.', updates: { landingUrl: MODEL_URL }, done: true },
    ]);
    started = await startInterview(clientId, { run: script.run });

    // 3. Он присылает ссылку обычным текстом, как ему и сказали.
    finished = await handleAnswer(clientId, `наш сайт ${CLIENT_SITE}`, { run: script.run });
  });

  it('вход в кампанию упирался именно в ссылку', () => {
    expect(launchBefore).toBe('landing_missing');
  });

  it('интервью задаёт недостающий вопрос вместо «Бриф уже собран»', () => {
    expect(started.kind).toBe('question');
    expect(started.text).toContain('сайт');
  });

  it('ссылка из ответа клиента доезжает до строки в Postgres', async () => {
    expect(finished.kind).toBe('complete');

    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { status: true, data: true },
    });
    expect(row?.status).toBe(BriefStatus.COMPLETE);
    expect(row?.data).toMatchObject({ landingUrl: MODEL_URL });
  });

  it('после этого запуск больше не упирается в ссылку', async () => {
    const check = await checkCampaignEntry(clientId);
    expect(check.kind).not.toBe('landing_missing');
    expect(check.kind).toBe('ready');
  });
});

describe('клиент без сайта: пауза переживает перезапуск процесса', () => {
  let clientId: string;
  let stopped: InterviewStep;
  let paidTurns: number;
  let script: { run: RunInterviewTurn; calls: number };

  beforeAll(async () => {
    clientId = await seedLegacyClient();
    script = runner([
      { reply: 'Какой у вас сайт?', asking: 'landingUrl' },
      { reply: 'Пришлите ссылку, пожалуйста.', asking: 'landingUrl' },
      { reply: 'Без ссылки Директ не примет объявление.', asking: 'landingUrl' },
      { reply: 'Последний раз: есть страница?', asking: 'landingUrl' },
      { reply: 'Этого хода быть не должно.' },
    ]);

    await startInterview(clientId, { run: script.run });
    await handleAnswer(clientId, 'сайта нет', { run: script.run });
    // Почта — не ссылка: клиент без сайта обязан услышать про Директ, а не про
    // «адрес ушёл на проверку человеку».
    await handleAnswer(clientId, 'нет, пиши на ivan@gmail.com', { run: script.run });
    stopped = await handleAnswer(clientId, 'нет и не будет', { run: script.run });
    paidTurns = script.calls;
  });

  it('говорит правду вместо молчаливого «бриф собран»', () => {
    expect(stopped.kind).toBe('needs_human');
    expect(stopped.text).toBe(NO_LANDING_REPLY);
  });

  it('следующие сообщения клиента не оплачиваются моделью', async () => {
    for (const text of ['ладно', 'а без сайта никак?', 'пиши на ivan@gmail.com', 'спасибо']) {
      const step = await handleAnswer(clientId, text, { run: script.run });
      expect(step.kind).toBe('needs_human');
    }
    expect(script.calls).toBe(paidTurns);

    // Сообщения при этом не потеряны: разбирать это будет человек, и по расшифровке.
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { transcript: true },
    });
    const transcript = parseTranscript(row?.transcript);
    expect(transcript.turns.map((t) => t.text)).toContain('а без сайта никак?');
    expect(transcript.halted?.reason).toBe('no-landing');
  });

  it('пауза читается из БД после перезапуска процесса, а не из памяти', async () => {
    // Между ходами процесс мог умереть: состояние целиком в Json-колонке.
    const snapshot = await getInterviewState(clientId);
    expect(snapshot?.haltedReason).toBe('no-landing');
    expect(snapshot?.expectsAnswer).toBe(true);

    const fresh = runner([{ reply: 'Этого хода быть не должно.' }]);
    const step = await startInterview(clientId, { run: fresh.run });
    expect(fresh.calls).toBe(0);
    expect(step.kind).toBe('needs_human');
  });

  it('присланная позже ссылка снимает паузу', async () => {
    const withLink = runner([
      { reply: 'Записал, бриф собран.', updates: { landingUrl: MODEL_URL }, done: true },
    ]);
    const step = await handleAnswer(clientId, `нашли: ${CLIENT_SITE}`, { run: withLink.run });

    expect(step.kind).toBe('complete');
    expect(withLink.calls).toBe(1);
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { status: true, data: true },
    });
    expect(row?.status).toBe(BriefStatus.COMPLETE);
    expect(row?.data).toMatchObject({ landingUrl: MODEL_URL });
  });
});

/**
 * Домен из почты клиента.
 *
 * Здесь видно всю цену ошибки, которую юнит-тест показывает только наполовину:
 * бриф помечается COMPLETE, вход в кампанию открывается, и следующий шаг —
 * `Ads.add` с `Href = https://gmail.com/`, то есть купленные клиенту клики на
 * почтовый сервис. Поэтому проверяется не разбор ответа, а строка в Postgres и
 * вход в кампанию.
 */
describe('домен из почты клиента не становится посадочной страницей', () => {
  let clientId: string;
  let step: InterviewStep;

  beforeAll(async () => {
    clientId = await seedLegacyClient();
    const script = runner([
      { reply: 'Куда вести людей — какой сайт?', asking: 'landingUrl' },
      // Адрес модель выдумала: в ответе клиента его нет, а есть его почта.
      {
        reply: 'Записал, бриф собран.',
        updates: { landingUrl: 'https://okna-vsem.ru' },
        done: true,
      },
    ]);

    await startInterview(clientId, { run: script.run });
    step = await handleAnswer(clientId, 'Сайта нет, пиши на ivan@gmail.com', { run: script.run });
  });

  it('интервью не объявляет бриф собранным', () => {
    expect(step.kind).not.toBe('complete');
  });

  it('в строку брифа не уезжает ни выдумка модели, ни домен почты', async () => {
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { status: true, data: true },
    });
    expect(row?.status).toBe(BriefStatus.IN_PROGRESS);
    expect(row?.data).not.toHaveProperty('landingUrl');
  });

  it('вход в кампанию по-прежнему упирается в ссылку', async () => {
    expect((await checkCampaignEntry(clientId)).kind).toBe('landing_missing');
  });
});

/**
 * Группа в ВК — это адрес, и разбираться с ним человеку.
 *
 * Обратная сторона предыдущего сценария: клиенту, который назвал ссылку, нельзя
 * говорить «Директ не примет объявление» — группа в ВК как посадочная страница
 * Директу подходит, а решает это человек, а не наша проверка.
 */
describe('клиент с группой в ВК вместо сайта', () => {
  let stopped: InterviewStep;
  let clientId: string;

  beforeAll(async () => {
    clientId = await seedLegacyClient();
    const script = runner([
      { reply: 'Какой у вас сайт?', asking: 'landingUrl' },
      { reply: 'Пришлите ссылку, пожалуйста.', asking: 'landingUrl' },
      { reply: 'Без ссылки Директ не примет объявление.', asking: 'landingUrl' },
      { reply: 'Последний раз: есть страница?', asking: 'landingUrl' },
    ]);

    await startInterview(clientId, { run: script.run });
    await handleAnswer(clientId, 'сайта нет', { run: script.run });
    await handleAnswer(clientId, 'только группа vk.com/okna_spb', { run: script.run });
    stopped = await handleAnswer(clientId, 'ну нет сайта', { run: script.run });
  });

  it('не говорит клиенту, что сайта у него нет', () => {
    expect(stopped.kind).toBe('needs_human');
    expect(stopped.text).not.toBe(NO_LANDING_REPLY);
  });

  it('пауза записана как «разберётся человек»', async () => {
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { transcript: true },
    });
    expect(parseTranscript(row?.transcript).halted?.reason).toBe('unconfirmed-landing');
  });
});

/**
 * Имя файла вместо сайта: цена ошибки видна в `href`, а не в разборе.
 *
 * Строгая половина разбора («можно ли это записать») к записи подключена не была:
 * `proveLandingUrl` спрашивала только «есть ли эта строка в переписке», и
 * `https://каталог.pdf` от модели проходил как названный клиентом. Дальше — бриф
 * COMPLETE, вход в кампанию открыт, `Ads.add` с `Href = https://каталог.pdf`, и
 * клиент платит за клики в никуда.
 *
 * Поэтому проверяется не вердикт функции, а судьба объявления: план до `href`
 * доходить не должен вовсе.
 */
describe('файл вместо сайта не становится целью показа объявления', () => {
  let clientId: string;
  let step: InterviewStep;

  beforeAll(async () => {
    clientId = await seedLegacyClient();
    const script = runner([
      { reply: 'Куда вести людей — какой сайт?', asking: 'landingUrl' },
      // Модель обернула имя файла в схему и объявила бриф собранным.
      {
        reply: 'Записал, бриф собран.',
        updates: { landingUrl: 'https://каталог.pdf' },
        done: true,
      },
    ]);

    await startInterview(clientId, { run: script.run });
    step = await handleAnswer(clientId, 'сайта у нас нет, есть только каталог.pdf', {
      run: script.run,
    });
  });

  it('интервью не объявляет бриф собранным', () => {
    expect(step.kind).not.toBe('complete');
  });

  it('в строку брифа имя файла не уезжает', async () => {
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { status: true, data: true },
    });
    expect(row?.status).toBe(BriefStatus.IN_PROGRESS);
    expect(row?.data).not.toHaveProperty('landingUrl');
  });

  it('план объявления не строится: ставить в href нечего', async () => {
    const stubs = plannerStubs(structureOf(1, 5));
    await expect(
      planCampaigns(clientId, { runStructure: stubs.runStructure, runTexts: stubs.runTexts }),
    ).rejects.toBeInstanceOf(EmptyPlanError);
    // До модели дело не дошло — платить за план без цели показа не за что.
    expect(stubs.structureCalls).toBe(0);
  });

  it('вход в кампанию по-прежнему упирается в ссылку', async () => {
    expect((await checkCampaignEntry(clientId)).kind).toBe('landing_missing');
  });
});

/**
 * Сайт в зоне-слове: `школа.москва`.
 *
 * Зоны `москва`, `дети`, `онлайн`, `сайт`, `рус` сами по себе адрес не доказывают —
 * иначе «г.Москва» из ответа про города становится сайтом. Но клиент, у которого
 * сайт именно такой, обязан пройти интервью до конца: он присылает ссылку в ответ
 * на прямую просьбу, и слышать в ответ ту же просьбу — это круг без выхода.
 *
 * Проверяется поэтому не разбор строки, а судьба клиента: снялась ли пауза, что
 * лежит в брифе, открылся ли вход в кампанию.
 */
describe('сайт в зоне-слове доводит интервью до конца', () => {
  const SITE = 'школа.москва';
  /** Тот же домен, как его возвращает модель: `new URL` приводит его к punycode. */
  const MODEL_SITE_URL = 'https://xn--80atdl2c.xn--80adxhks/';

  let clientId: string;
  let stopped: InterviewStep;
  let lifted: InterviewStep;

  beforeAll(async () => {
    clientId = await seedLegacyClient();
    const script = runner([
      { reply: 'Какой у вас сайт?', asking: 'landingUrl' },
      { reply: 'Пришлите ссылку, пожалуйста.', asking: 'landingUrl' },
      { reply: 'Без ссылки Директ не примет объявление.', asking: 'landingUrl' },
      { reply: 'Последний раз: есть страница?', asking: 'landingUrl' },
      { reply: 'Записал, бриф собран.', updates: { landingUrl: MODEL_SITE_URL }, done: true },
    ]);

    await startInterview(clientId, { run: script.run });
    await handleAnswer(clientId, 'пока не готов сказать', { run: script.run });
    await handleAnswer(clientId, 'сейчас уточню', { run: script.run });
    stopped = await handleAnswer(clientId, 'не знаю', { run: script.run });
    lifted = await handleAnswer(clientId, `а, вспомнил, есть ${SITE}`, { run: script.run });
  });

  it('до ссылки интервью встаёт на «сайта нет»', () => {
    expect(stopped.kind).toBe('needs_human');
    expect(stopped.text).toBe(NO_LANDING_REPLY);
  });

  it('присланная ссылка снимает паузу, а не повторяет просьбу', () => {
    expect(lifted.kind).toBe('complete');
  });

  it('адрес доезжает до строки в Postgres', async () => {
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { status: true, data: true, transcript: true },
    });
    expect(row?.status).toBe(BriefStatus.COMPLETE);
    expect(row?.data).toMatchObject({ landingUrl: MODEL_SITE_URL });
    expect(parseTranscript(row?.transcript).halted).toBeNull();
  });

  it('вход в кампанию после этого открыт', async () => {
    expect((await checkCampaignEntry(clientId)).kind).toBe('ready');
  });

  it('этот адрес и уезжает в href объявления', async () => {
    // Вторая половина той же проверки: сайт, названный клиентом, обязан доехать
    // до цели показа целиком — иначе «строгая половина» защищала бы клиента,
    // отбирая у него кампанию.
    const stubs = plannerStubs(structureOf(1, 5));
    const plan = await planCampaigns(clientId, {
      runStructure: stubs.runStructure,
      runTexts: stubs.runTexts,
    });
    const hrefs = plan.campaigns.flatMap((c) =>
      c.adGroups.flatMap((g) => g.ads.map((ad) => ad.href)),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    expect([...new Set(hrefs)]).toEqual([MODEL_SITE_URL]);
  });
});
