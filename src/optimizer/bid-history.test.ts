import { describe, expect, it, vi } from 'vitest';

import {
  bidHistoryKey,
  loadBidHistory,
  noBidHistory,
  rowsPerEntityCap,
  type BidHistoryDb,
  type BidHistoryRow,
} from './bid-history.js';
import type { Decision } from './types.js';

const WINDOW_START = new Date('2026-08-01T00:00:00.000Z');

function at(day: number): Date {
  return new Date(Date.UTC(2026, 7, day, 3, 0, 0));
}

function bidDecision(
  entityId: string,
  previous = 100,
  next = 90,
  entityType: Decision['entityType'] = 'KEYWORD',
): Decision {
  return {
    action: next < previous ? 'BID_DECREASE' : 'BID_INCREASE',
    entityType,
    entityId,
    prevValue: { kind: 'bid', amount: previous },
    nextValue: { kind: 'bid', amount: next },
    reason: 'тест',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'test',
    approvalKind: null,
  };
}

function row(
  entityId: string,
  previous: unknown,
  appliedAt: Date,
  entityType = 'KEYWORD',
): BidHistoryRow {
  return { entityType, entityId, prevValue: previous, appliedAt };
}

interface Recorded {
  entityType: string;
  ids: string[];
  actions: string[];
  since: Date;
  take: number;
}

/**
 * Журнал отвечает ровно на заданный вопрос: фильтрует по типу, списку id и границе
 * окна и обрезает выборку по `take`. Фикстура, отдающая всё подряд, спрятала бы и
 * потерю фильтра, и потерю потолка — то есть ровно те два дефекта, из-за которых
 * выборку из журнала в этом проекте уже разбирали.
 */
function createDb(rows: readonly BidHistoryRow[]): BidHistoryDb & { seen: Recorded[] } {
  const seen: Recorded[] = [];
  return {
    seen,
    changeLog: {
      findMany: vi.fn(async (args) => {
        const { where, take, orderBy } = args;
        if (orderBy.length === 0) throw new Error('выборка журнала без сортировки');
        if (!(take > 0)) throw new Error('выборка журнала без потолка');
        seen.push({
          entityType: where.entityType,
          ids: [...where.entityId.in],
          actions: [...where.action.in],
          since: where.appliedAt.gte,
          take,
        });
        return rows
          .filter(
            (candidate) =>
              candidate.entityType === where.entityType &&
              where.entityId.in.includes(candidate.entityId) &&
              candidate.appliedAt >= where.appliedAt.gte,
          )
          .sort((a, b) => a.appliedAt.getTime() - b.appliedAt.getTime())
          .slice(0, take);
      }),
    },
  };
}

describe('rowsPerEntityCap', () => {
  it('выводится из окна, а не задан числом', () => {
    expect(rowsPerEntityCap(7)).toBe(16);
    expect(rowsPerEntityCap(14)).toBe(30);
    // Прогон по одним суткам всё равно имеет право на край окна.
    expect(rowsPerEntityCap(0)).toBe(4);
  });
});

describe('loadBidHistory', () => {
  it('якорь — ставка до самой ранней записи в окне, а не до последней', async () => {
    const db = createDb([
      row('kw-1', { kind: 'bid', amount: 200 }, at(2)),
      row('kw-1', { kind: 'bid', amount: 170 }, at(3)),
      row('kw-1', { kind: 'bid', amount: 144.5 }, at(4)),
    ]);

    const history = await loadBidHistory(db, [bidDecision('kw-1')], {
      start: WINDOW_START,
      days: 7,
    });

    expect(history.anchors.get(bidHistoryKey('KEYWORD', 'kw-1'))).toBe(200);
    expect(history.unavailable.size).toBe(0);
    expect(history.windowDays).toBe(7);
  });

  it('записи до начала окна в якорь не попадают', async () => {
    const db = createDb([
      row('kw-1', { kind: 'bid', amount: 900 }, new Date('2026-07-20T00:00:00.000Z')),
      row('kw-1', { kind: 'bid', amount: 200 }, at(2)),
    ]);

    const history = await loadBidHistory(db, [bidDecision('kw-1')], {
      start: WINDOW_START,
      days: 7,
    });

    expect(history.anchors.get(bidHistoryKey('KEYWORD', 'kw-1'))).toBe(200);
  });

  it('сущность без истории якоря не получает — за окно её не двигали', async () => {
    const db = createDb([row('kw-2', { kind: 'bid', amount: 50 }, at(2))]);

    const history = await loadBidHistory(db, [bidDecision('kw-1')], {
      start: WINDOW_START,
      days: 7,
    });

    expect(history.anchors.size).toBe(0);
    expect(history.unavailable.size).toBe(0);
    expect(db.seen[0]?.ids).toEqual(['kw-1']);
  });

  it('спрашивает журнал только про изменения ставки и только внутри окна', async () => {
    const db = createDb([]);

    await loadBidHistory(
      db,
      [
        bidDecision('kw-1'),
        { ...bidDecision('kw-2'), nextValue: { kind: 'status', status: 'PAUSED' } },
      ],
      { start: WINDOW_START, days: 7 },
    );

    expect(db.seen).toHaveLength(1);
    expect(db.seen[0]).toMatchObject({
      entityType: 'KEYWORD',
      ids: ['kw-1'],
      actions: ['BID_DECREASE', 'BID_INCREASE'],
      since: WINDOW_START,
      take: rowsPerEntityCap(7),
    });
  });

  it('журнал не трогается вовсе, когда ставку никто не двигает', async () => {
    const db = createDb([]);

    const history = await loadBidHistory(
      db,
      [{ ...bidDecision('kw-1'), nextValue: { kind: 'status', status: 'PAUSED' } }],
      { start: WINDOW_START, days: 7 },
    );

    expect(db.seen).toEqual([]);
    expect(history.anchors.size).toBe(0);
  });

  it('одна сущность в двух решениях спрашивается один раз', async () => {
    const db = createDb([row('kw-1', { kind: 'bid', amount: 200 }, at(2))]);

    await loadBidHistory(db, [bidDecision('kw-1'), bidDecision('kw-1', 90, 99)], {
      start: WINDOW_START,
      days: 7,
    });

    expect(db.seen[0]?.ids).toEqual(['kw-1']);
  });

  it('нечитаемое значение в самой ранней записи делает якорь недостоверным', async () => {
    const db = createDb([
      row('kw-1', { kind: 'status', status: 'PAUSED' }, at(2)),
      row('kw-1', { kind: 'bid', amount: 170 }, at(3)),
    ]);

    const history = await loadBidHistory(db, [bidDecision('kw-1')], {
      start: WINDOW_START,
      days: 7,
    });

    // Взять следующую запись было бы удобнее и неверно: якорь оказался бы ниже
    // настоящего, и разрешённый коридор — шире настоящего.
    expect(history.anchors.size).toBe(0);
    expect(history.unavailable.has(bidHistoryKey('KEYWORD', 'kw-1'))).toBe(true);
  });

  it('упёршись в потолок, объявляет недостоверными только не попавшие в выборку', async () => {
    const cap = rowsPerEntityCap(1);
    const noisy = Array.from({ length: cap * 2 }, (_unused, index) =>
      row('kw-1', { kind: 'bid', amount: 200 }, at(2 + index)),
    );
    const db = createDb([...noisy, row('kw-2', { kind: 'bid', amount: 80 }, at(30))]);

    const history = await loadBidHistory(db, [bidDecision('kw-1'), bidDecision('kw-2')], {
      start: WINDOW_START,
      days: 1,
    });

    // kw-1 в выборку попал: его самая ранняя запись не может оказаться за отсечкой,
    // если хоть одна его запись внутри. kw-2 не попал — про него сказать нечего.
    expect(history.anchors.get(bidHistoryKey('KEYWORD', 'kw-1'))).toBe(200);
    expect(history.unavailable.has(bidHistoryKey('KEYWORD', 'kw-2'))).toBe(true);
  });

  it('режет список идентификаторов на порции, а не бьётся о стену bind-параметров', async () => {
    const db = createDb([]);
    const decisions = Array.from({ length: 1200 }, (_unused, index) => bidDecision(`kw-${index}`));

    await loadBidHistory(db, decisions, { start: WINDOW_START, days: 7 });

    expect(db.seen.map((call) => call.ids.length)).toEqual([500, 500, 200]);
    expect(db.seen.every((call) => call.take === call.ids.length * rowsPerEntityCap(7))).toBe(true);
  });
});

describe('noBidHistory', () => {
  it('пустая история — это «не двигали», а не «предохранитель выключен»', () => {
    const history = noBidHistory(7);
    expect(history.anchors.size).toBe(0);
    expect(history.unavailable.size).toBe(0);
    expect(history.windowDays).toBe(7);
  });
});

/**
 * Ставка группы объявлений ищет свою точку отсчёта там же, где и ставка фразы.
 *
 * У VK ставка живёт на группе, и якорь для неё обязан находиться в той же форме:
 * иначе оконный коридор схлопывается в шаговый — то есть предохранителя, ради
 * которого суммарный лимит и заводился, на этом уровне просто нет.
 */
describe('якорь для группы объявлений', () => {
  it('находится по своему типу сущности', async () => {
    const db = createDb([
      row('ag-1', { kind: 'bid', amount: 150 }, at(3), 'ADGROUP'),
      row('ag-1', { kind: 'bid', amount: 130 }, at(5), 'ADGROUP'),
    ]);

    const history = await loadBidHistory(db, [bidDecision('ag-1', 120, 102, 'ADGROUP')], {
      start: WINDOW_START,
      days: 7,
    });

    // Первая строка окна, а не последняя: якорь — то, чем ставка была на его начале.
    expect(history.anchors.get(bidHistoryKey('ADGROUP', 'ag-1'))).toBe(150);
    expect(history.unavailable.size).toBe(0);
    expect(db.seen.map((query) => query.entityType)).toEqual(['ADGROUP']);
  });

  it('не путает группу с фразой, у которой тот же id', async () => {
    // `CampaignStat.entityId` и журнал полиморфны: без типа в ключе история одной
    // сущности стала бы точкой отсчёта для другой.
    const db = createDb([
      row('x-1', { kind: 'bid', amount: 150 }, at(3), 'ADGROUP'),
      row('x-1', { kind: 'bid', amount: 40 }, at(3), 'KEYWORD'),
    ]);

    const history = await loadBidHistory(
      db,
      [bidDecision('x-1', 120, 102, 'ADGROUP'), bidDecision('x-1', 30, 25)],
      { start: WINDOW_START, days: 7 },
    );

    expect(history.anchors.get(bidHistoryKey('ADGROUP', 'x-1'))).toBe(150);
    expect(history.anchors.get(bidHistoryKey('KEYWORD', 'x-1'))).toBe(40);
    expect(new Set(db.seen.map((query) => query.entityType))).toEqual(
      new Set(['ADGROUP', 'KEYWORD']),
    );
  });
});
