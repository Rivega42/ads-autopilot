import { BriefStatus, type Prisma } from '@prisma/client';

import type { BriefStore } from '@/ai/onboarding/interview.js';

/**
 * `ClientBrief` в памяти. Нужен и тестам интервью, и eval-прогонам: оба должны
 * гонять настоящую машину состояний (с оптимистичной блокировкой по `updatedAt`),
 * но без Postgres.
 */

export interface MemoryBriefRow {
  id: string;
  clientId: string;
  status: BriefStatus;
  data: Prisma.JsonValue;
  transcript: Prisma.JsonValue | null;
  completedAt: Date | null;
  updatedAt: Date;
}

interface FindArgs {
  where: { clientId?: string; id?: string };
}

interface CreateArgs {
  data: { clientId: string; data?: unknown; transcript?: unknown };
}

interface UpdateManyArgs {
  where: { id?: string; clientId?: string; updatedAt?: Date };
  data: {
    data?: unknown;
    transcript?: unknown;
    status?: BriefStatus;
    completedAt?: Date | null;
  };
}

export interface MemoryBriefStore {
  /** То, что передаётся агенту как `deps.db`. */
  db: BriefStore;
  rows: Map<string, MemoryBriefRow>;
  get(clientId: string): MemoryBriefRow | undefined;
  /** Сколько раз строку переписали — по нему видно, что каждый ход дошёл до БД. */
  writes: number;
}

export function createMemoryBriefStore(seed: readonly MemoryBriefRow[] = []): MemoryBriefStore {
  const rows = new Map<string, MemoryBriefRow>(seed.map((row) => [row.clientId, row]));
  const state = { writes: 0 };

  // Детерминированные «часы» БД: сравнение updatedAt в оптимистичной блокировке
  // должно работать так же, как в Postgres, но не зависеть от скорости теста.
  let tick = 0;
  const nextUpdatedAt = (): Date => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 8, 12, 0, tick));
  };

  const findRow = (where: FindArgs['where']): MemoryBriefRow | undefined => {
    if (where.clientId !== undefined) return rows.get(where.clientId);
    if (where.id !== undefined) return [...rows.values()].find((row) => row.id === where.id);
    return undefined;
  };

  const client = {
    findUnique: (args: FindArgs): Promise<MemoryBriefRow | null> =>
      Promise.resolve(findRow(args.where) ?? null),

    create: (args: CreateArgs): Promise<MemoryBriefRow> => {
      if (rows.has(args.data.clientId)) {
        return Promise.reject(Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        }));
      }
      const row: MemoryBriefRow = {
        id: `brief_${rows.size + 1}`,
        clientId: args.data.clientId,
        status: BriefStatus.IN_PROGRESS,
        data: (args.data.data ?? {}) as Prisma.JsonValue,
        transcript: (args.data.transcript ?? null) as Prisma.JsonValue | null,
        completedAt: null,
        updatedAt: nextUpdatedAt(),
      };
      rows.set(row.clientId, row);
      return Promise.resolve(row);
    },

    updateMany: (args: UpdateManyArgs): Promise<{ count: number }> => {
      const row = findRow(args.where);
      if (row === undefined) return Promise.resolve({ count: 0 });
      if (
        args.where.updatedAt !== undefined &&
        row.updatedAt.getTime() !== args.where.updatedAt.getTime()
      ) {
        return Promise.resolve({ count: 0 });
      }

      if (args.data.data !== undefined) row.data = args.data.data as Prisma.JsonValue;
      if (args.data.transcript !== undefined) {
        row.transcript = args.data.transcript as Prisma.JsonValue;
      }
      if (args.data.status !== undefined) row.status = args.data.status;
      if (args.data.completedAt !== undefined) row.completedAt = args.data.completedAt;
      row.updatedAt = nextUpdatedAt();
      state.writes += 1;
      return Promise.resolve({ count: 1 });
    },
  };

  return {
    db: { clientBrief: client } as unknown as BriefStore,
    rows,
    get: (clientId: string) => rows.get(clientId),
    get writes() {
      return state.writes;
    },
  };
}
