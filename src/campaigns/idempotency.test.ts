import { describe, expect, it, vi } from 'vitest';

import {
  campaignCreateKey,
  CAMPAIGN_CREATE_SCOPE,
  createInMemoryCampaignIdempotency,
  createPrismaCampaignIdempotency,
  PENDING_EXTERNAL_ID,
  type IdempotencyStore,
} from '@/campaigns/idempotency.js';

/** Ошибка Prisma «нарушен уникальный индекс» в том виде, в каком её видит код. */
class UniqueViolation extends Error {
  readonly code = 'P2002';
}

interface Harness {
  db: IdempotencyStore;
  rows: Map<string, { entityId: string }>;
  created: Record<string, unknown>[];
}

function makeDb(): Harness {
  const rows = new Map<string, { entityId: string }>();
  const created: Record<string, unknown>[] = [];

  const db = {
    idempotencyKey: {
      create: (args: { data: Record<string, unknown> }) => {
        const key = String(args.data['key']);
        if (rows.has(key)) return Promise.reject(new UniqueViolation('duplicate key'));
        created.push(args.data);
        rows.set(key, { entityId: String(args.data['entityId']) });
        return Promise.resolve(args.data);
      },
      findUnique: (args: { where: { key: string } }) =>
        Promise.resolve(rows.get(args.where.key) ?? null),
      update: (args: { where: { key: string }; data: { entityId: string } }) => {
        rows.set(args.where.key, { entityId: args.data.entityId });
        return Promise.resolve({});
      },
      deleteMany: (args: { where: { key: string } }) => {
        rows.delete(args.where.key);
        return Promise.resolve({ count: 1 });
      },
    },
  } as unknown as IdempotencyStore;

  return { db, rows, created };
}

describe('createPrismaCampaignIdempotency', () => {
  it('первый резерв проходит, второй виден как повтор', async () => {
    const { db, created } = makeDb();
    const store = createPrismaCampaignIdempotency(db);
    const key = campaignCreateKey('plan-1', 0);

    expect(await store.reserve(key)).toEqual({ status: 'reserved' });
    expect(created[0]).toMatchObject({
      key,
      scope: CAMPAIGN_CREATE_SCOPE,
      entityType: 'campaign',
      entityId: PENDING_EXTERNAL_ID,
    });

    // Внешнего id ещё нет: предыдущая попытка не дошла до конца.
    expect(await store.reserve(key)).toEqual({ status: 'duplicate', externalId: null });
  });

  it('после complete повтор возвращает созданный внешний id', async () => {
    const { db } = makeDb();
    const store = createPrismaCampaignIdempotency(db);
    const key = campaignCreateKey('plan-1', 0);

    await store.reserve(key);
    await store.complete(key, '777');

    expect(await store.reserve(key)).toEqual({ status: 'duplicate', externalId: '777' });
  });

  it('release освобождает ключ для честного повтора', async () => {
    const { db } = makeDb();
    const store = createPrismaCampaignIdempotency(db);
    const key = campaignCreateKey('plan-1', 0);

    await store.reserve(key);
    await store.release(key);

    expect(await store.reserve(key)).toEqual({ status: 'reserved' });
  });

  it('ошибку, не связанную с уникальностью, не прячет', async () => {
    const db = {
      idempotencyKey: {
        create: () => Promise.reject(new Error('соединение с БД потеряно')),
      },
    } as unknown as IdempotencyStore;

    await expect(createPrismaCampaignIdempotency(db).reserve('k')).rejects.toThrow(
      'соединение с БД потеряно',
    );
  });

  it('ключ живёт ограниченное время', async () => {
    const { db, created } = makeDb();
    await createPrismaCampaignIdempotency(db, 1).reserve('k');

    const expiresAt = created[0]?.['expiresAt'];
    expect(expiresAt).toBeInstanceOf(Date);
    expect((expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('createInMemoryCampaignIdempotency', () => {
  it('ведёт себя так же, как реализация на Prisma', async () => {
    const store = createInMemoryCampaignIdempotency();
    const key = campaignCreateKey('plan-2', 1);

    expect(await store.reserve(key)).toEqual({ status: 'reserved' });
    expect(await store.reserve(key)).toEqual({ status: 'duplicate', externalId: null });

    await store.complete(key, '42');
    expect(await store.reserve(key)).toEqual({ status: 'duplicate', externalId: '42' });

    await store.release(key);
    expect(await store.reserve(key)).toEqual({ status: 'reserved' });
  });

  it('разные планы не мешают друг другу', async () => {
    const store = createInMemoryCampaignIdempotency();
    await store.reserve(campaignCreateKey('plan-1', 0));
    expect(await store.reserve(campaignCreateKey('plan-2', 0))).toEqual({ status: 'reserved' });
  });
});

describe('вызовы БД', () => {
  it('release использует deleteMany: отсутствующая строка — не ошибка', async () => {
    const deleteMany = vi.fn(() => Promise.resolve({ count: 0 }));
    const db = { idempotencyKey: { deleteMany } } as unknown as IdempotencyStore;

    await createPrismaCampaignIdempotency(db).release('k');
    expect(deleteMany).toHaveBeenCalledWith({ where: { key: 'k' } });
  });
});
