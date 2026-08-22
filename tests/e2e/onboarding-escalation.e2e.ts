import type { Bot, BotError } from 'grammy';
import type { Update } from 'grammy/types';
import { setupServer, type SetupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCampaignClient } from './support/campaign-create-seed.js';
import {
  commandUpdate,
  createTelegramApiMock,
  textUpdate,
  type SentMessage,
  type TelegramApiMock,
} from './support/campaign-entry-telegram.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { parseTranscript, NO_LANDING_REPLY, type RunInterviewTurn } from '@/ai/onboarding/index.js';
import { interviewTurnSchema } from '@/ai/onboarding/turn.schema.js';
import { setMessenger } from '@/approval/telegram.js';
import { buildBot } from '@/apps/bot.js';
import { prisma } from '@/db/prisma.js';

/**
 * Единственный канал до человека и то, что с ним бывает.
 *
 * Право позвать человека захватывается до отправки письма: строка «уже позвали»
 * живёт сутки и гасит все следующие поводы. Пока захват не отпускался на провале
 * доставки, отказ Telegram в чате Романа означал не «письмо задержалось», а
 * «человека не позовут сутки» — при том, что клиенту в тот же миг обещано
 * «дальше подключится человек». Сбой хранилища в этом коде был предусмотрен,
 * сбой доставки — на порядок более частый — нет.
 *
 * Здесь же второе: основание письма обязано различать, почему интервью встало.
 * «Сайта нет» и «сайт назван, записать не смогли» — разные разговоры с разным
 * уровнем в аудите, а набор недостающих полей у них один и тот же.
 *
 * Путь настоящий целиком: апдейт → `buildBot` (тот же grammY и тот же
 * `autoRetry`, что в проде) → Postgres. Подменены только ходы модели и HTTP
 * Telegram — msw отвечает вместо площадки, включая её отказы.
 */

const BOT_TOKEN = '7000004:onboarding-escalation-e2e';
const DIRECT_TOKEN = 'onboarding-escalation-token';

/** Адрес так, как его называет клиент. */
const CLIENT_SITE = 'okna-spb.ru';

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
  /** Сколько ходов оплачено: сообщение в остановленный бриф не должно стоить денег. */
  readonly calls: number;
}

/** Записанные ходы модели: тот же вызов, что делает `runAgent`, но без сети и денег. */
function runner(script: readonly Scripted[]): Script {
  const state = { calls: 0 };
  const run: RunInterviewTurn = () => {
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

/** Четыре хода про ссылку: на четвёртом попытки кончаются и интервью встаёт. */
const ASKS_FOR_LANDING: readonly Scripted[] = [
  { reply: 'Куда вести людей — какой сайт?', asking: 'landingUrl' },
  { reply: 'Пришлите ссылку, пожалуйста.', asking: 'landingUrl' },
  { reply: 'Без ссылки Директ не примет объявление.', asking: 'landingUrl' },
  { reply: 'Последний раз: есть страница?', asking: 'landingUrl' },
];

let telegram: TelegramApiMock;
let server: SetupServer;
let nextUser = 970_001n;

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
async function botWith(script: Script, adminChatId: string): Promise<Bot> {
  const bot = buildBot(BOT_TOKEN, {
    onboarding: { interview: { run: script.run }, adminChatId },
  });
  await bot.init();
  return bot;
}

/** Доставка апдейта так же, как это делает прод: через `bot.errorHandler`. */
async function deliver(bot: Bot, update: Update): Promise<void> {
  await bot.handleUpdate(update).catch((err: unknown) => bot.errorHandler(err as BotError));
}

/** Строки «человека уже позвали» по этому клиенту. */
function claimsOf(clientId: string): Promise<{ key: string }[]> {
  return prisma.idempotencyKey.findMany({
    where: { entityId: clientId, scope: 'onboarding.escalation' },
    select: { key: true },
  });
}

function haltReasonOf(clientId: string): Promise<string | undefined> {
  return prisma.clientBrief
    .findUnique({ where: { clientId }, select: { transcript: true } })
    .then((row) => parseTranscript(row?.transcript).halted?.reason);
}

beforeAll(async () => {
  await resetDatabase();
  telegram = createTelegramApiMock(BOT_TOKEN);
  server = setupServer(...telegram.handlers);
  // Живой сети в сценарии нет вовсе: незапланированный запрос обязан ронять
  // прогон, а не тихо уходить наружу.
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(async () => {
  server.close();
  setMessenger(null);
  await prisma.$disconnect();
});

// ── Блокер: письмо не ушло, а право на него потрачено ────────────────────────

describe('Telegram отказал в чате Романа', () => {
  /** Чат, где бота заблокировали: так же отвечает неверный chat_id и 403 площадки. */
  const ADMIN_BLOCKED = '778001';
  /** Тот же Роман после того, как канал починили: новый chat_id в конфиге. */
  const ADMIN_FIXED = '778002';

  let clientId: string;
  let tgUserId: bigint;
  let deliveredWhileBroken: SentMessage[] = [];
  let clientReplies: SentMessage[] = [];
  let claimsAfterFailure: { key: string }[] = [];
  let errorLog: { scope: string; code: string | null; clientId: string | null }[] = [];
  let deliveredAfterRepair: SentMessage[] = [];
  let paidTurnsAfterRepair = 0;

  beforeAll(async () => {
    telegram.block(ADMIN_BLOCKED);
    ({ clientId, tgUserId } = await seedLegacyClient());

    const script = runner(ASKS_FOR_LANDING);
    const bot = await botWith(script, ADMIN_BLOCKED);

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    for (const text of ['сайта нет', 'нет, только группа в ВК', 'нет и не будет']) {
      await deliver(bot, textUpdate(tgUserId, text));
    }

    deliveredWhileBroken = telegram.sent.filter((m) => m.chatId === ADMIN_BLOCKED);
    clientReplies = telegram.sent.filter((m) => m.chatId === String(tgUserId));
    claimsAfterFailure = await claimsOf(clientId);
    errorLog = await prisma.errorLog.findMany({
      select: { scope: true, code: true, clientId: true },
    });

    // Канал починили — на следующее сообщение клиента человек обязан узнать о нём.
    const repaired = runner([{ reply: 'этого хода быть не должно' }]);
    const fixedBot = await botWith(repaired, ADMIN_FIXED);
    telegram.reset();
    await deliver(bot, textUpdate(tgUserId, 'ну что там?'));
    await deliver(fixedBot, textUpdate(tgUserId, 'алло, есть кто?'));
    deliveredAfterRepair = telegram.sent.filter((m) => m.chatId === ADMIN_FIXED);
    paidTurnsAfterRepair = repaired.calls;
  });

  it('письмо человеку действительно не ушло', () => {
    expect(deliveredWhileBroken).toHaveLength(0);
  });

  it('клиенту при этом ответили на каждое сообщение', () => {
    expect(clientReplies).toHaveLength(4);
    expect(clientReplies.at(-1)?.text).toBe(NO_LANDING_REPLY);
  });

  it('право позвать человека не потрачено на недоставленное письмо', async () => {
    // Иначе сутки любое сообщение клиента гасится как «человека уже позвали», а
    // человека не позвали ни разу.
    expect(claimsAfterFailure).toHaveLength(0);
    expect(await haltReasonOf(clientId)).toBe('no-landing');
  });

  it('несработавший канал оставляет след, который увидят без Telegram', () => {
    // Строка pino — не след: тревоги Роману собираются из `ErrorLog`, и пока в
    // нём пусто, о непозванном человеке не знает вообще никто.
    expect(errorLog).toHaveLength(1);
    expect(errorLog[0]?.clientId).toBe(clientId);
    expect(errorLog[0]?.scope).toContain('onboarding');
    expect(errorLog[0]?.code).toBeTruthy();
  });

  it('починенный канал доносит письмо на следующем же сообщении клиента', () => {
    expect(deliveredAfterRepair).toHaveLength(1);
    expect(deliveredAfterRepair[0]?.text).toContain('Онбординг встал');
    expect(deliveredAfterRepair[0]?.text).toContain(clientId);
  });

  it('повтор письма не оплачен ходом модели', () => {
    expect(paidTurnsAfterRepair).toBe(0);
  });
});

// ── Важное 1: почему интервью встало ─────────────────────────────────────────

describe('интервью встало по другой причине — это другой разговор', () => {
  const ADMIN_CHAT = '778003';

  let adminMessages: SentMessage[] = [];
  let reasonAfterLink: string | undefined;

  beforeAll(async () => {
    const { clientId, tgUserId } = await seedLegacyClient();
    const script = runner([
      ...ASKS_FOR_LANDING,
      // Клиент назвал сайт, а модель вернула чужой домен: записать такое нельзя,
      // но и «сайта нет» про этого клиента говорить уже неправда.
      {
        reply: 'Записал, бриф собран.',
        updates: { landingUrl: 'https://okna-vsem.ru' },
        done: true,
      },
    ]);
    const bot = await botWith(script, ADMIN_CHAT);

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    for (const text of ['сайта нет', 'нет, только группа в ВК', 'нет и не будет']) {
      await deliver(bot, textUpdate(tgUserId, text));
    }
    await deliver(bot, textUpdate(tgUserId, `а, вспомнил, есть ${CLIENT_SITE}`));

    adminMessages = telegram.sent.filter((m) => m.chatId === ADMIN_CHAT);
    reasonAfterLink = await haltReasonOf(clientId);
  });

  it('пауза сменилась с «сайта нет» на «разберётся человек»', () => {
    expect(reasonAfterLink).toBe('unconfirmed-landing');
  });

  it('человека зовут второй раз: набор недостающих полей тот же, ситуация другая', () => {
    // Единственное письмо читалось бы как «у клиента нет сайта, рекламировать
    // нечего», хотя сайт назван и лежит в расшифровке.
    expect(adminMessages).toHaveLength(2);
  });

  it('в письме написано, почему интервью встало', () => {
    expect(adminMessages[0]?.text).toContain('сайт не назван');
    expect(adminMessages[1]?.text).toContain('записать не смогли');
  });
});

// ── Важное 2: город — не сайт ────────────────────────────────────────────────

describe('«г.Москва» в ответе про города не делает клиента владельцем сайта', () => {
  const ADMIN_CHAT = '778004';

  let clientId: string;
  let tgUserId: bigint;
  let script: Script;
  let bot: Bot;
  let lastClientReply: string | undefined;
  let paidTurns = 0;

  beforeAll(async () => {
    ({ clientId, tgUserId } = await seedLegacyClient());
    script = runner([{ reply: 'В каких городах работаете?', asking: 'geo' }, ...ASKS_FOR_LANDING]);
    bot = await botWith(script, ADMIN_CHAT);

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    await deliver(bot, textUpdate(tgUserId, 'работаем по г.Москва и области'));
    for (const text of ['сайта нет', 'нет, только группа в ВК', 'нет и не будет']) {
      await deliver(bot, textUpdate(tgUserId, text));
    }

    lastClientReply = telegram.sent.filter((m) => m.chatId === String(tgUserId)).at(-1)?.text;
    paidTurns = script.calls;
  });

  it('пауза записана как «сайта нет», а не как «адрес ушёл на проверку»', async () => {
    expect(await haltReasonOf(clientId)).toBe('no-landing');
  });

  it('клиенту сказана правда про Директ, а не про ссылку, которую мы видим', () => {
    expect(lastClientReply).toBe(NO_LANDING_REPLY);
  });

  it('следующее упоминание города не снимает паузу и не стоит хода модели', async () => {
    telegram.reset();
    await deliver(bot, textUpdate(tgUserId, 'ну ладно, мы же в г.Москва, может как-то без сайта?'));

    expect(script.calls).toBe(paidTurns);
    expect(await haltReasonOf(clientId)).toBe('no-landing');
  });
});

// ── Важное 3: зона-слово в присланной ссылке ─────────────────────────────────

/**
 * Клиент прислал ссылку — и остался в паузе.
 *
 * Обратная сторона предыдущего сценария и цена того, что «в тексте назван адрес» и
 * «этот токен можно записать в бриф» считались одним и тем же признаком. Зоны
 * `москва`, `дети`, `онлайн` перестали доказывать адрес — правильно для записи и
 * неправильно для разговора: `школа.москва` в ответе на «пришли ссылку сюда»
 * получала в ответ то же самое «пришли ссылку сюда», пауза не снималась, повода
 * позвать человека не возникало, а в единственном письме стояло «сайт не назван» —
 * при том, что сайт назван и лежит в расшифровке.
 *
 * Проверяется поэтому судьба клиента, а не выход разбора: снялась ли пауза,
 * что услышал клиент, что прочитал Роман.
 */
describe('ссылка в зоне-слове снимает паузу и меняет письмо', () => {
  const ADMIN_CHAT = '778005';

  let clientId: string;
  let tgUserId: bigint;
  let script: Script;
  let reasonBefore: string | undefined;
  let reasonAfter: string | undefined;
  let paidBefore = 0;
  let clientReplyAfter: string | undefined;
  let adminMessages: SentMessage[] = [];

  beforeAll(async () => {
    ({ clientId, tgUserId } = await seedLegacyClient());
    script = runner([
      ...ASKS_FOR_LANDING,
      // Адрес в такой зоне модель записала по-своему: в бриф это не уедет, но
      // «сайта нет» про этого клиента говорить уже неправда.
      {
        reply: 'Записал, бриф собран.',
        updates: { landingUrl: 'https://shkola-msk.ru' },
        done: true,
      },
    ]);
    const bot = await botWith(script, ADMIN_CHAT);

    telegram.reset();
    await deliver(bot, commandUpdate(tgUserId, '/onboarding'));
    for (const text of ['сайта нет', 'нет, только группа в ВК', 'нет и не будет']) {
      await deliver(bot, textUpdate(tgUserId, text));
    }
    reasonBefore = await haltReasonOf(clientId);
    paidBefore = script.calls;

    telegram.reset();
    await deliver(bot, textUpdate(tgUserId, 'а, вспомнил, есть школа.москва'));
    reasonAfter = await haltReasonOf(clientId);
    clientReplyAfter = telegram.sent.filter((m) => m.chatId === String(tgUserId)).at(-1)?.text;
    adminMessages = telegram.sent.filter((m) => m.chatId === ADMIN_CHAT);
  });

  it('до ссылки интервью стоит на «сайта нет»', () => {
    expect(reasonBefore).toBe('no-landing');
  });

  it('присланная ссылка снимает паузу, а не повторяет «пришли ссылку»', () => {
    // Пауза снимается ходом модели — значит ответ клиента дошёл до интервью, а не
    // был погашен константой.
    expect(script.calls).toBe(paidBefore + 1);
    expect(clientReplyAfter).not.toContain('Пришли ссылку сюда');
    expect(reasonAfter).not.toBe('no-landing');
  });

  it('основание сменилось на «разберётся человек»', () => {
    expect(reasonAfter).toBe('unconfirmed-landing');
  });

  it('Роман получает новый повод и верный диагноз', () => {
    expect(adminMessages).toHaveLength(1);
    expect(adminMessages[0]?.text).toContain('записать не смогли');
    expect(adminMessages[0]?.text).not.toContain('сайт не назван');
  });
});

// ── Важное 4: имя файла — не сайт ────────────────────────────────────────────

/**
 * «У меня только каталог.pdf» — это ответ «сайта нет».
 *
 * Имя файла проходило по правилу «латинская зона из 2-24 букв», и письмо человеку
 * уверенно ставило неверный диагноз: «адрес назван, но записать не смогли». Дыра
 * старая, но подписи к файлам теперь тоже ответ клиента — таких сообщений в потоке
 * станет больше, а не меньше.
 */
describe('имя файла не делает клиента владельцем сайта', () => {
  const ADMIN_CHAT = '778006';

  let clientId: string;
  let lastClientReply: string | undefined;
  let adminMessages: SentMessage[] = [];

  beforeAll(async () => {
    const seeded = await seedLegacyClient();
    clientId = seeded.clientId;
    const script = runner(ASKS_FOR_LANDING);
    const bot = await botWith(script, ADMIN_CHAT);

    telegram.reset();
    await deliver(bot, commandUpdate(seeded.tgUserId, '/onboarding'));
    for (const text of ['сайта нет', 'у меня только каталог.pdf', 'сайт не делали']) {
      await deliver(bot, textUpdate(seeded.tgUserId, text));
    }

    lastClientReply = telegram.sent
      .filter((m) => m.chatId === String(seeded.tgUserId))
      .at(-1)?.text;
    adminMessages = telegram.sent.filter((m) => m.chatId === ADMIN_CHAT);
  });

  it('пауза записана как «сайта нет»', async () => {
    expect(await haltReasonOf(clientId)).toBe('no-landing');
  });

  it('клиенту сказана правда про Директ', () => {
    expect(lastClientReply).toBe(NO_LANDING_REPLY);
  });

  it('в письме человеку стоит верный диагноз', () => {
    expect(adminMessages).toHaveLength(1);
    expect(adminMessages[0]?.text).toContain('сайт не назван');
    expect(adminMessages[0]?.text).not.toContain('записать не смогли');
  });
});
