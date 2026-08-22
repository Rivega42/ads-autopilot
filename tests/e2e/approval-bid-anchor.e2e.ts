import { ApprovalDecision } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { runAt, seedAccount, type Fixture } from './support/seed.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';
import { createYandexApiMock, type YandexApiMock } from './support/yandex-api-mock.js';

import { applyApproval, createApproval, setMessenger } from '@/approval/index.js';
import type { ApprovalAction } from '@/approval/types.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { applyGuardrails, loadBidHistory, observationKey } from '@/optimizer/index.js';
import type { Decision } from '@/optimizer/types.js';

/**
 * Ставка, изменённая через апрув, обязана оставлять след, который читает
 * предохранитель следующего прогона.
 *
 * Оконный предохранитель (`MAX_BID_CHANGE_WINDOW`) считает суммарное движение
 * ставки за окно от якоря — самой ранней записи журнала за окно. Якорь ищется по
 * четырём полям: `entityType: 'KEYWORD'`, внутренний id, `action` из
 * BID_DECREASE/BID_INCREASE и `prevValue: {kind:'bid'}`. Прямой путь оптимизатора
 * пишет ровно это. Путь через человека писал строку в другой форме — внешний id
 * площадки, `action: 'bid_change'`, `prevValue` массивом, — и якорь не находился
 * ни разу: оконный коридор схлопывался в шаговый, а он −15% в сутки пропускает
 * бесконечно. На кампании в режиме OBSERVER, где через человека идёт каждое
 * решение, это означало предохранитель, выключенный целиком.
 *
 * Поэтому сценарий проверяет не форму строки, а её последствие: после применённой
 * человеком ставки следующее решение по той же фразе обязано упереться в окно.
 * Живые здесь наша БД и наш код; Директ под msw, транспорт Telegram подменён.
 */

const ANCHOR_BID = 400;
/** Шаг правила: −15% от 400. Именно это одобряет человек. */
const APPROVED_BID = 340;
/**
 * Следующее предложение: −20.6% от новой ставки. Шаговый лимит (±30%) его
 * пропускает, оконный от якоря 400 — нет: нижняя граница окна 280.
 */
const NEXT_BID = 270;
const WINDOW_FLOOR = 280;
const WINDOW_DAYS = 7;

let fx: Fixture;
let yandex: YandexApiMock;
let telegram: TelegramMock;
let keywordId = '';

function bidChangeAction(externalId: string): ApprovalAction {
  return {
    kind: 'bid_change',
    clientId: fx.clientId,
    channel: 'YANDEX_DIRECT',
    reason: `CPA фразы вдвое выше цели: снижаем ставку с ${ANCHOR_BID} до ${APPROVED_BID} ₽`,
    changes: [{ keywordExternalId: externalId, bid: APPROVED_BID, bidBefore: ANCHOR_BID }],
  };
}

/** Решение следующего прогона по той же фразе: от уже применённой ставки. */
function nextDecision(): Decision {
  return {
    action: 'BID_DECREASE',
    entityType: 'KEYWORD',
    entityId: keywordId,
    prevValue: { kind: 'bid', amount: APPROVED_BID },
    nextValue: { kind: 'bid', amount: NEXT_BID },
    reason: 'CPA всё ещё выше цели',
    requiresApproval: false,
    layer: 'RULE',
    ruleId: 'bid-down',
    approvalKind: null,
  };
}

beforeAll(async () => {
  await resetDatabase();
  resetYandexRuntimeState();
  bootstrapChannels();

  yandex = createYandexApiMock([
    { id: 111, name: 'Поиск — Слоны', dailyBudget: 8000, negativeKeywords: [] },
    { id: 112, name: 'РСЯ — импорт из кабинета', dailyBudget: 3000, negativeKeywords: [] },
  ]);
  yandex.server.listen({ onUnhandledRequest: 'error' });

  telegram = createTelegramMock();
  setMessenger(telegram);

  fx = await seedAccount();
  const keyword = await prisma.keyword.findFirstOrThrow({
    where: {
      externalId: fx.imported.expensiveKeywordExternalId,
      adGroup: { campaign: { clientId: fx.clientId } },
    },
    select: { id: true, bid: true },
  });
  keywordId = keyword.id;
  expect(Number(keyword.bid)).toBe(ANCHOR_BID);

  // Человек одобряет снижение ставки: карточка выпущена как обычно, нажатие —
  // тем же путём, что в боте (захват строки, затем `applyApproval`).
  const approval = await createApproval(bidChangeAction(fx.imported.expensiveKeywordExternalId));
  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: {
      decision: ApprovalDecision.APPROVED,
      decidedAt: new Date(),
      respondedBy: '@roman',
    },
  });
  const outcome = await applyApproval(approval.id, '@roman');
  expect(outcome).toEqual({ status: 'APPLIED', dryRun: false });
});

afterAll(async () => {
  yandex?.server.close();
  setMessenger(null);
  await prisma.$disconnect();
});

describe('изменение ставки через человека попадает в историю предохранителя', () => {
  it('ставка действительно уехала в кабинет и в нашу строку', async () => {
    expect(yandex.bids).toEqual([
      { keywordId: Number(fx.imported.expensiveKeywordExternalId), searchBid: APPROVED_BID },
    ]);
    const keyword = await prisma.keyword.findUniqueOrThrow({
      where: { id: keywordId },
      select: { bid: true },
    });
    expect(Number(keyword.bid)).toBe(APPROVED_BID);
  });

  it('следующий прогон находит якорь — ставку на начало окна, а не текущую', async () => {
    const history = await loadBidHistory(prisma, [nextDecision()], {
      start: runAt(-1),
      days: WINDOW_DAYS,
    });

    expect(history.unavailable.size).toBe(0);
    expect(history.anchors.get(`KEYWORD:${keywordId}`)).toBe(ANCHOR_BID);
  });

  it('и упирается в оконный коридор, а не в шаговый', async () => {
    const decision = nextDecision();
    const history = await loadBidHistory(prisma, [decision], {
      start: runAt(-1),
      days: WINDOW_DAYS,
    });

    const outcome = applyGuardrails([decision], {
      dailyBudget: 3000,
      observations: new Map([[observationKey(decision), { impressions: 5_000, days: 14 }]]),
      bidHistory: history,
    });

    expect(outcome.allowed.map((d) => d.nextValue)).toEqual([
      { kind: 'bid', amount: WINDOW_FLOOR },
    ]);
    expect(outcome.clamped.map((c) => c.rail)).toEqual(['MAX_BID_CHANGE_WINDOW']);
  });

  it('запись человека не подменяет собой аудит апрува: обе строки на месте', async () => {
    const rows = await prisma.changeLog.findMany({
      where: { actor: 'USER' },
      orderBy: { appliedAt: 'asc' },
    });

    // Строка апрува — «что решил человек», строка решения — «что стало со ставкой».
    expect(rows.map((r) => r.action).sort()).toEqual(['BID_DECREASE', 'bid_change']);

    const canonical = rows.find((r) => r.action === 'BID_DECREASE');
    expect(canonical).toMatchObject({
      entityType: 'KEYWORD',
      entityId: keywordId,
      campaignId: fx.imported.campaignId,
      prevValue: { kind: 'bid', amount: ANCHOR_BID },
      newValue: { kind: 'bid', amount: APPROVED_BID },
      approvedBy: '@roman',
      provider: 'YANDEX_DIRECT',
    });
  });
});
