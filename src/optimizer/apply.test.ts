import { describe, expect, it, vi } from 'vitest';

import {
  applyDecisions,
  createInMemoryIdempotencyStore,
  idempotencyKeyFor,
  parseDecisionValue,
  rollbackChange,
  type ApplyDb,
  type ApplyDeps,
  type ChangeLogRecord,
  type PlatformWriteResult,
  type PlatformWriter,
} from './apply.js';
import type { Decision } from './types.js';

const NOW = new Date('2026-08-08T08:00:00.000Z');
const RUN_ID = 'opt:c-1:2026-08-08';

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    action: 'BID_DECREASE',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    prevValue: { kind: 'bid', amount: 10 },
    nextValue: { kind: 'bid', amount: 8.5 },
    reason: 'CPA 900.00 (1.80× цели 500.00)',
    requiresApproval: false,
    layer: 'rule',
    ruleId: 'decrease-bid-high-cpa',
    approvalKind: null,
    ...overrides,
  };
}

function changeLogRow(overrides: Partial<ChangeLogRecord> = {}): ChangeLogRecord {
  return {
    id: 'log-1',
    campaignId: 'c-1',
    entityType: 'KEYWORD',
    entityId: 'kw-1',
    action: 'BID_DECREASE',
    prevValue: { kind: 'bid', amount: 10 },
    newValue: { kind: 'bid', amount: 8.5 },
    reason: 'CPA выше цели',
    actor: 'AI',
    appliedAt: new Date('2026-08-07T08:00:00.000Z'),
    rolledBackAt: null,
    ...overrides,
  };
}

function createDb(row: ChangeLogRecord | null = changeLogRow()): ApplyDb {
  let created = 0;
  return {
    changeLog: {
      create: vi.fn(async ({ data }) => {
        created += 1;
        return changeLogRow({ id: `log-${created}`, ...data, reason: data.reason });
      }),
      findUnique: vi.fn(async () => row),
      update: vi.fn(async ({ where, data }) => changeLogRow({ id: where.id, ...data })),
    },
  };
}

function createDeps(overrides: Partial<ApplyDeps> = {}): ApplyDeps {
  const writer: PlatformWriter = vi.fn(async () => ({ status: 'applied' }) as PlatformWriteResult);
  return {
    db: createDb(),
    writeToPlatform: writer,
    idempotency: createInMemoryIdempotencyStore(),
    now: () => NOW,
    ...overrides,
  };
}

function params(decisions: Decision[], dryRun = false): Parameters<typeof applyDecisions>[1] {
  return { campaignId: 'c-1', runId: RUN_ID, decisions, dryRun };
}

describe('idempotencyKeyFor', () => {
  it('is stable for the same run and decision', () => {
    expect(idempotencyKeyFor(RUN_ID, decision())).toBe(idempotencyKeyFor(RUN_ID, decision()));
  });

  it('separates different actions on the same entity', () => {
    expect(idempotencyKeyFor(RUN_ID, decision())).not.toBe(
      idempotencyKeyFor(RUN_ID, decision({ action: 'PAUSE' })),
    );
  });

  it('separates different negative keywords on the same ad group', () => {
    const first = decision({
      action: 'ADD_NEGATIVE_KEYWORD',
      entityType: 'ADGROUP',
      entityId: 'ag-1',
      nextValue: { kind: 'negativeKeyword', phrase: 'бесплатно' },
    });
    const second = decision({
      ...first,
      nextValue: { kind: 'negativeKeyword', phrase: 'скачать' },
    });
    expect(idempotencyKeyFor(RUN_ID, first)).not.toBe(idempotencyKeyFor(RUN_ID, second));
  });
});

describe('createInMemoryIdempotencyStore', () => {
  it('reserves once and reports a repeat as duplicate', async () => {
    const store = createInMemoryIdempotencyStore();
    expect(await store.reserve('k')).toBe('reserved');
    expect(await store.reserve('k')).toBe('duplicate');
  });

  it('frees a released key', async () => {
    const store = createInMemoryIdempotencyStore();
    await store.reserve('k');
    await store.release('k');
    expect(await store.reserve('k')).toBe('reserved');
  });
});

describe('applyDecisions', () => {
  it('writes to the platform and records a ChangeLog row with actor AI', async () => {
    const deps = createDeps();
    const report = await applyDecisions(deps, params([decision()]));

    expect(report.applied).toHaveLength(1);
    expect(deps.writeToPlatform).toHaveBeenCalledWith({
      entityType: 'KEYWORD',
      entityId: 'kw-1',
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: 10 },
      nextValue: { kind: 'bid', amount: 8.5 },
      idempotencyKey: `${RUN_ID}:KEYWORD:kw-1:BID_DECREASE`,
    });
    expect(deps.db.changeLog.create).toHaveBeenCalledWith({
      data: {
        campaignId: 'c-1',
        entityType: 'KEYWORD',
        entityId: 'kw-1',
        action: 'BID_DECREASE',
        prevValue: { kind: 'bid', amount: 10 },
        newValue: { kind: 'bid', amount: 8.5 },
        reason: 'CPA 900.00 (1.80× цели 500.00)',
        actor: 'AI',
      },
    });
  });

  it('never applies a decision that still needs approval', async () => {
    const deps = createDeps();
    const report = await applyDecisions(
      deps,
      params([decision({ requiresApproval: true, approvalKind: 'BUDGET_CHANGE' })]),
    );

    expect(report.applied).toEqual([]);
    expect(report.skipped[0]?.reason).toBe('требуется апрув');
    expect(deps.writeToPlatform).not.toHaveBeenCalled();
    expect(deps.db.changeLog.create).not.toHaveBeenCalled();
  });

  it('writes nothing at all in dry-run and reports what it would do', async () => {
    const deps = createDeps();
    const report = await applyDecisions(
      deps,
      params([decision(), decision({ entityId: 'kw-2' })], true),
    );

    expect(report.planned).toHaveLength(2);
    expect(report.applied).toEqual([]);
    expect(deps.writeToPlatform).not.toHaveBeenCalled();
    expect(deps.db.changeLog.create).not.toHaveBeenCalled();
  });

  it('applies the same decision only once across repeated runs', async () => {
    const idempotency = createInMemoryIdempotencyStore();
    const first = createDeps({ idempotency });
    const second = createDeps({ idempotency });

    await applyDecisions(first, params([decision()]));
    const report = await applyDecisions(second, params([decision()]));

    expect(report.applied).toEqual([]);
    expect(report.skipped[0]?.reason).toContain('уже применено');
    expect(second.writeToPlatform).not.toHaveBeenCalled();
  });

  it('releases the key when the platform reports a failure, so a retry can proceed', async () => {
    const idempotency = createInMemoryIdempotencyStore();
    const failing = createDeps({
      idempotency,
      writeToPlatform: vi.fn(
        async () => ({ status: 'failed', reason: '429 rate limit' }) as PlatformWriteResult,
      ),
    });
    const failed = await applyDecisions(failing, params([decision()]));
    expect(failed.failed[0]).toMatchObject({ reason: '429 rate limit', platformApplied: false });

    const retry = createDeps({ idempotency });
    const report = await applyDecisions(retry, params([decision()]));
    expect(report.applied).toHaveLength(1);
  });

  it('treats a thrown platform error the same way', async () => {
    const deps = createDeps({
      writeToPlatform: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    });
    const report = await applyDecisions(deps, params([decision()]));

    expect(report.failed[0]).toMatchObject({ reason: 'socket hang up', platformApplied: false });
    expect(deps.db.changeLog.create).not.toHaveBeenCalled();
  });

  it('records a platform skip without touching the ChangeLog', async () => {
    const deps = createDeps({
      writeToPlatform: vi.fn(
        async () => ({ status: 'skipped', reason: 'ставка уже такая' }) as PlatformWriteResult,
      ),
    });
    const report = await applyDecisions(deps, params([decision()]));

    expect(report.skipped[0]?.reason).toBe('ставка уже такая');
    expect(deps.db.changeLog.create).not.toHaveBeenCalled();
  });

  it('records a platform no-op as such, never as an applied change', async () => {
    // Минус-слово, уже стоящее в кампании: строка в ChangeLog утверждала бы изменение,
    // которого не было, и аудит копил бы по 200 ложных записей в день.
    const deps = createDeps({
      writeToPlatform: vi.fn(
        async () => ({ status: 'noop', reason: 'площадке нечего было менять' }) as PlatformWriteResult,
      ),
    });
    const report = await applyDecisions(
      deps,
      params([
        decision({
          action: 'ADD_NEGATIVE_KEYWORD',
          entityType: 'ADGROUP',
          entityId: 'ag-1',
          prevValue: { kind: 'absent' },
          nextValue: { kind: 'negativeKeyword', phrase: 'даром' },
        }),
      ]),
    );

    expect(report.noop[0]?.reason).toBe('площадке нечего было менять');
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(deps.db.changeLog.create).not.toHaveBeenCalled();
  });

  it('frees the key after a no-op, so the phrase can still be sent later', async () => {
    const idempotency = createInMemoryIdempotencyStore();
    const noop = createDeps({
      idempotency,
      writeToPlatform: vi.fn(
        async () => ({ status: 'noop', reason: 'площадке нечего было менять' }) as PlatformWriteResult,
      ),
    });
    await applyDecisions(noop, params([decision()]));

    const retry = createDeps({ idempotency });
    expect((await applyDecisions(retry, params([decision()]))).applied).toHaveLength(1);
  });

  it('flags an applied change whose ChangeLog row could not be written', async () => {
    const db = createDb();
    vi.mocked(db.changeLog.create).mockRejectedValueOnce(new Error('connection reset'));
    const idempotency = createInMemoryIdempotencyStore();
    const deps = createDeps({ db, idempotency });

    const report = await applyDecisions(deps, params([decision()]));
    expect(report.failed[0]).toMatchObject({ reason: 'connection reset', platformApplied: true });

    // The key stays reserved: re-applying a change the platform already accepted is worse than
    // leaving one row unlogged.
    expect(await idempotency.reserve(idempotencyKeyFor(RUN_ID, decision()))).toBe('duplicate');
  });

  it('keeps going after one decision fails', async () => {
    const writeToPlatform: PlatformWriter = vi.fn(async (request) =>
      request.entityId === 'kw-1'
        ? ({ status: 'failed', reason: 'нет прав' } as PlatformWriteResult)
        : ({ status: 'applied' } as PlatformWriteResult),
    );
    const deps = createDeps({ writeToPlatform });
    const report = await applyDecisions(
      deps,
      params([decision(), decision({ entityId: 'kw-2' }), decision({ entityId: 'kw-3' })]),
    );

    expect(report.applied).toHaveLength(2);
    expect(report.failed).toHaveLength(1);
  });

  it('handles an empty batch', async () => {
    const report = await applyDecisions(createDeps(), params([]));
    expect(report).toMatchObject({ applied: [], skipped: [], failed: [], planned: [] });
  });
});

describe('rollbackChange', () => {
  it('writes the previous value back and stamps rolledBackAt', async () => {
    const deps = createDeps();
    const result = await rollbackChange(deps, 'log-1');

    expect(result.status).toBe('rolled_back');
    expect(deps.writeToPlatform).toHaveBeenCalledWith({
      entityType: 'KEYWORD',
      entityId: 'kw-1',
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: 8.5 },
      nextValue: { kind: 'bid', amount: 10 },
      idempotencyKey: 'rollback:log-1',
    });
    expect(deps.db.changeLog.update).toHaveBeenCalledWith({
      where: { id: 'log-1' },
      data: { rolledBackAt: NOW },
    });
  });

  it('restores a paused entity', async () => {
    const deps = createDeps({
      db: createDb(
        changeLogRow({
          action: 'PAUSE',
          prevValue: { kind: 'status', status: 'ACTIVE' },
          newValue: { kind: 'status', status: 'PAUSED' },
        }),
      ),
    });
    await rollbackChange(deps, 'log-1');

    expect(deps.writeToPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ nextValue: { kind: 'status', status: 'ACTIVE' } }),
    );
  });

  it('reports a missing row', async () => {
    const deps = createDeps({ db: createDb(null) });
    expect((await rollbackChange(deps, 'nope')).status).toBe('not_found');
  });

  it('refuses to roll back twice', async () => {
    const deps = createDeps({ db: createDb(changeLogRow({ rolledBackAt: NOW })) });
    const result = await rollbackChange(deps, 'log-1');

    expect(result.status).toBe('already_rolled_back');
    expect(deps.writeToPlatform).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'unknown entity type', row: changeLogRow({ entityType: 'PIXEL' }) },
    { name: 'unknown action', row: changeLogRow({ action: 'TELEPORT' }) },
    { name: 'unreadable prevValue', row: changeLogRow({ prevValue: 'ставка была 10' }) },
    { name: 'null prevValue', row: changeLogRow({ prevValue: null }) },
  ])('refuses a row with $name', async ({ row }) => {
    const deps = createDeps({ db: createDb(row) });
    const result = await rollbackChange(deps, 'log-1');

    expect(result.status).toBe('unsupported');
    expect(deps.writeToPlatform).not.toHaveBeenCalled();
    expect(deps.db.changeLog.update).not.toHaveBeenCalled();
  });

  it('leaves rolledBackAt untouched when the platform refuses', async () => {
    const deps = createDeps({
      writeToPlatform: vi.fn(
        async () => ({ status: 'failed', reason: 'ключ удалён' }) as PlatformWriteResult,
      ),
    });
    const result = await rollbackChange(deps, 'log-1');

    expect(result).toMatchObject({ status: 'failed', reason: 'ключ удалён' });
    expect(deps.db.changeLog.update).not.toHaveBeenCalled();
  });

  it('reports a thrown platform error', async () => {
    const deps = createDeps({
      writeToPlatform: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    expect(await rollbackChange(deps, 'log-1')).toMatchObject({
      status: 'failed',
      reason: 'timeout',
    });
  });
});

describe('parseDecisionValue', () => {
  it.each([
    { kind: 'bid', amount: 10 },
    { kind: 'budget', amount: 5000 },
    { kind: 'status', status: 'PAUSED' },
    { kind: 'negativeKeyword', phrase: 'бесплатно' },
    { kind: 'strategy', strategy: 'MANUAL_CPC' },
    { kind: 'absent' },
  ])('round-trips %o', (value) => {
    expect(parseDecisionValue(value)).toEqual(value);
  });

  it.each([
    null,
    undefined,
    'bid',
    42,
    {},
    { kind: 'bid' },
    { kind: 'bid', amount: 'дорого' },
    { kind: 'bid', amount: Number.NaN },
    { kind: 'status', status: 'DELETED' },
    { kind: 'negativeKeyword', phrase: 7 },
    { kind: 'unknown' },
  ])('rejects %o', (value) => {
    expect(parseDecisionValue(value)).toBeNull();
  });
});
