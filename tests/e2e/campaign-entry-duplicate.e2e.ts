import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ApprovalDecision } from '@prisma/client';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDirectAddMock,
  plannerStubs,
  seedCampaignClient,
  structureOf,
  type DirectAddMock,
  type PlannerStubs,
} from './support/campaign-create-seed.js';
import { E2E_DATABASE_URL, E2E_ENCRYPTION_KEY } from './support/config.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { encodeCallbackData } from '@/approval/callback-data.js';
import { processApprovalCallback } from '@/approval/callbacks.js';
import { expireApprovals } from '@/approval/expire.js';
import { setMessenger, type ApprovalMessenger } from '@/approval/telegram.js';
import {
  checkCampaignEntry,
  launchCampaign,
  type CampaignLaunchOptions,
} from '@/campaigns/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';

/**
 * Вторая кампания на те же деньги: путь, который открывался между двумя планами.
 *
 * Сценарий из состязательного ревью, воспроизведённый целиком, потому что каждый
 * его шаг по отдельности выглядит штатно:
 *
 *  1. план P1 из двух кампаний, по первой человек нажал ✅ — кампания в кабинете;
 *  2. вторая карточка истекла по APPROVAL_TIMEOUT_HOURS, решения по ней нет;
 *  3. клиент ответил что-нибудь в переоткрытом интервью — `ClientBrief.updatedAt`
 *     поднимается на каждом `persist`, включая «спасибо»;
 *  4. «запусти» → прошлый план считается устаревшим → собирается P2 из тех же
 *     двух кампаний → карточки на обе.
 *
 * Ключ идемпотентности от второй кампании не спасал: он выводился из `planId`,
 * а у P2 планид другой — значит и адрес операции другой, и ✅ по карточке поиска
 * создавало вторую кампанию с тем же именем и тем же дневным бюджетом.
 *
 * Наружу не уходит ничего: Директ под msw с `onUnhandledRequest: 'error'`, оба
 * агента планировщика подменены, Telegram — заглушка транспорта. Живая только
 * наша БД: именно в ней лежат ключи, по которым система помнит, что уже создано.
 */

const DIRECT_TOKEN = 'campaign-duplicate-direct-token';
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

interface SentCard {
  chatId: string;
  text: string;
  keyboard: InlineKeyboardMarkup | undefined;
}

interface MessengerStub extends ApprovalMessenger {
  sent: SentCard[];
  cards(): SentCard[];
  /** Клиент заблокировал бота: дальше отправка в этот чат отказывает, как Telegram. */
  block(chatId: string): void;
  unblock(chatId: string): void;
  reset(): void;
}

/**
 * Транспорт Telegram заглушкой, а не через msw: этому сценарию от площадки нужно
 * ровно два свойства — «сообщение ушло» и «сообщение не ушло», а протокол Telegram
 * уже проверен в `campaign-entry.e2e.ts`.
 */
function messengerStub(): MessengerStub {
  const sent: SentCard[] = [];
  const blocked = new Set<string>();
  let nextMessageId = 900;

  return {
    sent,
    cards: (): SentCard[] => sent.filter((m) => m.keyboard !== undefined),
    block: (chatId: string): void => void blocked.add(chatId),
    unblock: (chatId: string): void => void blocked.delete(chatId),
    reset: (): void => void (sent.length = 0),
    sendMessage: (chatId, text, replyMarkup) => {
      if (blocked.has(chatId)) {
        return Promise.reject(new Error('Forbidden: bot was blocked by the user'));
      }
      sent.push({ chatId, text, keyboard: replyMarkup });
      nextMessageId += 1;
      return Promise.resolve({ messageId: nextMessageId });
    },
    editMessageText: () => Promise.resolve(),
    answerCallbackQuery: () => Promise.resolve(),
  };
}

let direct: DirectAddMock;
let telegram: MessengerStub;
let nextUser = 960_001n;

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

function launchOptions(stubs: PlannerStubs): CampaignLaunchOptions {
  return { plan: { runStructure: stubs.runStructure, runTexts: stubs.runTexts } };
}

/** Нажатие ✅ тем же путём, которым его делает человек: кнопка карточки. */
async function press(approvalId: string, chatId: string): Promise<string> {
  const outcome = await processApprovalCallback({
    data: encodeCallbackData('approve', approvalId),
    actor: 'клиент',
    chatId,
  });
  return outcome.kind;
}

beforeAll(async () => {
  await resetDatabase();
  bootstrapChannels();
  direct = createDirectAddMock({ token: DIRECT_TOKEN });
  direct.server.listen({ onUnhandledRequest: 'error' });
  telegram = messengerStub();
  setMessenger(telegram);
  resetYandexRuntimeState();
});

afterAll(async () => {
  direct.server.close();
  setMessenger(null);
  await prisma.$disconnect();
});

describe('правка брифа поверх наполовину созданного плана не создаёт кампанию дважды', () => {
  let stubs: PlannerStubs;
  let clientId = '';
  let firstApprovalIds: string[] = [];
  let secondCardNames: string[] = [];
  let secondApprovalIds: string[] = [];
  let readinessNotes: string[] = [];
  let createdNames: string[] = [];
  let campaignsInDb: { name: string; externalId: string }[] = [];
  let structureCalls = 0;

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    stubs = plannerStubs(structureOf(2, 3));
    const seeded = await seed(briefOf());
    clientId = seeded.clientId;
    const chatId = String(seeded.tgUserId);

    // ── шаг 1: «запусти» — план из двух кампаний и две карточки ────────────────
    const first = await launchCampaign(clientId, launchOptions(stubs));
    if (first.kind !== 'submitted') throw new Error(`первый запуск отказал: ${first.kind}`);
    firstApprovalIds = first.approvals.map((a) => a.id);

    // ── шаг 2: ✅ по первой карточке — кампания уезжает в кабинет ──────────────
    const approved = await press(firstApprovalIds[0] ?? '', chatId);
    if (approved !== 'applied') throw new Error(`первая карточка не применилась: ${approved}`);

    // ── шаг 3: вторая карточка истекает, решения по ней так и нет ──────────────
    await expireApprovals(new Date(Date.now() + 4 * 60 * 60 * 1_000));

    // ── шаг 4: клиент отвечает в переоткрытом интервью ─────────────────────────
    // Данные те же: `@updatedAt` поднимается на любом `persist`, даже на «спасибо».
    await prisma.clientBrief.update({
      where: { clientId },
      data: { data: JSON.parse(JSON.stringify(briefOf())) as object },
    });

    // ── шаг 5: «запусти» ещё раз ──────────────────────────────────────────────
    const check = await checkCampaignEntry(clientId);
    readinessNotes = check.kind === 'ready' ? check.notes : [`не ready: ${check.kind}`];

    telegram.reset();
    const second = await launchCampaign(clientId, launchOptions(stubs));
    if (second.kind !== 'submitted') throw new Error(`второй запуск отказал: ${second.kind}`);
    secondApprovalIds = second.approvals.map((a) => a.id);
    secondCardNames = telegram.cards().map((c) => c.text);
    structureCalls = stubs.structureCalls;

    // ── шаг 6: человек нажимает ✅ по всему, что ему предложили ────────────────
    for (const id of secondApprovalIds) await press(id, chatId);

    createdNames = direct.created['campaigns']?.map((c) => String(c['Name'])) ?? [];
    campaignsInDb = await prisma.campaign.findMany({
      where: { clientId },
      select: { name: true, externalId: true },
      orderBy: { name: 'asc' },
    });
  });

  it('карточка выпускается только на кампанию, которой в кабинете ещё нет', () => {
    expect(secondApprovalIds).toHaveLength(1);
    expect(secondCardNames.join('\n')).toContain('РСЯ —');
    expect(secondCardNames.join('\n')).not.toContain('Поиск —');
  });

  it('человеку сказано, что часть кампаний уже создана', () => {
    expect(readinessNotes.join(' ')).toContain('уже создан');
  });

  it('в кабинете ровно две кампании, и ни одна не создана дважды', () => {
    expect(createdNames).toHaveLength(2);
    expect(new Set(createdNames).size).toBe(2);
    expect(campaignsInDb).toHaveLength(2);
    expect(new Set(campaignsInDb.map((c) => c.externalId)).size).toBe(2);
  });

  it('план пересобран по свежему брифу — модель звали второй раз осознанно', () => {
    // Правка брифа обязана давать новый план: старый обещает цифры, о которых
    // клиент уже передоговорился. Дорого здесь не это, а вторая кампания.
    expect(structureCalls).toBe(2);
  });
});

describe('недоставленная карточка не выдаётся за ожидание решения', () => {
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

  let checkKind = '';
  let secondLaunchKind = '';
  let secondLaunchDelivered = 0;
  let pendingRows = 0;
  let repeatStdout = '';
  let repeatCode = 0;

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    const stubs = plannerStubs(structureOf(1, 3));
    // 500 ₽ — денег ровно на одну кампанию: тогда «вторая карточка» может значить
    // только вторую заявку на ту же позицию плана, и спутать её не с чем.
    const seeded = await seed(
      briefOf({ product: 'Курсы английского без телеграма', dailyBudgetRub: 500 }),
    );
    const chatId = String(seeded.tgUserId);

    telegram.block(chatId);
    const first = await launchCampaign(seeded.clientId, launchOptions(stubs));
    if (first.kind !== 'submitted') throw new Error(`первый запуск отказал: ${first.kind}`);
    expect(first.approvals.every((a) => a.error !== null)).toBe(true);

    // Ровно то, что делает скрипт, обходящий клиентов: спрашивает состояние.
    checkKind = (await checkCampaignEntry(seeded.clientId)).kind;

    telegram.unblock(chatId);
    const second = await launchCampaign(seeded.clientId, launchOptions(stubs));
    secondLaunchKind = second.kind;
    secondLaunchDelivered =
      second.kind === 'submitted' ? second.approvals.filter((a) => a.error === null).length : 0;
    pendingRows = await prisma.pendingApproval.count({
      where: { clientId: seeded.clientId, decision: ApprovalDecision.PENDING },
    });

    // Тот же повтор глазами CLI: план уже собран, модель второй раз не нужна,
    // а токена по-прежнему нет — доставка обязана снова провалиться и сказать это.
    const cliSeed = await seed(briefOf({ product: 'Курсы английского для скрипта' }));
    const cliStubs = plannerStubs(structureOf(1, 3));
    const built = await launchCampaign(cliSeed.clientId, {
      ...launchOptions(cliStubs),
      submit: () => Promise.resolve([]),
    });
    if (built.kind !== 'submitted') throw new Error(`план для CLI не собрался: ${built.kind}`);

    await cli(['campaign', '--client', cliSeed.clientId, '--apply'], { TELEGRAM_BOT_TOKEN: '' });
    const repeat = await cli(['campaign', '--client', cliSeed.clientId, '--apply'], {
      TELEGRAM_BOT_TOKEN: '',
    });
    repeatStdout = repeat.stdout;
    repeatCode = repeat.code;
  });

  it('вход не называет ожиданием решения то, чего нет в чате', () => {
    expect(checkKind).not.toBe('awaiting_decision');
  });

  it('повтор выпускает карточку заново, а не вторую на ту же позицию плана', () => {
    expect(secondLaunchKind).toBe('submitted');
    expect(secondLaunchDelivered).toBe(1);
    expect(pendingRows).toBe(1);
  });

  it('скрипт видит отказ, а не успех: повтор с недоставкой возвращает ненулевой код', () => {
    expect(repeatStdout).toContain('НЕ ДОСТАВЛЕНА');
    expect(repeatCode).not.toBe(0);
  });
});
