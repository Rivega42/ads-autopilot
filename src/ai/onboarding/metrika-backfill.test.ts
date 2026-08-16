import { describe, expect, it, vi } from 'vitest';

// Настоящий PrismaClient здесь не нужен: хранилище всегда приходит аргументом.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { backfillMetrikaConfig } = await import('./metrika-backfill.js');

type Store = Parameters<typeof backfillMetrikaConfig>[0] extends { db?: infer T } ? T : never;

interface ClientRow {
  id: string;
  metrikaCounterId: number | null;
  metrikaGoalId: number | null;
  metrikaAttribution: string | null;
  brief: { data: unknown } | null;
}

interface Harness {
  db: Store;
  rows: ClientRow[];
}

function client(patch: Partial<ClientRow> & { id: string }): ClientRow {
  return {
    metrikaCounterId: null,
    metrikaGoalId: null,
    metrikaAttribution: null,
    brief: null,
    ...patch,
  };
}

/**
 * Хранилище с настоящей семантикой условий: проверяется как раз то, что повторный
 * прогон ничего не пишет, а это свойство отбора, а не вызова.
 */
function harness(rows: ClientRow[]): Harness {
  const matches = (row: ClientRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'brief' || key === 'AND') return true;
      return row[key as keyof ClientRow] === value;
    });

  const db = {
    client: {
      findMany: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.filter((row) => matches(row, args.where))),
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((row) => matches(row, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return Promise.resolve({ count: hit.length });
      },
    },
  } as unknown as Store;

  return { db, rows };
}

const BRIEF_WITH_METRIKA = {
  metrika: { counterId: 12_345_678, goalId: 555, attribution: 'LASTSIGN' },
  conversionGoals: [{ name: 'заявка' }],
};

describe('backfillMetrikaConfig', () => {
  it('переносит настройку Метрики из готового брифа в карточку клиента', async () => {
    const { db, rows } = harness([client({ id: 'cl1', brief: { data: BRIEF_WITH_METRIKA } })]);

    const result = await backfillMetrikaConfig({ db });

    expect(result).toMatchObject({ scanned: 1, updated: 1, skipped: 0 });
    expect(rows[0]).toMatchObject({
      metrikaCounterId: 12_345_678,
      metrikaGoalId: 555,
      metrikaAttribution: 'LASTSIGN',
    });
  });

  it('второй прогон ничего не пишет', async () => {
    const { db } = harness([client({ id: 'cl1', brief: { data: BRIEF_WITH_METRIKA } })]);

    await backfillMetrikaConfig({ db });
    const second = await backfillMetrikaConfig({ db });

    // Клиент со счётчиком в отбор уже не попадает — иначе это был бы вечный апдейт.
    expect(second).toMatchObject({ scanned: 0, updated: 0 });
  });

  it('не затирает то, что уже проставлено руками', async () => {
    const { db, rows } = harness([
      client({
        id: 'cl1',
        metrikaGoalId: 42,
        metrikaAttribution: 'LAST',
        brief: { data: BRIEF_WITH_METRIKA },
      }),
    ]);

    await backfillMetrikaConfig({ db });

    expect(rows[0]).toMatchObject({
      metrikaCounterId: 12_345_678,
      metrikaGoalId: 42,
      metrikaAttribution: 'LAST',
    });
  });

  it('берёт цель из целевых действий, если блока Метрики в брифе нет', async () => {
    // Брифы, собранные до вопроса про Метрику: счётчика в них нет и взяться ему неоткуда.
    const { db, rows } = harness([
      client({
        id: 'cl1',
        brief: { data: { conversionGoals: [{ name: 'заявка', metrikaGoalId: 777 }] } },
      }),
    ]);

    const result = await backfillMetrikaConfig({ db });

    expect(result).toMatchObject({ updated: 1 });
    expect(rows[0]).toMatchObject({ metrikaCounterId: null, metrikaGoalId: 777 });
  });

  it('несколько целей в брифе оставляет человеку, а не выбирает сам', async () => {
    const { db, rows } = harness([
      client({
        id: 'cl1',
        brief: {
          data: {
            conversionGoals: [
              { name: 'заявка', metrikaGoalId: 1 },
              { name: 'звонок', metrikaGoalId: 2 },
            ],
          },
        },
      }),
    ]);

    const result = await backfillMetrikaConfig({ db });

    expect(result.ambiguous).toEqual(['cl1']);
    expect(rows[0]?.metrikaGoalId).toBeNull();
  });

  it('бриф без единого следа Метрики строку не трогает', async () => {
    const { db, rows } = harness([
      client({ id: 'cl1', brief: { data: { conversionGoals: [{ name: 'заявка' }] } } }),
    ]);

    const result = await backfillMetrikaConfig({ db });

    expect(result).toMatchObject({ scanned: 1, updated: 0, skipped: 1 });
    expect(rows[0]?.metrikaGoalId).toBeNull();
  });

  it('«Метрики нет» в брифе — не повод что-либо писать', async () => {
    const { db, rows } = harness([
      client({
        id: 'cl1',
        brief: { data: { metrika: null, conversionGoals: [{ name: 'заявка', metrikaGoalId: 9 }] } },
      }),
    ]);

    expect(await backfillMetrikaConfig({ db })).toMatchObject({ updated: 0, skipped: 1 });
    expect(rows[0]?.metrikaGoalId).toBeNull();
  });

  it('битые данные брифа не роняют прогон по остальным клиентам', async () => {
    const { db, rows } = harness([
      client({ id: 'cl1', brief: { data: 'не json-объект' } }),
      client({ id: 'cl2', brief: { data: BRIEF_WITH_METRIKA } }),
    ]);

    const result = await backfillMetrikaConfig({ db });

    expect(result).toMatchObject({ scanned: 2, updated: 1, skipped: 1 });
    expect(rows[1]?.metrikaCounterId).toBe(12_345_678);
  });
});
