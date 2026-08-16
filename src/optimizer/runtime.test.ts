import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformWriteRequest } from './apply.js';

import type { ChannelAdapter, ChannelContext, WriteResult } from '@/channels/types.js';

const h = vi.hoisted(() => {
  const state: {
    keyword: Record<string, unknown> | null;
    adGroup: Record<string, unknown> | null;
    campaign: Record<string, unknown> | null;
    dryRun: boolean;
  } = { keyword: null, adGroup: null, campaign: null, dryRun: false };

  const adapter = {
    channel: 'YANDEX_DIRECT' as const,
    pauseEntities: vi.fn(),
    setBids: vi.fn(),
    setBudgets: vi.fn(),
    addNegativeKeywords: vi.fn(),
  };

  return {
    state,
    adapter,
    prisma: {
      idempotencyKey: { create: vi.fn(), deleteMany: vi.fn(async () => ({ count: 1 })) },
      changeLog: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
      campaign: { findUnique: vi.fn(async () => state.campaign) },
      adGroup: { findUnique: vi.fn(async () => state.adGroup) },
      ad: { findUnique: vi.fn(async () => null) },
      keyword: { findUnique: vi.fn(async () => state.keyword) },
    },
    registry: {
      getAdapter: vi.fn(() => adapter),
      buildContext: vi.fn(
        async (clientId: string): Promise<ChannelContext> => ({
          clientId,
          credentials: {},
          dryRun: state.dryRun,
        }),
      ),
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/channels/registry.js', () => ({
  getAdapter: h.registry.getAdapter,
  buildContext: h.registry.buildContext,
}));

const { createApplyDb, createPlatformWriter, createPrismaIdempotencyStore, fromWriteResult } =
  await import('./runtime.js');

const ctx = (dryRun: boolean): ChannelContext => ({ clientId: 'cl-1', credentials: {}, dryRun });

const keywordRow = (externalId: string | null): Record<string, unknown> => ({
  externalId,
  adGroup: { campaign: { clientId: 'cl-1', provider: 'YANDEX_DIRECT' } },
});

const negativeRequest: PlatformWriteRequest = {
  entityType: 'ADGROUP',
  entityId: 'ag-1',
  action: 'ADD_NEGATIVE_KEYWORD',
  prevValue: { kind: 'absent' },
  nextValue: { kind: 'negativeKeyword', phrase: 'скачать бесплатно' },
  idempotencyKey: 'opt:c-1:2026-08-16:ADGROUP:ag-1:ADD_NEGATIVE_KEYWORD:скачать бесплатно',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.keyword = keywordRow('ext-kw-1');
  h.state.adGroup = { externalId: 'ext-ag-1', campaign: { externalId: '777' } };
  h.state.campaign = { clientId: 'cl-1', provider: 'YANDEX_DIRECT', externalId: '777' };
  h.state.dryRun = false;
  h.adapter.pauseEntities.mockResolvedValue({ applied: true, plan: {} } as WriteResult);
  h.adapter.setBids.mockResolvedValue({ applied: true, plan: {} } as WriteResult);
  h.adapter.setBudgets.mockResolvedValue({ applied: true, plan: {} } as WriteResult);
  h.adapter.addNegativeKeywords.mockResolvedValue({ applied: true, plan: {} } as WriteResult);
});

describe('fromWriteResult', () => {
  it('reports a write the platform accepted as applied', () => {
    expect(fromWriteResult({ applied: true, plan: {} }, ctx(false))).toEqual({ status: 'applied' });
  });

  it('reports a dry-run as skipped', () => {
    expect(fromWriteResult({ applied: false, plan: {} }, ctx(true))).toEqual({
      status: 'skipped',
      reason: 'dry-run',
    });
  });

  it('reports "nothing to change" outside dry-run as a no-op, not as applied', () => {
    // Раньше это выдавалось за dry-run, а до того — за применение: в ChangeLog
    // ложилась запись об изменении, которого в кабинете не было.
    expect(fromWriteResult({ applied: false, plan: {} }, ctx(false))).toEqual({
      status: 'noop',
      reason: 'площадке нечего было менять',
    });
  });
});

describe('createPlatformWriter', () => {
  it('does not call the platform for an entity without an external id', async () => {
    h.state.keyword = keywordRow(null);
    const result = await createPlatformWriter()({
      entityType: 'KEYWORD',
      entityId: 'kw-1',
      action: 'PAUSE',
      prevValue: { kind: 'status', status: 'ACTIVE' },
      nextValue: { kind: 'status', status: 'PAUSED' },
      idempotencyKey: 'k',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'нет внешнего идентификатора' });
    expect(h.adapter.pauseEntities).not.toHaveBeenCalled();
  });

  it('pauses by external id at the level of the entity', async () => {
    const result = await createPlatformWriter()({
      entityType: 'KEYWORD',
      entityId: 'kw-1',
      action: 'PAUSE',
      prevValue: { kind: 'status', status: 'ACTIVE' },
      nextValue: { kind: 'status', status: 'PAUSED' },
      idempotencyKey: 'k',
    });

    expect(result).toEqual({ status: 'applied' });
    expect(h.adapter.pauseEntities).toHaveBeenCalledWith(expect.anything(), 'keyword', [
      'ext-kw-1',
    ]);
  });

  it('reports an already-present negative keyword as a no-op', async () => {
    h.adapter.addNegativeKeywords.mockResolvedValue({
      applied: false,
      plan: { added: [] },
    } as WriteResult);

    const result = await createPlatformWriter()(negativeRequest);

    expect(result).toEqual({ status: 'noop', reason: 'площадке нечего было менять' });
  });

  it('adds a negative keyword to the campaign of the ad group', async () => {
    const result = await createPlatformWriter()(negativeRequest);

    expect(result).toEqual({ status: 'applied' });
    expect(h.adapter.addNegativeKeywords).toHaveBeenCalledWith(expect.anything(), '777', [
      'скачать бесплатно',
    ]);
  });

  it('skips a negative keyword when the channel has no such method', async () => {
    const withoutNegatives = { ...h.adapter, addNegativeKeywords: undefined };
    h.registry.getAdapter.mockReturnValueOnce(withoutNegatives as unknown as ChannelAdapter);

    expect(await createPlatformWriter()(negativeRequest)).toEqual({
      status: 'skipped',
      reason: 'канал не поддерживает минус-слова',
    });
  });

  it('turns a thrown platform error into a failure instead of losing the run', async () => {
    h.adapter.setBids.mockRejectedValue(new Error('429 Too Many Requests'));

    const result = await createPlatformWriter()({
      entityType: 'KEYWORD',
      entityId: 'kw-1',
      action: 'BID_DECREASE',
      prevValue: { kind: 'bid', amount: 10 },
      nextValue: { kind: 'bid', amount: 8.5 },
      idempotencyKey: 'k',
    });

    expect(result.status).toBe('failed');
  });

  it('refuses a value of the wrong kind rather than sending it', async () => {
    const result = await createPlatformWriter()({
      entityType: 'CAMPAIGN',
      entityId: 'c-1',
      action: 'BUDGET_CHANGE',
      prevValue: { kind: 'absent' },
      nextValue: { kind: 'bid', amount: 10 },
      idempotencyKey: 'k',
    });

    expect(result.status).toBe('failed');
    expect(h.adapter.setBudgets).not.toHaveBeenCalled();
  });
});

describe('createPrismaIdempotencyStore', () => {
  it('reserves a free key', async () => {
    h.prisma.idempotencyKey.create.mockResolvedValue({});
    expect(await createPrismaIdempotencyStore(h.prisma).reserve('k1')).toBe('reserved');
  });

  it('reads a unique-constraint violation as a duplicate, not as a failure', async () => {
    h.prisma.idempotencyKey.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    expect(await createPrismaIdempotencyStore(h.prisma).reserve('k1')).toBe('duplicate');
  });

  it('rethrows anything that is not a duplicate', async () => {
    h.prisma.idempotencyKey.create.mockRejectedValue(new Error('connection refused'));
    await expect(createPrismaIdempotencyStore(h.prisma).reserve('k1')).rejects.toThrow(
      'connection refused',
    );
  });
});

describe('createApplyDb', () => {
  it('writes a ChangeLog row through the narrow port', async () => {
    h.prisma.changeLog.create.mockResolvedValue({ id: 'cl-1' });
    const db = createApplyDb(h.prisma);
    const row = await db.changeLog.create({
      data: {
        campaignId: 'c-1',
        entityType: 'KEYWORD',
        entityId: 'kw-1',
        action: 'PAUSE',
        prevValue: { kind: 'status', status: 'ACTIVE' },
        newValue: { kind: 'status', status: 'PAUSED' },
        reason: 'Пауза',
        actor: 'AI',
      },
    });

    expect(row.id).toBe('cl-1');
    expect(h.prisma.changeLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actor: 'AI', entityId: 'kw-1' }),
    });
  });
});
