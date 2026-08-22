import { ApprovalDecision, ApprovalKind, ClientStatus } from '@prisma/client';
import type { Bot, BotError } from 'grammy';
import type { Update } from 'grammy/types';
import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCampaignClient } from './support/campaign-create-seed.js';
import {
  callbackUpdate,
  commandUpdate,
  createTelegramApiMock,
  documentUpdate,
  editedTextUpdate,
  forwardedTextUpdate,
  gameCallbackUpdate,
  groupCommandUpdate,
  groupTextUpdate,
  photoUpdate,
  stickerUpdate,
  textUpdate,
  voiceUpdate,
  type SentMessage,
  type TelegramApiMock,
} from './support/campaign-entry-telegram.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { parseTranscript, type BriefStore, type RunInterviewTurn } from '@/ai/onboarding/index.js';
import { interviewTurnSchema } from '@/ai/onboarding/turn.schema.js';
import { encodeCallbackData } from '@/approval/callback-data.js';
import { setMessenger } from '@/approval/telegram.js';
import { buildBot } from '@/apps/bot.js';
import { prisma } from '@/db/prisma.js';

/**
 * Что бот проглатывает молча.
 *
 * Повод — конкретный случай: адрес сайта в подписи к фотографии. Обработчик слушал
 * `message:text`, у фото текст лежит в `caption`, и такое сообщение не видели ни
 * модель, ни разбор ответа. Клиент, приславший скриншот своего сайта, слышал в
 * ответ тишину, потом тот же вопрос ещё раз, а на третий круг — «без ссылки
 * рекламироваться не получится». Сайт у него при этом был.
 *
 * Но случай — экземпляр класса, поэтому сценарий проверяет весь класс: любое
 * сообщение человека либо доходит до системы, либо получает внятный отказ. Тишина
 * в онбординге дороже отказа: человек читает её как «сломалось» и уходит, а
 * заданный впустую вопрос приближает его к «нужен человек».
 *
 * Путь настоящий: апдейт → `buildBot` (тот же grammY, что в проде) → Postgres.
 * Подменены только ходы модели: проверяется машина, а не качество диалога.
 */

const BOT_TOKEN = '7000002:onboarding-silence-e2e';
const DIRECT_TOKEN = 'onboarding-silence-token';

/** Адрес так, как его пишет человек, и так, как его возвращает модель. */
const CLIENT_SITE = 'окна-спб.рф';
const MODEL_URL = 'https://xn----7sbe7apelp.xn--p1ai/';

/** Бриф, собранный до того, как ссылка стала обязательной: интервью ждёт её ответом. */
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

interface Script {
  run: RunInterviewTurn;
  /** Сколько ходов оплачено: тишина не должна стоить денег, а отказ — тем более. */
  readonly calls: number;
  /** Промпты целиком: по ним видно, дошли ли слова клиента до модели дословно. */
  readonly prompts: string[];
}

/** Записанные ходы модели: тот же вызов, что делает `runAgent`, но без сети и денег. */
function runner(script: readonly Scripted[]): Script {
  const state = { calls: 0 };
  const prompts: string[] = [];
  const run: RunInterviewTurn = (opts) => {
    prompts.push(
      typeof opts.messages === 'string'
        ? opts.messages
        : opts.messages.map((m) => m.content).join('\n'),
    );
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
    get prompts() {
      return prompts;
    },
  };
}

let telegram: TelegramApiMock;
let server: SetupServer;
let nextUser = 960_001n;

async function seedLegacyClient(): Promise<{ clientId: string; tgUserId: bigint }> {
  const tgUserId = nextUser;
  nextUser += 1n;
  const clientId = await seedCampaignClient({
    tgUserId,
    name: `Окна ${tgUserId}`,
    token: DIRECT_TOKEN,
    brief: legacyBrief(),
  });
  return { clientId, tgUserId };
}

/** Бот собирается ровно так же, как в проде, — подменены только ходы модели. */
async function botWith(script: Script): Promise<Bot> {
  const bot = buildBot(BOT_TOKEN, { onboarding: { interview: { run: script.run } } });
  await bot.init();
  return bot;
}

/**
 * Доставка апдейта ровно так, как это делает прод.
 *
 * `bot.handleUpdate` сам `bot.catch` не зовёт: он бросает `BotError`, а вызывающая
 * сторона решает, что с ней делать (@grammyjs/runner: `await bot.errorHandler(error)`).
 * Тест, который зовёт `handleUpdate` голым, проверяет бота без обработчика ошибок —
 * то есть не тот бот, который работает в проде.
 */
async function deliver(bot: Bot, update: Update): Promise<void> {
  await bot.handleUpdate(update).catch((err: unknown) => bot.errorHandler(err as BotError));
}

function textsOf(messages: readonly SentMessage[]): string {
  return messages.map((m) => m.text).join('\n---\n');
}

beforeAll(async () => {
  await resetDatabase();
  telegram = createTelegramApiMock(BOT_TOKEN);
  server = setupServer(...telegram.handlers);
  // Живой сети в сценарии нет вовсе: незапланированный запрос (например, поход в
  // модель мимо подменённых ходов) обязан ронять прогон, а не тихо уходить наружу.
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(async () => {
  server.close();
  setMessenger(null);
  await prisma.$disconnect();
});

// ── Ответ клиента, который лежит не в `text` ─────────────────────────────────

interface Answered {
  /** Что бот спросил до ответа: без этого «ответ дошёл» ничего не значит. */
  asked: string;
  replies: SentMessage[];
  calls: number;
  prompts: string[];
  brief: unknown;
  transcript: unknown;
}

/**
 * Один и тот же круг для разных способов прислать одно и то же: бот спрашивает про
 * сайт, человек отвечает — фотографией с подписью, пересланным сообщением, файлом.
 * Клиент каждый раз новый: после ответа бриф закрывается и ждать нечего.
 */
async function interviewAnswered(answer: (tgUserId: bigint) => Update): Promise<Answered> {
  const script = runner([
    { reply: 'Почти всё есть. Куда вести людей — какой сайт?', asking: 'landingUrl' },
    { reply: 'Записал сайт, бриф собран.', updates: { landingUrl: MODEL_URL }, done: true },
  ]);
  const { clientId, tgUserId } = await seedLegacyClient();
  const bot = await botWith(script);

  telegram.reset();
  await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
  const asked = textsOf(telegram.sent);

  telegram.reset();
  await deliver(bot, answer(tgUserId));

  const row = await prisma.clientBrief.findUnique({
    where: { clientId },
    select: { data: true, transcript: true },
  });
  return {
    asked,
    replies: [...telegram.sent],
    calls: script.calls,
    prompts: [...script.prompts],
    brief: row?.data,
    transcript: row?.transcript,
  };
}

describe('адрес в подписи к фотографии', () => {
  let photo: Answered;

  beforeAll(async () => {
    photo = await interviewAnswered((tgUserId) =>
      photoUpdate(tgUserId, `вот наш сайт ${CLIENT_SITE}, сюда и вести`),
    );
  });

  it('интервью действительно ждало ответа', () => {
    expect(photo.asked).toContain('сайт');
  });

  it('человек получает ответ, а не тишину', () => {
    expect(photo.replies.length).toBeGreaterThan(0);
    expect(textsOf(photo.replies)).toContain('Записал сайт');
  });

  it('подпись доезжает до модели дословно', () => {
    expect(photo.calls).toBe(2);
    expect(photo.prompts.at(-1)).toContain(CLIENT_SITE);
  });

  it('ссылка из подписи оказывается в брифе, а не теряется по дороге', () => {
    expect(photo.brief).toMatchObject({ landingUrl: MODEL_URL });
  });

  it('сама подпись остаётся в расшифровке — разбирать это будет человек', () => {
    const turns = parseTranscript(photo.transcript).turns.map((t) => t.text);
    expect(turns.some((text) => text.includes(CLIENT_SITE))).toBe(true);
  });
});

describe('тот же ответ другими способами', () => {
  let forwarded: Answered;
  let document: Answered;

  beforeAll(async () => {
    forwarded = await interviewAnswered((tgUserId) =>
      forwardedTextUpdate(tgUserId, `сайт компании ${CLIENT_SITE}`),
    );
    document = await interviewAnswered((tgUserId) =>
      documentUpdate(tgUserId, `прайс во вложении, сайт ${CLIENT_SITE}`),
    );
  });

  it('пересланное сообщение — обычный ответ клиента', () => {
    expect(forwarded.calls).toBe(2);
    expect(forwarded.brief).toMatchObject({ landingUrl: MODEL_URL });
  });

  it('подпись к файлу читается так же, как подпись к фото', () => {
    expect(document.calls).toBe(2);
    expect(document.brief).toMatchObject({ landingUrl: MODEL_URL });
    expect(textsOf(document.replies)).toContain('Записал сайт');
  });
});

// ── Что прочитать нельзя ─────────────────────────────────────────────────────

describe('нечитаемое сообщение в середине интервью', () => {
  let voice: SentMessage[] = [];
  let sticker: SentMessage[] = [];
  let silentPhoto: SentMessage[] = [];
  let callsAfterQuestion = 0;
  let callsAtEnd = 0;
  let brief: unknown;

  beforeAll(async () => {
    const script = runner([
      { reply: 'Почти всё есть. Куда вести людей — какой сайт?', asking: 'landingUrl' },
      { reply: 'этого хода быть не должно' },
    ]);
    const { clientId, tgUserId } = await seedLegacyClient();
    const bot = await botWith(script);

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    callsAfterQuestion = script.calls;

    telegram.reset();
    await deliver(bot, voiceUpdate(tgUserId));
    voice = [...telegram.sent];

    telegram.reset();
    await deliver(bot, stickerUpdate(tgUserId));
    sticker = [...telegram.sent];

    telegram.reset();
    await deliver(bot, photoUpdate(tgUserId));
    silentPhoto = [...telegram.sent];

    callsAtEnd = script.calls;
    const row = await prisma.clientBrief.findUnique({
      where: { clientId },
      select: { data: true },
    });
    brief = row?.data;
  });

  it('голосовое получает ответ словами, а не тишину', () => {
    expect(voice).toHaveLength(1);
    expect(textsOf(voice)).toContain('голосов');
  });

  it('стикер тоже получает ответ', () => {
    expect(sticker).toHaveLength(1);
  });

  it('фотография без подписи объясняет, что с ней делать', () => {
    expect(silentPhoto).toHaveLength(1);
    expect(textsOf(silentPhoto)).toContain('текст');
  });

  it('ответ честно говорит, что сообщение не засчитано', () => {
    // Иначе человек уверен, что ответил, и ждёт следующего вопроса.
    for (const replies of [voice, sticker, silentPhoto]) {
      expect(textsOf(replies)).toContain('не записал');
    }
  });

  it('ни одно из них не стоит денег и не двигает бриф', () => {
    expect(callsAtEnd).toBe(callsAfterQuestion);
    expect(brief).not.toHaveProperty('landingUrl');
  });
});

describe('остальные способы остаться без ответа', () => {
  let start: SentMessage[] = [];
  let unknownCommand: SentMessage[] = [];
  let stranger: SentMessage[] = [];
  let paused: SentMessage[] = [];
  let edited: SentMessage[] = [];
  let afterEditCalls = 0;
  let afterEditBrief: unknown;
  let groupCommand: SentMessage[] = [];
  let groupChatter: SentMessage[] = [];
  let dataLessAnswers: string[] = [];
  let expiredAnswers: string[] = [];

  beforeAll(async () => {
    const script = runner([
      { reply: 'Почти всё есть. Куда вести людей — какой сайт?', asking: 'landingUrl' },
      { reply: 'этого хода быть не должно' },
    ]);
    const { clientId, tgUserId } = await seedLegacyClient();
    const bot = await botWith(script);

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    const callsAfterQuestion = script.calls;

    // ── человек, которого в базе нет ──────────────────────────────────────────
    const strangerId = 990_001n;
    telegram.reset();
    await deliver(bot, commandUpdate(strangerId, '/start'));
    start = [...telegram.sent];

    telegram.reset();
    await deliver(bot, commandUpdate(strangerId, '/stats'));
    unknownCommand = [...telegram.sent];

    telegram.reset();
    await deliver(bot, textUpdate(strangerId, 'здравствуйте, хочу рекламу'));
    stranger = [...telegram.sent];

    // ── клиент на паузе: доступа нет, но и молчания быть не должно ────────────
    const { clientId: pausedId, tgUserId: pausedUser } = await seedLegacyClient();
    await prisma.client.update({
      where: { id: pausedId },
      data: { status: ClientStatus.PAUSED },
    });
    telegram.reset();
    await deliver(bot, textUpdate(pausedUser, 'наш сайт okna.ru'));
    paused = [...telegram.sent];

    // ── правка ранее отправленного сообщения ──────────────────────────────────
    telegram.reset();
    await deliver(bot, editedTextUpdate(tgUserId, `сайт ${CLIENT_SITE}`));
    edited = [...telegram.sent];
    afterEditCalls = script.calls - callsAfterQuestion;
    afterEditBrief = (
      await prisma.clientBrief.findUnique({ where: { clientId }, select: { data: true } })
    )?.data;

    // ── групповой чат ────────────────────────────────────────────────────────
    telegram.reset();
    await deliver(bot, groupCommandUpdate(tgUserId, -100_500, '/launch'));
    groupCommand = [...telegram.sent];

    telegram.reset();
    await deliver(bot, groupTextUpdate(tgUserId, -100_500, 'ребята, а что с рекламой?'));
    groupChatter = [...telegram.sent];

    // ── кнопка без callback_data (игровая, чужая раскладка) ───────────────────
    telegram.reset();
    await deliver(bot, gameCallbackUpdate(tgUserId, 4_242));
    dataLessAnswers = telegram.answers.map((a) => a.text);

    // ── кнопка карточки, срок которой истёк ──────────────────────────────────
    const approval = await prisma.pendingApproval.create({
      data: {
        clientId,
        kind: ApprovalKind.BUDGET_CHANGE,
        payload: {
          kind: 'budget_change',
          clientId,
          channel: 'YANDEX_DIRECT',
          reason: 'CPA ниже целевого третий день',
          campaignExternalId: '111',
          campaignName: 'Окна — Поиск',
          before: 5_000,
          after: 6_500,
        },
        summary: 'Бюджет 5 000 → 6 500 ₽',
        chatId: String(tgUserId),
        tgMessageId: 4_243n,
        expiresAt: new Date(Date.now() - 60_000),
        decision: ApprovalDecision.PENDING,
      },
      select: { id: true },
    });
    telegram.reset();
    await deliver(bot, callbackUpdate(tgUserId, encodeCallbackData('approve', approval.id), 4_243));
    expiredAnswers = telegram.answers.map((a) => a.text);
  });

  it('/start отвечает тем, что бот умеет', () => {
    expect(start).toHaveLength(1);
    expect(textsOf(start)).toContain('/onboarding');
  });

  it('незнакомая команда не проваливается в пустоту', () => {
    expect(unknownCommand).toHaveLength(1);
    expect(textsOf(unknownCommand)).toContain('команд');
  });

  it('человеку не из базы говорят, куда идти', () => {
    expect(stranger).toHaveLength(1);
    expect(textsOf(stranger)).toContain('Роман');
  });

  it('клиент на паузе слышит про паузу, а не тишину', () => {
    expect(paused).toHaveLength(1);
    expect(textsOf(paused)).toContain('паузе');
  });

  it('правка старого сообщения объясняет, почему она не ответ', () => {
    // Правка приходит отдельным апдейтом и без привязки к вопросу: засчитывать её
    // ответом — значит вписать в интервью текст, которого человек сейчас не писал.
    expect(edited).toHaveLength(1);
    expect(textsOf(edited)).toContain('новым сообщением');
    expect(afterEditCalls).toBe(0);
    expect(afterEditBrief).not.toHaveProperty('landingUrl');
  });

  it('команда в группе отправляет человека в личку, а не выкладывает бриф при всех', () => {
    expect(groupCommand).toHaveLength(1);
    expect(textsOf(groupCommand)).toContain('личн');
  });

  it('на обычную болтовню в группе бот молчит — и это единственное верное молчание', () => {
    // Бот здесь не адресат: отвечать на каждое сообщение чата значит спамить.
    expect(groupChatter).toEqual([]);
  });

  it('кнопка без callback_data перестаёт крутить индикатор', () => {
    expect(dataLessAnswers).toHaveLength(1);
    expect(dataLessAnswers[0]).not.toBe('');
  });

  it('нажатие по истёкшей карточке объясняет, что срок вышел', () => {
    expect(expiredAnswers).toHaveLength(1);
    expect(expiredAnswers[0]).toContain('истёк');
  });
});

describe('сбой внутри обработчика', () => {
  let replies: SentMessage[] = [];

  beforeAll(async () => {
    // Единственная оставшаяся дорога к тишине: исключение по пути. `bot.catch`
    // писал в лог и на этом заканчивал — человек не получал ничего. Ломается
    // чтение состояния интервью, потому что это первый поход в БД после опознания
    // клиента, и именно так выглядит потерянное соединение в проде.
    const script = runner([{ reply: 'этого хода быть не должно' }]);
    const brokenDb = {
      clientBrief: {
        findUnique: (): Promise<never> => Promise.reject(new Error('соединение с БД потеряно')),
      },
    } as unknown as BriefStore;

    const { tgUserId } = await seedLegacyClient();
    const bot = buildBot(BOT_TOKEN, {
      onboarding: { interview: { run: script.run, db: brokenDb } },
    });
    await bot.init();

    telegram.reset();
    await deliver(bot, textUpdate(tgUserId, `наш сайт ${CLIENT_SITE}`));
    replies = [...telegram.sent];
  });

  it('человек узнаёт о сбое, а не остаётся с тишиной', () => {
    expect(replies).toHaveLength(1);
    expect(textsOf(replies)).toContain('сломалось');
  });
});

describe('человека зовут один раз, а не на каждое сообщение клиента', () => {
  /** Чат Романа: в проде это `TELEGRAM_ADMIN_CHAT_ID`, здесь — свой, чтобы его было видно. */
  const ADMIN_CHAT = '777000';

  let adminMessages: SentMessage[] = [];
  let clientMessages: SentMessage[] = [];
  let paidTurns = 0;
  let claims: { entityId: string; scope: string }[] = [];

  beforeAll(async () => {
    // Интервью упирается в ссылку и после трёх попыток встаёт. Дальше клиент пишет
    // то, что пишет живой человек в такой ситуации, — и каждое его сообщение
    // возвращает `needs_human`, то есть повод отправить Роману одно и то же письмо.
    const script = runner([
      { reply: 'Куда вести людей — какой сайт?', asking: 'landingUrl' },
      { reply: 'Пришлите ссылку, пожалуйста.', asking: 'landingUrl' },
      { reply: 'Без ссылки Директ не примет объявление.', asking: 'landingUrl' },
      { reply: 'Последний раз: есть страница?', asking: 'landingUrl' },
      { reply: 'этого хода быть не должно' },
    ]);
    const { clientId, tgUserId } = await seedLegacyClient();
    const bot = buildBot(BOT_TOKEN, {
      onboarding: { interview: { run: script.run }, adminChatId: ADMIN_CHAT },
    });
    await bot.init();

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    for (const text of ['сайта нет', 'нет, только группа в ВК', 'нет и не будет']) {
      await deliver(bot, textUpdate(tgUserId, text));
    }
    for (const text of ['ладно', 'а без сайта никак?', 'спасибо']) {
      await deliver(bot, textUpdate(tgUserId, text));
    }
    // И завтрашний заход в интервью — он тоже отвечает «нужен человек».
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));

    adminMessages = telegram.sent.filter((m) => m.chatId === ADMIN_CHAT);
    clientMessages = telegram.sent.filter((m) => m.chatId === String(tgUserId));
    paidTurns = script.calls;
    claims = await prisma.idempotencyKey.findMany({
      where: { entityId: clientId },
      select: { entityId: true, scope: true },
    });
  });

  it('Роман получает одно письмо на одну застрявшую ситуацию', () => {
    // Пять писем подряд означают, что настоящие эскалации в этом потоке утонут.
    expect(adminMessages).toHaveLength(1);
    expect(adminMessages[0]?.text).toContain('Онбординг встал');
  });

  it('клиент при этом отвечен на каждое своё сообщение', () => {
    // Дедупликация письма человеку не должна превратиться в молчание клиенту.
    expect(clientMessages).toHaveLength(8);
  });

  it('повторы не стоят ходов модели', () => {
    expect(paidTurns).toBe(4);
  });

  it('«человека уже позвали» лежит в БД, а не в памяти процесса', () => {
    // Бот перезапускается и может работать в нескольких экземплярах.
    expect(claims).toEqual([{ entityId: expect.any(String), scope: 'onboarding.escalation' }]);
  });
});
