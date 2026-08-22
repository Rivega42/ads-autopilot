import type { ChangeLog } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCliWithCabinets, type MockedCliResult } from './support/cli-process.js';
import { resetDatabase } from './support/database.js';
import { seedAccount, type Fixture } from './support/seed.js';

import { prisma } from '@/db/prisma.js';

/**
 * `pnpm cli optimize --apply` целиком: от набранной команды до кабинета.
 *
 * Зачем отдельный файл рядом с `cli-optimize.e2e.ts` и `optimization-cycle.e2e.ts`.
 * Первый проходит команду настоящим процессом, но только печатающие пути: его
 * единственный прогон с `--apply` сделан по клиенту без подходящих кампаний
 * («Кампаний просмотрено: 0»), то есть проверяет проводку, а не запись. Второй
 * проверяет запись, но зовёт `runScheduledOptimization` напрямую — минуя команду.
 *
 * Ровно на этом стыке и жил дефект, ради которого всё это пишется: функция была
 * покрыта, а то, что CLI звал вместо неё `runOptimizer` (посчитать и выбросить),
 * не видел никто — команда печатала «применено» и не применяла ничего.
 *
 * Поэтому здесь настоящий процесс команды и настоящий HTTP внутри него: моки
 * Директа и Telegram поднимает `support/cli-apply-mocks.ts`, подгруженный до
 * точки входа, и он же оставляет снимок того, что ушло площадкам. Проверяются
 * последствия — ставки в кабинете, строки `ChangeLog`, карточки в чате — и текст,
 * напечатанный человеку: он запускает эту команду руками и решает по нему.
 */

const APPLY = ['optimize', '--apply'];
const LIVE = { DRY_RUN: 'false' };

/** Число из строки сводки: сверяем напечатанное с тем, что в базе. */
function printedNumber(text: string, label: string): number {
  const match = new RegExp(`${label}: (\\d+)`).exec(text);
  if (!match?.[1]) throw new Error(`в выводе нет строки «${label}: N»:\n${text}`);
  return Number(match[1]);
}

function changeOf(rows: readonly ChangeLog[], action: string, entityId: string): ChangeLog {
  const found = rows.filter((row) => row.action === action && row.entityId === entityId);
  if (found.length !== 1) {
    throw new Error(
      `ожидалась одна строка ChangeLog ${action}/${entityId}, найдено ${found.length}`,
    );
  }
  return found[0] as ChangeLog;
}

describe('optimize --apply доводит решения до кабинета', () => {
  let fx: Fixture;
  let first: MockedCliResult;

  beforeAll(async () => {
    await resetDatabase();
    fx = await seedAccount();
    first = await runCliWithCabinets(APPLY, LIVE);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('команда завершается нулём и печатает сводку записи, а не список рекомендаций', () => {
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Кампаний просмотрено: 2');
    expect(first.stdout).toContain('Изменений записано в кабинеты: 5');
    expect(first.stdout).toContain('Карточек апрува выпущено: 2');
    expect(first.stdout).toContain('Отклонено предохранителями: 3, ужато: 0');
    // Строка показа: пока `--apply` звал `runOptimizer`, печаталась именно она.
    expect(first.stdout).not.toContain('ничего не применено');
    expect(first.stdout).not.toContain('⚠️');
  });

  it('ставки уехали в кабинет — теми же числами, что напечатаны в решении', () => {
    expect(first.mock.yandex.bids).toEqual([
      { keywordId: Number(fx.search.expensiveKeywordExternalId), searchBid: 170 },
      { keywordId: Number(fx.search.winningKeywordExternalId), searchBid: 132 },
    ]);
  });

  it('паузы и минус-слово доехали туда же, и только по кампании в режиме FULL', () => {
    expect(first.mock.yandex.suspended).toEqual({
      keywords: [Number(fx.search.losingKeywordExternalId)],
      ads: [Number(fx.search.losingAdExternalId)],
    });
    expect(first.mock.yandex.negatives[fx.search.externalId]).toEqual([fx.search.junkQuery]);
    // Кампания-наблюдатель ждёт человека: сама команда в неё не пишет ничего.
    expect(first.mock.yandex.negatives[fx.imported.externalId]).toEqual([]);
  });

  it('в ChangeLog легли ровно пять строк, и ровно те', async () => {
    const rows = await prisma.changeLog.findMany({
      orderBy: [{ appliedAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(5);
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

    // Отклонённое предохранителями не доехало ни до кабинета, ни до журнала.
    expect(rows.some((r) => r.entityId === fx.search.freshKeywordId)).toBe(false);
    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('решения, требующие человека, стали карточками в его чате', async () => {
    const cards = first.mock.telegram.sent;
    expect(cards).toHaveLength(2);
    expect(cards.every((m) => m.chatId === fx.chatId)).toBe(true);
    // Без клавиатуры карточку нечем нажать — это уже не апрув, а уведомление.
    expect(cards.every((m) => m.card)).toBe(true);
    expect(cards.some((m) => m.text.includes(fx.imported.junkQuery))).toBe(true);
    expect(cards.some((m) => m.text.includes('слон розовый'))).toBe(true);

    const approvals = await prisma.pendingApproval.findMany();
    expect(approvals).toHaveLength(2);
    expect(approvals.every((a) => a.clientId === fx.clientId)).toBe(true);
    expect(approvals.every((a) => a.decision === 'PENDING')).toBe(true);
    // Доставка состоялась: заявка с `error` висит мёртвой, нажать её некому.
    expect(approvals.every((a) => a.error === null)).toBe(true);
    expect(approvals.every((a) => a.tgMessageId !== null)).toBe(true);
  });

  it('наши строки догнали кабинет: ставка, статус и пометка минус-фразы', async () => {
    const expensive = await prisma.keyword.findUniqueOrThrow({
      where: { id: fx.search.expensiveKeywordId },
      select: { bid: true },
    });
    expect(Number(expensive.bid)).toBe(170);

    const losing = await prisma.keyword.findUniqueOrThrow({
      where: { id: fx.search.losingKeywordId },
      select: { status: true },
    });
    expect(losing.status).toBe('PAUSED');

    const negated = await prisma.searchQueryStat.findMany({ where: { negated: true } });
    expect(new Set(negated.map((r) => r.query))).toEqual(new Set([fx.search.junkQuery]));

    // Баллы Директа списаны по-настоящему: команда прошла через тот же клиент,
    // что и крон, а не через прямой вызов движка.
    expect(await prisma.unitsLedger.count()).toBeGreaterThan(0);
  });

  it('напечатанное сходится с записанным, а не с числом посчитанных решений', async () => {
    const [changes, approvals, campaigns] = await Promise.all([
      prisma.changeLog.count({ where: { actor: 'AI' } }),
      prisma.pendingApproval.count(),
      prisma.campaign.count({ where: { status: 'ACTIVE' } }),
    ]);

    expect(printedNumber(first.stdout, 'Изменений записано в кабинеты')).toBe(changes);
    expect(printedNumber(first.stdout, 'Карточек апрува выпущено')).toBe(approvals);
    expect(printedNumber(first.stdout, 'Кампаний просмотрено')).toBe(campaigns);
    // Решений оптимизатор принял больше, чем записал: часть ушла человеку, часть
    // сняли предохранители. Напечатать их числом «применено» — ровно тот дефект.
    expect(printedNumber(first.stdout, 'Изменений записано в кабинеты')).toBeLessThan(
      changes + approvals,
    );
  });

  it('повтор той же команды в те же сутки не пишет второй раз', async () => {
    const second = await runCliWithCabinets(APPLY, LIVE);

    expect(second.code).toBe(0);
    expect(second.stdout).toContain('Изменений записано в кабинеты: 0');
    expect(second.stdout).toContain('Карточек апрува выпущено: 0');
    // Без этой строки «выпущено: 0» читается как «ничего не вышло», хотя карточки
    // первого прогона живы и ждут нажатия.
    expect(second.stdout).toContain('уже выпущено раньше и повторно не отправлено: 2');

    // Ни одного обращения к площадке: решения отсеклись на ключах идемпотентности
    // до выхода в сеть. Ключи лежат в нашей БД, поэтому переживают конец процесса —
    // а вот на состояние мока полагаться нельзя: у второго процесса он свой, пустой.
    expect(second.mock.yandex.calls).toEqual([]);
    expect(second.mock.telegram.sent).toEqual([]);

    expect(await prisma.changeLog.count()).toBe(5);
    expect(await prisma.pendingApproval.count()).toBe(2);
    expect(await prisma.errorLog.count()).toBe(0);
  });
});

describe('optimize --apply под DRY_RUN=true', () => {
  let result: MockedCliResult;

  beforeAll(async () => {
    await resetDatabase();
    await seedAccount();
    result = await runCliWithCabinets(APPLY, { DRY_RUN: 'true' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('человек предупреждён, что флаг проигнорирован', () => {
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--apply проигнорирован');
    expect(result.stdout).toContain('DRY_RUN');
    expect(result.stdout).toContain('ничего не применено');
  });

  it('в кабинет не ушло ни одного запроса — включая чтения за баллы', () => {
    expect(result.mock.yandex.calls).toEqual([]);
    expect(result.mock.yandex.bids).toEqual([]);
    expect(result.mock.yandex.suspended).toEqual({ keywords: [], ads: [] });
  });

  it('и в Telegram не ушло ничего: карточка — это тоже действие', async () => {
    expect(result.mock.telegram.sent).toEqual([]);
    expect(await prisma.pendingApproval.count()).toBe(0);
  });

  it('в базе не осталось следов записи', async () => {
    const [changes, keys, units] = await Promise.all([
      prisma.changeLog.count(),
      prisma.idempotencyKey.count(),
      prisma.unitsLedger.count(),
    ]);
    expect({ changes, keys, units }).toEqual({ changes: 0, keys: 0, units: 0 });
  });

  it('но решения показаны — иначе предохранитель выглядел бы поломкой', () => {
    expect(result.stdout).toContain('Поиск — Слоны');
    expect(result.stdout).toContain('BID_DECREASE');
    expect(result.stdout).toMatch(/Всего решений: [1-9]/);
  });
});

describe('optimize --apply, когда кабинет отказал', () => {
  let fx: Fixture;
  let result: MockedCliResult;

  beforeAll(async () => {
    await resetDatabase();
    fx = await seedAccount();
    // Директ отвечает отказом на ставки и принимает всё остальное: провал части
    // решений — обычный день, и сводка обязана показать именно его.
    result = await runCliWithCabinets(APPLY, LIVE, { fail: 'keywordbids' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('сводка называет провал, а не прячет его за числом записанного', () => {
    // Ненулевой код: скрипт, обходящий клиентов, читает именно его. Со строкой
    // «не записано в кабинет: 2» при нулевом коде прогон не отличался от успеха.
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('Изменений записано в кабинеты: 3');
    expect(result.stdout).toContain('не записано в кабинет: 2');
    expect(result.mock.yandex.refused).toEqual(['keywordbids.set', 'keywordbids.set']);
  });

  it('непринятая ставка не попала ни в журнал, ни в наши строки', async () => {
    const rows = await prisma.changeLog.findMany({ select: { action: true } });
    expect(rows.map((r) => r.action).sort()).toEqual(['ADD_NEGATIVE_KEYWORD', 'PAUSE', 'PAUSE']);

    const expensive = await prisma.keyword.findUniqueOrThrow({
      where: { id: fx.search.expensiveKeywordId },
      select: { bid: true },
    });
    // 200, а не 170: строка, обещающая изменение, которого в кабинете нет, заставит
    // завтрашний прогон считать снижение от несуществующей ставки.
    expect(Number(expensive.bid)).toBe(200);
    expect(result.mock.yandex.bids).toEqual([]);
  });

  it('печатное число провалов равно числу решений, не доехавших до кабинета', async () => {
    const applied = await prisma.changeLog.count();
    expect(printedNumber(result.stdout, 'Изменений записано в кабинеты')).toBe(applied);
    expect(printedNumber(result.stdout, 'не записано в кабинет')).toBe(
      result.mock.yandex.refused.length,
    );
  });

  it('ключ упавшего решения освобождён — иначе повтор не отправит его никогда', async () => {
    // Три применённых плюс две карточки; ставки своих ключей не удержали.
    expect(await prisma.idempotencyKey.count()).toBe(5);
  });
});

describe('optimize --apply, когда карточку доставить некому', () => {
  let fx: Fixture;
  let result: MockedCliResult;

  beforeAll(async () => {
    await resetDatabase();
    fx = await seedAccount();
    result = await runCliWithCabinets(APPLY, LIVE, { blockChat: '770000001' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('запись в кабинет не страдает от того, что Telegram отказал', () => {
    expect(result.stdout).toContain('Изменений записано в кабинеты: 5');
    expect(result.mock.telegram.sent).toEqual([]);
  });

  it('нажать карточку некому — это видно строкой, но не кодом возврата', () => {
    // Кода возврата у этого случая намеренно нет: клиент, держащий бота в блоке, —
    // стоячее состояние, и ненулевой код горел бы каждые сутки подряд, пока он его
    // не снимет. Повод доставляет тревога `approval_undelivered`, а не выход
    // команды; см. докблок `optimizeNeedsHumanFix`.
    expect(result.stdout).toContain('карточек не доставлено');
    expect(result.code).toBe(0);
  });

  it('повод при этом лежит в журнале, откуда его берёт тревога', async () => {
    const rows = await prisma.errorLog.findMany({ where: { clientId: fx.clientId } });
    expect(rows.map((r) => r.code)).toContain('APPROVAL_NOT_DELIVERED');
  });

  it('заявка жива и несёт причину недоставки — по ней её найдёт дашборд', async () => {
    const approvals = await prisma.pendingApproval.findMany();
    expect(approvals).toHaveLength(2);
    expect(approvals.every((a) => a.clientId === fx.clientId)).toBe(true);
    expect(approvals.every((a) => a.tgMessageId === null)).toBe(true);
    for (const approval of approvals) {
      expect(approval.error ?? '').toMatch(/403|blocked/);
    }
  });
});
