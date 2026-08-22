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
  commandUpdate,
  createTelegramApiMock,
  type SentMessage,
  type TelegramApiMock,
} from './support/campaign-entry-telegram.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { expireApprovals, STUCK_APPROVAL_MINUTES } from '@/approval/index.js';
import { setMessenger } from '@/approval/telegram.js';
import { buildBot } from '@/apps/bot.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';

/**
 * Заявка, по которой человек уже сказал «да», обязана дойти до конца — сама.
 *
 * Сценарий существует из-за дыры, найденной во входе в создание кампании: вход
 * считает жёстким стопом любую заявку в APPROVED или APPLYING, а из APPROVED
 * заявку никто не выводил. Процесс, умерший между нажатием кнопки и началом
 * применения, оставлял строку в APPROVED навсегда: кнопки отвечают «уже
 * обработана», крон экспирации смотрит только PENDING, — и `/launch` до конца
 * времён отвечал «план ждёт твоего решения» по решению, которое уже принято.
 *
 * Поэтому проверяется не функция, а весь круг: команда человека → карточка →
 * оборванное применение → крон `expire-approvals` → кампания в кабинете →
 * снова открытый вход. Директ и Telegram под msw и отвечают по протоколу,
 * агенты планировщика подменены; живые здесь наша БД и наш код.
 *
 * Вторая половина файла — про PENDING с истёкшим сроком: вход считает такую
 * заявку неживой, и надо было убедиться, что её действительно кто-то разбирает,
 * а не «считает неживой и оставляет лежать».
 */

const BOT_TOKEN = '7000002:approval-stuck-e2e';
const DIRECT_TOKEN = 'approval-stuck-direct-token';
const LANDING = 'https://example.com/kursy';

function briefOf(over: Partial<ClientBriefData> = {}): ClientBriefData {
  return {
    product: 'Курсы английского для программистов',
    audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
    geo: ['Москва'],
    negativeCities: [],
    usp: ['IT-лексика', 'Преподаватели из индустрии'],
    targetCpaRub: 2_000,
    // 900 ₽/сут — ровно на одну кампанию: доля РСЯ (30%) не дотягивает до минимума
    // Директа в 300 ₽, и план состоит из одной карточки. Сценарий про одну заявку,
    // и вторая, живая, карточка перекрывала бы собой проверяемый стоп.
    dailyBudgetRub: 900,
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

async function botWith(stubs: PlannerStubs): Promise<Bot> {
  const bot = buildBot(BOT_TOKEN, {
    campaigns: {
      options: { plan: { runStructure: stubs.runStructure, runTexts: stubs.runTexts } },
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

describe('процесс умер после нажатия ✅ — заявка не остаётся висеть', () => {
  let clientId = '';
  let approvalId = '';
  let blockedAnswer = '';
  let cardsWhileBlocked = 0;
  let callsWhileBlocked: DirectAddCall[] = [];
  let cronResult: Awaited<ReturnType<typeof expireApprovals>> | undefined;
  let afterCron: SentMessage[] = [];
  let editedAfterCron = '';
  let callsAfterCron: DirectAddCall[] = [];
  let answerAfterCron = '';

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    const stubs = plannerStubs(structureOf(1, 3));
    const seeded = await seed(briefOf());
    clientId = seeded.clientId;
    const bot = await botWith(stubs);

    // ── шаг 1: человек говорит «запусти» и получает карточку ──────────────────
    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    const issued = await prisma.pendingApproval.findFirstOrThrow({
      where: { clientId },
      select: { id: true },
    });
    approvalId = issued.id;

    /**
     * ── шаг 2: обрыв ровно между нажатием и применением ──────────────────────
     *
     * Это не выдуманное состояние: `processApprovalCallback` сначала захватывает
     * строку условным UPDATE (PENDING → APPROVED, decidedAt, respondedBy) и только
     * потом зовёт `applyApproval`. Здесь воспроизводится первая половина без
     * второй — то же самое, что убитый под между двумя запросами. Что состояние
     * именно такое, зафиксировано юнит-тестом в `src/approval/callbacks.test.ts`.
     */
    const pressedAt = new Date(Date.now() - (STUCK_APPROVAL_MINUTES + 5) * 60_000);
    const claimed = await prisma.pendingApproval.updateMany({
      where: { id: approvalId, decision: ApprovalDecision.PENDING },
      data: {
        decision: ApprovalDecision.APPROVED,
        decidedAt: pressedAt,
        respondedBy: '@roman',
      },
    });
    expect(claimed.count).toBe(1);

    // ── шаг 3: клиент, не дождавшись, пробует запустить ещё раз ───────────────
    telegram.reset();
    direct.reset();
    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    blockedAnswer = textsOf(telegram.sent);
    cardsWhileBlocked = telegram.cards().length;
    callsWhileBlocked = [...direct.calls];

    // ── шаг 4: крон `expire-approvals` — единственный, кто может это разобрать ─
    telegram.reset();
    direct.reset();
    cronResult = await expireApprovals(new Date());
    afterCron = [...telegram.sent];
    editedAfterCron = telegram.edited.map((e) => e.text).join(' ');
    callsAfterCron = [...direct.calls];

    // ── шаг 5: вход после сверки ──────────────────────────────────────────────
    telegram.reset();
    direct.reset();
    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    answerAfterCron = textsOf(telegram.sent);
  });

  it('до сверки вход закрыт: живая карточка — жёсткий стоп, и это правильно', () => {
    expect(blockedAnswer).toContain('ждёт твоего решения');
    // Второй план на те же деньги не собирается и вторая карточка не выпускается.
    expect(cardsWhileBlocked).toBe(0);
    expect(callsWhileBlocked).toEqual([]);
  });

  it('сверка доводит применение до конца, а не только рассказывает о нём', async () => {
    expect(cronResult?.resumed).toBe(1);
    expect(callsAfterCron.filter((c) => c.service === 'campaigns')).toHaveLength(1);

    const approval = await prisma.pendingApproval.findUniqueOrThrow({
      where: { id: approvalId },
      select: { decision: true },
    });
    expect(approval.decision).toBe(ApprovalDecision.APPLIED);

    const campaigns = await prisma.campaign.findMany({
      where: { clientId },
      select: { externalId: true },
    });
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.externalId).toMatch(/^\d+$/);
  });

  it('человек узнаёт словами, что его нажатие всё-таки доехало', () => {
    const text = textsOf(afterCron);
    expect(text).toContain('@roman');
    expect(text).toContain('Довёл до конца');
    // Правка карточки — тоже часть ответа: под ней больше нет кнопок.
    expect(editedAfterCron).toContain('Одобрено');
  });

  it('вход снова открыт и говорит правду: кампания уже создана', () => {
    expect(answerAfterCron).toContain('кампании уже созданы');
    expect(answerAfterCron).not.toContain('ждёт твоего решения');
  });
});

describe('PENDING с истёкшим сроком: вход считает её неживой — и её действительно разбирают', () => {
  let clientId = '';
  let staleId = '';
  let cronResult: Awaited<ReturnType<typeof expireApprovals>> | undefined;
  let afterCron: SentMessage[] = [];
  let cardsAfterRelaunch = 0;

  beforeAll(async () => {
    telegram.reset();
    direct.reset();
    const stubs = plannerStubs(structureOf(1, 3));
    const seeded = await seed(briefOf({ product: 'Курсы английского с истёкшей карточкой' }));
    clientId = seeded.clientId;
    const bot = await botWith(stubs);

    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    const issued = await prisma.pendingApproval.findFirstOrThrow({
      where: { clientId },
      select: { id: true },
    });
    staleId = issued.id;

    // Срок ответа вышел, человек так и не нажал.
    await prisma.pendingApproval.update({
      where: { id: staleId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    telegram.reset();
    direct.reset();
    cronResult = await expireApprovals(new Date());
    afterCron = [...telegram.sent];

    telegram.reset();
    await bot.handleUpdate(commandUpdate(seeded.tgUserId, '/launch'));
    cardsAfterRelaunch = telegram.cards().length;
  });

  it('крон экспирации закрывает её и говорит об этом человеку', async () => {
    expect(cronResult?.expired).toBe(1);
    const approval = await prisma.pendingApproval.findUniqueOrThrow({
      where: { id: staleId },
      select: { decision: true },
    });
    expect(approval.decision).toBe(ApprovalDecision.EXPIRED);
    expect(textsOf(afterCron)).toContain('Истёк срок апрува');
  });

  it('вход после этого выпускает новую карточку по тому же плану', () => {
    expect(cardsAfterRelaunch).toBe(1);
  });
});
