import { beforeEach, describe, expect, it, vi } from 'vitest';

interface KeyRow {
  key: string;
  expiresAt: Date;
}

const h = vi.hoisted(() => {
  const state: { keys: KeyRow[] } = { keys: [] };
  return {
    state,
    prisma: {
      idempotencyKey: {
        deleteMany: vi.fn(async (args: { where: { expiresAt: { lte: Date } } }) => {
          const before = state.keys.length;
          state.keys = state.keys.filter((row) => row.expiresAt > args.where.expiresAt.lte);
          return { count: before - state.keys.length };
        }),
      },
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));

const { purgeExpiredIdempotencyKeys } = await import('./purge.js');

const NOW = new Date('2026-08-16T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.state.keys = [
    { key: 'creatives:ab:ag-1:aaa', expiresAt: new Date('2026-07-01T00:00:00.000Z') },
    { key: 'campaigns.create:plan-1:0', expiresAt: new Date('2026-08-16T08:59:00.000Z') },
    { key: 'creatives:ab:ag-2:bbb', expiresAt: new Date('2026-09-01T00:00:00.000Z') },
  ];
});

describe('purgeExpiredIdempotencyKeys', () => {
  it('удаляет только просроченные ключи', async () => {
    const purged = await purgeExpiredIdempotencyKeys(NOW);

    expect(purged).toBe(2);
    expect(h.state.keys.map((row) => row.key)).toEqual(['creatives:ab:ag-2:bbb']);
  });

  it('живой ключ переживает прогон: TTL — это срок, а не украшение', async () => {
    h.state.keys = [{ key: 'creatives:ab:ag-2:bbb', expiresAt: new Date('2026-09-01T00:00:00Z') }];

    expect(await purgeExpiredIdempotencyKeys(NOW)).toBe(0);
    expect(h.state.keys).toHaveLength(1);
  });

  it('сравнивает срок с переданным моментом, а не с now()', async () => {
    await purgeExpiredIdempotencyKeys(NOW);

    const [args] = h.prisma.idempotencyKey.deleteMany.mock.calls[0] ?? [];
    expect(args).toEqual({ where: { expiresAt: { lte: NOW } } });
  });
});
