import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ApprovalDecision } from '@prisma/client';
import type { Bot } from 'grammy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDirectAddMock,
  plannerStubs,
  seedCampaignClient,
  structureOf,
  type DirectAddCall,
  type DirectAddMock,
  type PlannerStubs,
} from './support/campaign-create-seed.js';
import {
  buttonData,
  callbackUpdate,
  commandUpdate,
  createTelegramApiMock,
  TELEGRAM_TEXT_MAX,
  type SentMessage,
  type TelegramApiMock,
} from './support/campaign-entry-telegram.js';
import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY } from './support/config.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { getMessenger, setMessenger } from '@/approval/telegram.js';
import { buildBot } from '@/apps/bot.js';
import { launchCampaign, type CampaignLaunchOptions } from '@/campaigns/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { purgeExpiredIdempotencyKeys } from '@/scheduler/purge.js';

/**
 * Вход в создание кампании: от команды человека до строки в БД (пункт приёмки §9.1).
 *
 * До этого сценария `planCampaigns` и `applyPlan` были написаны и проверены, но
 * позвать их было некому: в боте жила одна команда `/onboarding`, в CLI команды
 * создания не было вовсе. Приёмка §9.1 была недостижима не из-за кода, а из-за
 * отсутствия двери в него.
 *
 * Проверяется поэтому не «функция вернула успех», а весь путь: апдейт Telegram →
 * grammY из `buildBot` → проверки брифа → план → карточка апрува → нажатие ✅ →
 * `Campaigns.add` в кабинете → строки в нашей БД. Обе площадки под msw и отвечают
 * по протоколу (`onUnhandledRequest: 'error'`), оба агента планировщика подменены.
 * Живые здесь только наша БД и наш код.
 *
 * Три вещи, ради которых сценарий существует, помимо самого пути:
 *  • до нажатия человека в кабинет не уходит ничего;
 *  • повторный вход не строит второй план и не создаёт вторую кампанию;
 *  • DRY_RUN уважается входом, и человек видит это до нажатия, а не после.
 */

const BOT_TOKEN = '7000001:campaign-entry-e2e';
const DIRECT_TOKEN = 'campaign-entry-direct-token';
const LANDING = 'https://example.com/kursy';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

function briefOf(over: Partial<ClientBriefData> = {}): ClientBriefData {
  return {
    product: 'Курсы английского для программистов',
    audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
    geo: ['Москва'],
    negativeCities: [],
    usp: ['IT-лексика', 'Преподаватели из индустрии'],
    targetCpaRub: 2_000,
    dailyBudgetRub: 5_000,
    budgetScope: 'per_channel',
    competitors: [{ name: 'Skyeng' }],
    conversionGoals: [{ name: 'заявка с формы' }],
    metrika: null,
    landingUrl: LANDING,
    ...over,
  };
}

let direct: DirectAddMock;
let telegram: TelegramApiMock;
let nextUser = 950_001n;

async function seed(brief: ClientBriefData): Promise<{ clientId: string; tgUserId: bigint }> {
  const tgUserId = nextUser;
  nextUser += 1n;
  const clientId = await seedCampaignClient({
    tgUserId,
    name: `Клиент ${tgUserId}`,
    token: DIRECT_TOKEN,
    brief,
  });
  return { clientId, tgUserId };
}

/** Бот собирается ровно так же, как в проде, — с подменой только агентов модели. */
async function botWith(
  stubs: PlannerStubs,
  over: Partial<CampaignLaunchOptions> = {},
): Promise<Bot> {
  const bot = buildBot(BOT_TOKEN, {
    campaigns: {
      options: {
        plan: { runStructure: stubs.runStructure, runTexts: stubs.runTexts },
        ...over,
      },
    },
  });
  await bot.init();
  return bot;
}

function textsOf(messages: readonly SentMessage[]): string {
  return messages.map((m) => m.text).join('\n---\n');
}

beforeAll(async () => {
  await resetDatabase();
  bootstrapChannels();
  direct = createDirectAddMock({ token: DIRECT_TOKEN });
  telegram = createTelegramApiMock(BOT_TOKEN);
  direct.server.use(...telegram.handlers);
  direct.server.listen({ onUnhandledRequest: 'error' });
  resetYandexRuntimeState();
});

afterAll(async () => {
  direct.server.close();
  setMessenger(null);
  await prisma.$disconnect();
});

describe('клиент без ссылки на сайт узнаёт причину, а не техническую ошибку', () => {
  let answer = '';
  let stubs: PlannerStubs;

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    stubs = plannerStubs(structureOf(1, 3));
    const brief = briefOf();
    delete brief.landingUrl;
    const { tgUserId } = await seed(brief);

    const bot = await botWith(stubs);
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));
    answer = textsOf(telegram.sent);
  });

  it('объяснение написано словами: чего не хватает, почему и что делать', () => {
    expect(answer).toContain('нет ссылки на сайт');
    expect(answer).toContain('Директ');
    expect(answer).toContain('пришли ссылку');
    // Ни кода ошибки, ни имени класса: человеку это чинить не помогает.
    expect(answer).not.toContain('CAMPAIGN_PLAN_EMPTY');
    expect(answer).not.toContain('EmptyPlanError');
  });

  it('отказ случается до первого платного вызова модели и без карточек', () => {
    expect(stubs.structureCalls).toBe(0);
    expect(stubs.textsCalls).toBe(0);
    expect(telegram.cards()).toEqual([]);
    expect(direct.calls).toEqual([]);
  });
});

describe('от команды «запусти» до кампании в кабинете', () => {
  let stubs: PlannerStubs;
  let bot: Bot;
  let clientId = '';
  let tgUserId = 0n;

  /** Снимки состояния после каждого шага: журналы моков между шагами обнуляются. */
  let afterLaunch: SentMessage[] = [];
  let callsBeforePress: DirectAddCall[] = [];
  let firstCard: SentMessage | undefined;
  let secondCard: SentMessage | undefined;
  let callsAfterPress: DirectAddCall[] = [];
  let campaignsAfterPress: {
    name: string;
    externalId: string;
    dailyBudget: unknown;
    adGroups: { name: string; keywords: { phrase: string }[] }[];
  }[] = [];
  let secondPressAnswer = '';
  let approvalsAfterLaunch = 0;
  let chatsAfterLaunch: (string | null)[] = [];
  let callsAfterSecondPress: DirectAddCall[] = [];
  let relaunchWhilePending = '';
  let relaunchCards = 0;
  let structureCallsAfterRelaunch = 0;
  let resubmitMessages: SentMessage[] = [];
  let resubmitCards: SentMessage[] = [];
  let callsAfterRestApprove: DirectAddCall[] = [];
  let creationKeysAfterPurge: { key: string; entityId: string }[] = [];
  let afterPurgeText = '';
  let afterPurgeCards = 0;
  let callsAfterPurge: DirectAddCall[] = [];

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    stubs = plannerStubs(structureOf(2, 3));
    const seeded = await seed(briefOf());
    clientId = seeded.clientId;
    tgUserId = seeded.tgUserId;
    bot = await botWith(stubs);

    // ── шаг 1: человек говорит «запусти» ──────────────────────────────────────
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));
    afterLaunch = [...telegram.sent];
    callsBeforePress = [...direct.calls];
    [firstCard, secondCard] = telegram.cards();
    const issued = await prisma.pendingApproval.findMany({
      where: { clientId },
      select: { chatId: true },
    });
    approvalsAfterLaunch = issued.length;
    chatsAfterLaunch = issued.map((a) => a.chatId);

    // ── шаг 2: нажатие ✅ по первой карточке ──────────────────────────────────
    telegram.reset();
    await bot.handleUpdate(
      callbackUpdate(
        tgUserId,
        buttonData(firstCard?.keyboard, 'Одобрить'),
        firstCard?.messageId ?? 0,
      ),
    );
    callsAfterPress = [...direct.calls];
    // Снимок делается здесь, а не в самой проверке: она выполняется после всех
    // шагов, и к тому моменту в БД будет уже вторая кампания.
    campaignsAfterPress = await prisma.campaign.findMany({
      where: { clientId },
      select: {
        name: true,
        externalId: true,
        dailyBudget: true,
        adGroups: { select: { name: true, keywords: { select: { phrase: true } } } },
      },
    });

    // ── шаг 3: то же нажатие второй раз ───────────────────────────────────────
    telegram.reset();
    direct.reset();
    await bot.handleUpdate(
      callbackUpdate(
        tgUserId,
        buttonData(firstCard?.keyboard, 'Одобрить'),
        firstCard?.messageId ?? 0,
      ),
    );
    secondPressAnswer = telegram.answers.map((a) => a.text).join(' ');
    callsAfterSecondPress = [...direct.calls];

    // ── шаг 4: «запусти» ещё раз, пока вторая карточка ждёт решения ───────────
    telegram.reset();
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));
    relaunchWhilePending = textsOf(telegram.sent);
    relaunchCards = telegram.cards().length;
    structureCallsAfterRelaunch = stubs.structureCalls;

    // ── шаг 5: отказ по второй карточке и повторный «запусти» ─────────────────
    telegram.reset();
    await bot.handleUpdate(
      callbackUpdate(
        tgUserId,
        buttonData(secondCard?.keyboard, 'Отклонить'),
        secondCard?.messageId ?? 0,
      ),
    );
    telegram.reset();
    direct.reset();
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));
    resubmitMessages = [...telegram.sent];
    resubmitCards = telegram.cards();

    // ── шаг 6: одобрение переспрошенной карточки ──────────────────────────────
    const rest = resubmitCards[0];
    telegram.reset();
    direct.reset();
    await bot.handleUpdate(
      callbackUpdate(tgUserId, buttonData(rest?.keyboard, 'Одобрить'), rest?.messageId ?? 0),
    );
    callsAfterRestApprove = [...direct.calls];

    // ── шаг 7: чистка просроченных ключей и «запусти» после неё ───────────────
    // Прогон крона на сто лет вперёд: любой TTL на ключах создания к этому дню
    // истечёт, и это ровно тот день, в который вход переставал видеть созданные
    // кампании и предлагал план заново.
    await purgeExpiredIdempotencyKeys(new Date('2126-01-01T00:00:00.000Z'));
    creationKeysAfterPurge = await prisma.idempotencyKey.findMany({
      where: { scope: 'campaigns.create' },
      select: { key: true, entityId: true },
      orderBy: { key: 'asc' },
    });

    telegram.reset();
    direct.reset();
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));
    afterPurgeText = textsOf(telegram.sent);
    afterPurgeCards = telegram.cards().length;
    callsAfterPurge = [...direct.calls];
  });

  it('человек видит деньги и регионы до того, как появится кнопка', () => {
    const beforeCards = afterLaunch.filter((m) => m.keyboard === undefined);
    const text = textsOf(beforeCards);

    expect(text).toContain('Дневной бюджет: 5 000 ₽');
    expect(text).toContain('Регионы показа: Москва');
    // Раскладка по кампаниям: сумма частей и есть дневной расход.
    expect(text).toContain('3 500 ₽/сут');
    expect(text).toContain('1 500 ₽/сут');
    // Состав плана: сколько групп и фраз реально уедет в кабинет.
    expect(text).toContain('Групп: 2, фраз: 6, объявлений: 2');
    expect(text).toContain('DRY_RUN снят');
  });

  it('до нажатия в кабинет не уходит ничего', () => {
    // Карточки уже висят в чате, план уже собран и сохранён — а в Директе пусто.
    expect(afterLaunch.filter((m) => m.keyboard !== undefined).length).toBeGreaterThan(0);
    expect(callsBeforePress).toEqual([]);
  });

  it('карточек ровно по числу кампаний плана, и каждая — про свою кампанию', () => {
    expect(afterLaunch.filter((m) => m.keyboard !== undefined)).toHaveLength(2);
    expect(firstCard?.text).toContain('Поиск —');
    expect(firstCard?.text).toContain('3 500 ₽/сут');
    expect(secondCard?.text).toContain('РСЯ —');

    expect(approvalsAfterLaunch).toBe(2);
    expect(chatsAfterLaunch.every((chat) => chat === String(tgUserId))).toBe(true);
    // Модель звали ровно один раз на план: стратег и копирайтер.
    expect(stubs.structureCalls).toBe(1);
    expect(stubs.textsCalls).toBe(1);
  });

  it('нажатие ✅ доводит кампанию до кабинета и до нашей БД', () => {
    expect(callsAfterPress.filter((c) => c.requestError !== undefined)).toEqual([]);
    expect(callsAfterPress.flatMap((c) => c.operationErrors)).toEqual([]);
    expect(callsAfterPress.filter((c) => c.service === 'campaigns')).toHaveLength(1);

    const campaigns = campaignsAfterPress;
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.name).toContain('Поиск —');
    expect(campaigns[0]?.externalId).toMatch(/^\d+$/);
    expect(Number(campaigns[0]?.dailyBudget)).toBe(3_500);
    expect(campaigns[0]?.adGroups).toHaveLength(2);
    expect(campaigns[0]?.adGroups.flatMap((g) => g.keywords)).toHaveLength(6);
  });

  it('второе нажатие по той же карточке ничего не создаёт', () => {
    expect(secondPressAnswer).toContain('уже обработана');
    expect(callsAfterSecondPress).toEqual([]);
  });

  it('пока карточка ждёт решения, второй план не собирается', () => {
    expect(relaunchWhilePending).toContain('ждёт твоего решения');
    expect(relaunchWhilePending).toContain('РСЯ —');
    // Главное: модель не позвали второй раз, и лишних карточек не выпустили.
    expect(structureCallsAfterRelaunch).toBe(1);
    expect(relaunchCards).toBe(0);
  });

  it('после отказа повторный «запусти» переспрашивает по тому же плану, не платя модели', () => {
    expect(textsOf(resubmitMessages)).toContain('модель звать не буду');
    expect(stubs.structureCalls).toBe(1);
    expect(stubs.textsCalls).toBe(1);
  });

  it('переспрашивают только про нетронутую кампанию, и счёт — только по ней', () => {
    // Карточка на уже созданную кампанию нажимается впустую (её держит ключ
    // идемпотентности), но человеку она обещала бы списание, которое уже идёт.
    expect(resubmitCards).toHaveLength(1);
    expect(resubmitCards[0]?.text).toContain('РСЯ —');

    const summary = resubmitMessages.find((m) => m.text.startsWith('📊 План кампании'));
    expect(summary?.text).toContain('Общий дневной бюджет: 1 500 ₽/сут');
    expect(summary?.text).toContain('из них уже создано: 1');
    expect(summary?.text).not.toContain('Поиск —');
    expect(summary?.text).not.toContain('3 500 ₽/сут');
    expect(textsOf(resubmitMessages)).toContain('которых ещё нет в кабинете: 1 из 2');
  });

  it('одобрение переспрошенной карточки создаёт ровно вторую кампанию', async () => {
    expect(callsAfterRestApprove.filter((c) => c.requestError !== undefined)).toEqual([]);
    expect(callsAfterRestApprove.filter((c) => c.service === 'campaigns')).toHaveLength(1);

    const campaigns = await prisma.campaign.findMany({
      where: { clientId },
      select: { name: true, dailyBudget: true },
      orderBy: { name: 'asc' },
    });
    expect(campaigns).toHaveLength(2);
    expect(campaigns.map((c) => Number(c.dailyBudget)).sort((a, b) => a - b)).toEqual([
      1_500, 3_500,
    ]);
  });

  it('чистка ключей не стирает память о том, что кампании уже созданы', async () => {
    // Ключ создания отвечает не на «можно ли повторить сейчас», а на «создавалась
    // ли кампания», и срока давности у этого ответа нет. Пока стоял TTL в 90 дней,
    // именно здесь план из января в апреле выглядел нетронутым, переиспользовался
    // целиком, и нажатие ✅ создавало вторую кампанию с тем же именем и бюджетом.
    expect(creationKeysAfterPurge).toHaveLength(2);
    for (const key of creationKeysAfterPurge) expect(key.entityId).toMatch(/^\d+$/);

    expect(afterPurgeText).toContain('уже созданы');
    expect(afterPurgeCards).toBe(0);
    expect(callsAfterPurge).toEqual([]);
    expect(stubs.structureCalls).toBe(1);
    expect(await prisma.campaign.count({ where: { clientId } })).toBe(2);
  });
});

/** Имя кампании складывается из продукта — по нему строки этого клиента видно в журнале. */
const DRY_RUN_PRODUCT = 'Курсы английского с предохранителем';

describe('предохранитель DRY_RUN', () => {
  let messages: SentMessage[] = [];
  let card: SentMessage | undefined;
  let calls: DirectAddCall[] = [];
  let clientId = '';

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    const stubs = plannerStubs(structureOf(1, 3));
    const seeded = await seed(briefOf({ product: DRY_RUN_PRODUCT, dailyBudgetRub: 1_000 }));
    clientId = seeded.clientId;

    const bot = await botWith(stubs, { dryRun: true });
    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    messages = [...telegram.sent];
    card = telegram.cards()[0];

    direct.reset();
    await bot.handleUpdate(
      callbackUpdate(seeded.tgUserId, buttonData(card?.keyboard, 'Одобрить'), card?.messageId ?? 0),
    );
    calls = [...direct.calls];
  });

  it('о режиме сказано до нажатия — и в плане, и в самой карточке', () => {
    expect(textsOf(messages.filter((m) => m.keyboard === undefined))).toContain(
      'DRY_RUN включён: даже после одобрения в кабинет не уйдёт ничего',
    );
    expect(card?.text).toContain('Режим dry-run');
  });

  it('после одобрения в кабинет не уходит ни одного запроса', async () => {
    expect(calls).toEqual([]);
    expect(await prisma.campaign.count({ where: { clientId } })).toBe(0);
  });

  it('намерение при этом записано в журнал изменений', async () => {
    const changes = await prisma.changeLog.findMany({
      where: { action: 'create_campaign', entityId: { contains: DRY_RUN_PRODUCT } },
    });
    expect(changes).toHaveLength(1);
    // В журнале лежит и режим, и то, что ушло бы в кабинет: без второго строка
    // отвечает «человек одобрил», но не отвечает «что именно».
    expect(changes[0]?.newValue).toMatchObject({
      dryRun: true,
      applied: false,
      plan: { action: 'Campaigns.add', adGroups: 1, keywords: 3 },
    });

    // Нажали по одной карточке из двух: вторая обязана остаться нетронутой —
    // человек согласился на поиск, а не на весь план разом.
    const approvals = await prisma.pendingApproval.findMany({
      where: { clientId },
      select: { summary: true, decision: true },
    });
    expect(approvals.map((a) => [a.summary?.includes('Поиск —') ?? false, a.decision])).toEqual(
      expect.arrayContaining([
        [true, ApprovalDecision.APPLIED],
        [false, ApprovalDecision.PENDING],
      ]),
    );
    expect(telegram.edited.map((e) => e.text).join(' ')).toContain('Dry-run');
  });
});

/** Чат, в котором «бота заблокировали»: Telegram отвечает на него 403. */
const BLOCKED_CHAT = '999000111';

describe('карточка, которую Telegram не принял', () => {
  let messages: SentMessage[] = [];
  let approvals: { error: string | null; decision: ApprovalDecision }[] = [];
  let calls: DirectAddCall[] = [];

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    telegram.block(BLOCKED_CHAT);

    const stubs = plannerStubs(structureOf(1, 3));
    const seeded = await seed(briefOf({ product: 'Курсы английского в никуда' }));
    // Карточки уезжают в отдельный чат (так же делает `--chat` в CLI): заблокировав
    // чат самого клиента, мы отняли бы у бота и возможность ответить человеку.
    const bot = await botWith(stubs, { chatId: BLOCKED_CHAT });

    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    messages = [...telegram.sent];
    approvals = await prisma.pendingApproval.findMany({
      where: { clientId: seeded.clientId },
      select: { error: true, decision: true },
    });
    calls = [...direct.calls];
  });

  it('заявка создана, но помечена ошибкой доставки', () => {
    expect(approvals).toHaveLength(2);
    for (const approval of approvals) {
      expect(approval.decision).toBe(ApprovalDecision.PENDING);
      expect(approval.error).toContain('bot was blocked');
    }
    expect(calls).toEqual([]);
  });

  it('человеку сказано, что нажимать нечего, а не «карточек на решение: 2»', () => {
    const text = textsOf(messages);
    expect(text).toContain('Не доставлено карточек: 2');
    expect(text).toContain('Карточек на решение: 0');
  });

  /**
   * Отказы площадки проверяются напрямую через тот же транспорт, которым бот шлёт
   * карточки. Длинное сообщение сценарием не рождается — тексты входа короткие, а
   * бот вдобавок режет их сам (`MESSAGE_MAX_CHARS`), — и именно поэтому предел
   * должен стоять в моке: иначе снятая резка ничем не ловится и уедет в прод.
   */
  it('мок отказывает ровно там же, где площадка', async () => {
    const messenger = getMessenger();
    await expect(messenger.sendMessage('4242', 'x'.repeat(TELEGRAM_TEXT_MAX + 1))).rejects.toThrow(
      'message is too long',
    );
    await expect(messenger.sendMessage('4242', '')).rejects.toThrow('message text is empty');
    await expect(messenger.sendMessage(BLOCKED_CHAT, 'привет')).rejects.toThrow('bot was blocked');
    await expect(
      messenger.sendMessage('4242', 'x'.repeat(TELEGRAM_TEXT_MAX)),
    ).resolves.toBeTruthy();
  });
});

describe('CLI: проверка готовности не тратит ни рубля', () => {
  /**
   * Команда запускается настоящим процессом, а не импортом: `cli.ts` — точка входа,
   * и импорт вызвал бы `main()`. Подмены здесь нет вовсе (msw живёт в другом
   * процессе), поэтому проверяется ровно тот путь, который ничего не тратит:
   * без `--apply` команда только читает БД.
   */
  const cliEnv = {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    CREDENTIALS_ENCRYPTION_KEY: E2E_ENCRYPTION_KEY,
    DRY_RUN: 'true',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  };

  async function cli(
    args: string[],
    envOver: Record<string, string> = {},
  ): Promise<{ stdout: string; code: number }> {
    try {
      const { stdout } = await run('node_modules/.bin/tsx', ['src/apps/cli.ts', ...args], {
        cwd: repoRoot,
        env: { ...cliEnv, ...envOver },
      });
      return { stdout, code: 0 };
    } catch (err) {
      const failure = err as { stdout?: string; code?: number };
      return { stdout: failure.stdout ?? '', code: failure.code ?? 1 };
    }
  }

  /** Клиент с одной кампанией в плане: 350 ₽ на поиск, РСЯ не проходит минимум. */
  async function seedSingleCampaign(product: string): Promise<{
    clientId: string;
    tgUserId: bigint;
    stubs: PlannerStubs;
  }> {
    const stubs = plannerStubs(structureOf(1, 3));
    const seeded = await seed(briefOf({ product, dailyBudgetRub: 500 }));
    return { ...seeded, stubs };
  }

  it('печатает раскладку бюджета, регионы и режим — и честно говорит, что ничего не сделала', async () => {
    const { clientId } = await seed(briefOf());
    const { stdout, code } = await cli(['campaign', '--client', clientId]);

    expect(code).toBe(0);
    expect(stdout).toContain('Раскладка бюджета');
    expect(stdout).toContain('3 500 ₽/сут');
    expect(stdout).toContain('Регионы показа: Москва');
    expect(stdout).toContain('DRY_RUN включён');
    expect(stdout).toContain('Ничего не сделано');
    expect(stdout).toContain('--apply');
  });

  it('клиенту без сайта отказывает словами и ненулевым кодом возврата', async () => {
    const brief = briefOf();
    delete brief.landingUrl;
    const { clientId } = await seed(brief);
    const { stdout, code } = await cli(['campaign', '--client', clientId]);

    expect(code).not.toBe(0);
    expect(stdout).toContain('нет ссылки на сайт');
  });

  it('--apply у клиента без сайта тоже отказывает, не позвав модель', async () => {
    const brief = briefOf();
    delete brief.landingUrl;
    const { clientId } = await seed(brief);
    const { stdout, code } = await cli(['campaign', '--client', clientId, '--apply']);

    // Ветка `--apply` идёт мимо предварительной проверки, поэтому проверяется
    // отдельно: отказ обязан случиться и здесь — до первого платного вызова.
    expect(code).not.toBe(0);
    expect(stdout).toContain('нет ссылки на сайт');
    expect(stdout).not.toContain('Заявок выпущено');
  });

  it('без --client команда не гадает, чей бриф брать', async () => {
    const { stdout, code } = await cli(['campaign']);
    expect(code).not.toBe(0);
    expect(stdout).toContain('--client');
  });

  it('команда есть в справке — иначе её никто не найдёт', async () => {
    const { stdout } = await cli(['--help']);
    expect(stdout).toContain('campaign');
  });

  /**
   * Код возврата отвечает на вопрос «нужно ли человеку что-то починить», а не
   * «готов ли клиент к запуску». Пока ненулевым завершался любой исход, кроме
   * готовности, скрипт, обходящий клиентов, читал штатное «всё уже создано» как
   * поломку — и будил дежурного из-за кампании, которая исправно работает.
   */
  it('«карточка ждёт решения» — не поломка: код 0', async () => {
    telegram.reset();
    direct.reset();
    const { tgUserId, clientId, stubs } = await seedSingleCampaign('Курсы английского в ожидании');
    const bot = await botWith(stubs);
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));

    const { stdout, code } = await cli(['campaign', '--client', clientId]);
    expect(stdout).toContain('ждёт твоего решения');
    expect(code).toBe(0);
  });

  it('«всё уже создано» — не поломка: код 0 и с --apply, и без него', async () => {
    telegram.reset();
    direct.reset();
    const { tgUserId, clientId, stubs } = await seedSingleCampaign('Курсы английского под ключ');
    const bot = await botWith(stubs);
    await bot.handleUpdate(commandUpdate(tgUserId, '/launch'));
    const card = telegram.cards()[0];
    await bot.handleUpdate(
      callbackUpdate(tgUserId, buttonData(card?.keyboard, 'Одобрить'), card?.messageId ?? 0),
    );

    const check = await cli(['campaign', '--client', clientId]);
    expect(check.stdout).toContain('уже созданы');
    expect(check.code).toBe(0);

    const apply = await cli(['campaign', '--client', clientId, '--apply']);
    expect(apply.stdout).toContain('уже созданы');
    expect(apply.stdout).toContain('--new');
    expect(apply.code).toBe(0);
  });

  it('недоставленные карточки — ненулевой код и предупреждение', async () => {
    telegram.reset();
    direct.reset();
    const { clientId, stubs } = await seedSingleCampaign('Курсы английского без телеграма');

    // План собирается здесь, чтобы `--apply` в отдельном процессе переиспользовал
    // готовый и не звал модель: msw живёт в этом процессе, а CLI — в другом.
    const built = await launchCampaign(clientId, {
      plan: { runStructure: stubs.runStructure, runTexts: stubs.runTexts },
      submit: () => Promise.resolve([]),
    });
    expect(built.kind).toBe('submitted');

    // Токена нет — `getMessenger()` отказывает, и это ровно та ветка, ради которой
    // в CLI написан блок с предупреждением: заявка есть, нажать её некому.
    const { stdout, code } = await cli(['campaign', '--client', clientId, '--apply'], {
      TELEGRAM_BOT_TOKEN: '',
    });

    expect(stdout).toContain('НЕ ДОСТАВЛЕНА');
    expect(stdout).toContain('Карточек не доставлено: 1');
    expect(code).not.toBe(0);
  });
});
