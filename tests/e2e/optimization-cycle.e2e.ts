import type { ChangeLog, PendingApproval } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { runAt, seedAccount, type Fixture } from './support/seed.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';
import { createYandexApiMock, type YandexApiMock } from './support/yandex-api-mock.js';

import { applyApproval, setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { runScheduledOptimization } from '@/optimizer/index.js';

/**
 * Сквозной прогон конвейера оптимизации на живых Postgres и Redis.
 *
 * Что проверяется (TZ §9.6 в проверяемой сегодня части): три цикла подряд без
 * вмешательства человека не разносят кабинет — карточка не дублируется, уже
 * применённое не предлагается снова, а размер изменения не накапливается.
 *
 * Живого во всём сценарии два: наша БД (мокать её запрещает CLAUDE.md §5) и
 * очередь. Наружу не уходит ничего: HTTP Директа перехвачен msw, транспорт
 * Telegram подменён, LLM не вызывается вовсе — правила оптимизатора её не знают.
 */

const DECISIONS_PER_LIVE_CYCLE = 5;
/** kwFresh (сутки истории), «зоопарк…» (двое суток), ставка сверх доли изменений. */
const GUARDRAIL_REJECTIONS = 3;

let fx: Fixture;
let yandex: YandexApiMock;
let telegram: TelegramMock;

function payloadOf(approval: PendingApproval): Record<string, unknown> {
  return approval.payload as Record<string, unknown>;
}

function actionKindOf(approval: PendingApproval): string {
  return String(payloadOf(approval)['kind']);
}

function changeOf(rows: readonly ChangeLog[], action: string, entityId: string): ChangeLog {
  const found = rows.filter((row) => row.action === action && row.entityId === entityId);
  if (found.length !== 1) {
    throw new Error(
      `ожидалась одна запись ChangeLog ${action}/${entityId}, найдено ${found.length}`,
    );
  }
  return found[0] as ChangeLog;
}

function changeLogRows(): Promise<ChangeLog[]> {
  return prisma.changeLog.findMany({ orderBy: [{ appliedAt: 'asc' }, { id: 'asc' }] });
}

function approvalRows(): Promise<PendingApproval[]> {
  return prisma.pendingApproval.findMany({ orderBy: { createdAt: 'asc' } });
}

describe('цикл оптимизации целиком', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    yandex = createYandexApiMock([
      { id: 111, name: 'Поиск — Слоны', dailyBudget: 8000, negativeKeywords: [] },
      { id: 112, name: 'РСЯ — импорт из кабинета', dailyBudget: 3000, negativeKeywords: [] },
    ]);
    // 'error' обязателен: без него незамоканный запрос ушёл бы в настоящий Директ.
    yandex.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);

    fx = await seedAccount();
  });

  afterAll(async () => {
    yandex?.server.close();
    setMessenger(null);
    await prisma.$disconnect();
  });

  it('первый цикл в dryRun: решения приняты, предохранители сработали, карточки созданы', async () => {
    const summary = await runScheduledOptimization({ dryRun: true, now: runAt(0) });

    expect(summary).toMatchObject({
      campaigns: 2,
      // Ни одного изменения в кабинете — только план.
      autoApply: 0,
      plannedOnly: DECISIONS_PER_LIVE_CYCLE,
      noop: 0,
      applyFailed: 0,
      approvals: 2,
      approvalsDuplicate: 0,
      approvalsFailed: 0,
      rejected: GUARDRAIL_REJECTIONS,
      clamped: 0,
      // Цель по CPA доехала из брифа: своей у кампаний нет.
      noTargetCpa: 0,
      failed: 0,
    });
    expect(summary.skipped).toEqual({});

    // Кампания в режиме OBSERVER не применяет ничего сама: одна заявка политики
    // разъехалась на две карточки, потому что паузы и минус-слова пишутся разными
    // вызовами площадки.
    const approvals = await approvalRows();
    expect(approvals.map(actionKindOf).sort()).toEqual(['add_negatives', 'pause_entities']);
    expect(approvals.every((a) => a.clientId === fx.clientId)).toBe(true);
    expect(approvals.every((a) => a.decision === 'PENDING')).toBe(true);

    const pause = approvals.find((a) => actionKindOf(a) === 'pause_entities');
    expect(payloadOf(pause as PendingApproval)['externalIds']).toEqual([
      fx.imported.losingKeywordExternalId,
    ]);
    const negatives = approvals.find((a) => actionKindOf(a) === 'add_negatives');
    expect(payloadOf(negatives as PendingApproval)['phrases']).toEqual([fx.imported.junkQuery]);

    // Карточка обязана честно сказать, что записи не будет.
    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent.every((m) => m.chatId === fx.chatId)).toBe(true);
    expect(telegram.sent.some((m) => m.text.includes(fx.imported.junkQuery))).toBe(true);

    // Дороже всего ошибиться именно здесь: dry-run обязан быть предохранителем,
    // а не пометкой в логе.
    expect(yandex.calls).toHaveLength(0);
    expect(await prisma.changeLog.count()).toBe(0);
    expect(await prisma.searchQueryStat.count({ where: { negated: true } })).toBe(0);

    const keys = await prisma.idempotencyKey.findMany();
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.key.startsWith('approval:'))).toBe(true);
  });

  it('второй и третий циклы в те же сутки не создают вторую такую же карточку', async () => {
    for (const cycle of [2, 3]) {
      const summary = await runScheduledOptimization({ dryRun: true, now: runAt(0) });
      expect({ cycle, ...summary }).toMatchObject({
        cycle,
        plannedOnly: DECISIONS_PER_LIVE_CYCLE,
        approvals: 0,
        // Ключ идемпотентности карточки детерминирован в пределах суток.
        approvalsDuplicate: 2,
        approvalsFailed: 0,
        rejected: GUARDRAIL_REJECTIONS,
        failed: 0,
      });
    }

    expect(await prisma.pendingApproval.count()).toBe(2);
    expect(telegram.sent).toHaveLength(2);
    expect(await prisma.idempotencyKey.count()).toBe(2);
    expect(await prisma.changeLog.count()).toBe(0);
    expect(yandex.calls).toHaveLength(0);
  });

  it('боевой цикл доводит решения до площадки, журнала и пометки минус-фраз', async () => {
    const summary = await runScheduledOptimization({ dryRun: false, now: runAt(1) });

    expect(summary).toMatchObject({
      campaigns: 2,
      autoApply: DECISIONS_PER_LIVE_CYCLE,
      plannedOnly: 0,
      noop: 0,
      applyFailed: 0,
      // Новые сутки — новый runId, значит и новые карточки по кампании OBSERVER.
      approvals: 2,
      approvalsDuplicate: 0,
      rejected: GUARDRAIL_REJECTIONS,
      failed: 0,
    });

    const rows = await changeLogRows();
    expect(rows).toHaveLength(DECISIONS_PER_LIVE_CYCLE);
    expect(rows.every((r) => r.actor === 'AI')).toBe(true);
    expect(rows.every((r) => r.campaignId === fx.search.campaignId)).toBe(true);

    expect(changeOf(rows, 'PAUSE', fx.search.losingKeywordId).newValue).toEqual({
      kind: 'status',
      status: 'PAUSED',
    });
    expect(changeOf(rows, 'PAUSE', fx.search.losingAdId).entityType).toBe('AD');
    expect(changeOf(rows, 'BID_DECREASE', fx.search.expensiveKeywordId)).toMatchObject({
      prevValue: { kind: 'bid', amount: 200 },
      newValue: { kind: 'bid', amount: 170 },
    });
    expect(changeOf(rows, 'BID_INCREASE', fx.search.winningKeywordId)).toMatchObject({
      prevValue: { kind: 'bid', amount: 120 },
      newValue: { kind: 'bid', amount: 132 },
    });
    expect(changeOf(rows, 'ADD_NEGATIVE_KEYWORD', fx.search.adGroupId).newValue).toEqual({
      kind: 'negativeKeyword',
      phrase: fx.search.junkQuery,
    });

    // Отклонённое предохранителями не должно доехать никуда.
    expect(rows.some((r) => r.entityId === fx.search.freshKeywordId)).toBe(false);
    expect(rows.some((r) => r.entityId === fx.imported.losingKeywordId)).toBe(false);

    // Площадка увидела ровно то же самое и ровно по одному разу.
    expect(yandex.suspended.keywords).toEqual([Number(fx.search.losingKeywordExternalId)]);
    expect(yandex.suspended.ads).toEqual([Number(fx.search.losingAdExternalId)]);
    expect(yandex.bids).toEqual([
      { keywordId: Number(fx.search.expensiveKeywordExternalId), searchBid: 170 },
      { keywordId: Number(fx.search.winningKeywordExternalId), searchBid: 132 },
    ]);
    expect(yandex.negativesOf(111)).toEqual([fx.search.junkQuery]);
    // Кампания в режиме OBSERVER ждёт человека и сама не пишет ничего.
    expect(yandex.negativesOf(112)).toEqual([]);

    // Баллы Директа посчитаны: без журнала кабинет однажды встанет на весь день.
    expect(await prisma.unitsLedger.count()).toBeGreaterThan(0);

    // Применённая фраза помечена — иначе она вернётся завтра и послезавтра.
    const negated = await prisma.searchQueryStat.findMany({ where: { negated: true } });
    expect(new Set(negated.map((r) => r.query))).toEqual(new Set([fx.search.junkQuery]));

    expect(await prisma.pendingApproval.count()).toBe(4);
    expect(telegram.sent).toHaveLength(4);
  });

  it('повтор боевого цикла в те же сутки не пишет ничего второй раз', async () => {
    const callsBefore = yandex.calls.length;

    const summary = await runScheduledOptimization({ dryRun: false, now: runAt(1) });

    expect(summary).toMatchObject({
      autoApply: 0,
      plannedOnly: 0,
      noop: 0,
      applyFailed: 0,
      approvals: 0,
      approvalsDuplicate: 2,
      failed: 0,
    });

    // Ни одного запроса к площадке: решения отсеклись на ключах идемпотентности
    // до выхода в сеть, а не после ответа кабинета.
    expect(yandex.calls.length).toBe(callsBefore);
    expect(await prisma.changeLog.count()).toBe(DECISIONS_PER_LIVE_CYCLE);
    expect(await prisma.pendingApproval.count()).toBe(4);
    expect(telegram.sent).toHaveLength(4);
  });

  it('одобренная карточка применяется и помечает минус-фразы импортированной кампании', async () => {
    const approvals = await approvalRows();
    const card = approvals
      .filter((a) => actionKindOf(a) === 'add_negatives' && a.decision === 'PENDING')
      .at(-1);
    expect(card).toBeDefined();
    const cardId = (card as PendingApproval).id;

    await prisma.pendingApproval.update({
      where: { id: cardId },
      data: { decision: 'APPROVED', decidedAt: new Date(), respondedBy: 'roman' },
    });

    const outcome = await applyApproval(cardId, 'roman');
    expect(outcome).toEqual({ status: 'APPLIED', dryRun: false });

    expect(yandex.negativesOf(112)).toEqual([fx.imported.junkQuery]);
    expect(
      (await prisma.pendingApproval.findUniqueOrThrow({ where: { id: cardId } })).decision,
    ).toBe('APPLIED');

    const applied = await prisma.changeLog.findMany({ where: { actor: 'USER' } });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      action: 'add_negatives',
      campaignId: fx.imported.campaignId,
    });

    const negated = await prisma.searchQueryStat.findMany({ where: { negated: true } });
    expect(new Set(negated.map((r) => r.query))).toEqual(
      new Set([fx.search.junkQuery, fx.imported.junkQuery]),
    );

    // Итог дописан в исходную карточку, а не отправлен новым сообщением.
    expect(telegram.edited).toHaveLength(1);
    expect(telegram.sent).toHaveLength(4);
  });

  it('следующие сутки не предлагают уже применённое и не накапливают изменение', async () => {
    // Считаем все обращения к сервису campaigns, а не только записи: чтение
    // текущего списка минус-фраз стоит 10 баллов, и пометка нужна ровно затем,
    // чтобы его не делать.
    const campaignCallsBefore = yandex.calls.filter((c) => c.service === 'campaigns').length;

    const summary = await runScheduledOptimization({ dryRun: false, now: runAt(2) });

    expect(summary).toMatchObject({
      campaigns: 2,
      // Пять решений превратились в четыре: минус-слово помечено и больше не предлагается.
      autoApply: DECISIONS_PER_LIVE_CYCLE - 1,
      // Не «дошло до площадки и менять было нечего», а «даже не поехало».
      noop: 0,
      applyFailed: 0,
      // У кампании OBSERVER осталась одна заявка — пауза; минус-слово человек уже одобрил.
      approvals: 1,
      approvalsDuplicate: 0,
      rejected: GUARDRAIL_REJECTIONS,
      failed: 0,
    });

    const rows = await changeLogRows();
    const negativeChanges = rows.filter((r) => r.action === 'ADD_NEGATIVE_KEYWORD');
    expect(negativeChanges).toHaveLength(1);
    expect(yandex.calls.filter((c) => c.service === 'campaigns').length).toBe(campaignCallsBefore);
    expect(yandex.negativesOf(111)).toEqual([fx.search.junkQuery]);
    expect(yandex.negativesOf(112)).toEqual([fx.imported.junkQuery]);

    // Главное в §9.6: повтор не компаундит. Ставка каждый раз считается от значения
    // в базе, поэтому второй прогон предлагает те же 200 → 170, а не 170 → 144.5.
    const decreases = rows.filter((r) => r.action === 'BID_DECREASE');
    expect(decreases).toHaveLength(2);
    expect(decreases.map((r) => r.newValue)).toEqual([
      { kind: 'bid', amount: 170 },
      { kind: 'bid', amount: 170 },
    ]);
    expect(new Set(yandex.bids.map((b) => b.searchBid))).toEqual(new Set([170, 132]));

    // Отклонённое предохранителями отклоняется каждые сутки одинаково.
    expect(rows.some((r) => r.entityId === fx.search.freshKeywordId)).toBe(false);
    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('тот же цикл через реальную очередь BullMQ остаётся идемпотентным', async () => {
    const { Queue, Worker } = await import('bullmq');
    const { createRedis } = await import('@/db/redis.js');
    const { handlers } = await import('@/scheduler/handlers.js');
    const { QUEUE_NAMES } = await import('@/scheduler/queues.js');

    const name = QUEUE_NAMES.optimizeBids;
    const queue = new Queue(name, { connection: createRedis() });
    // Очередь переживает прогоны: не вычистив её, следующий запуск подхватил бы
    // задачу предыдущего и «прошёл» бы на чужом результате.
    await queue.obliterate({ force: true });

    const worker = new Worker(name, handlers[name], { connection: createRedis() });
    const changesBefore = await prisma.changeLog.count();

    try {
      const finished = new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once('completed', (_job, result) => resolve(result as Record<string, unknown>));
        worker.once('failed', (_job, err) => reject(err));
      });
      await queue.add(name, {});
      const result = await finished;

      // Настоящий `now` попадает в те же сутки, что и предыдущий цикл: обработчик
      // обязан увидеть свои же ключи и не тронуть кабинет.
      expect(result).toMatchObject({ campaigns: 2, autoApply: 0, applyFailed: 0, failed: 0 });
      expect(await prisma.changeLog.count()).toBe(changesBefore);
    } finally {
      await worker.close();
      await queue.close();
    }
  });
});
