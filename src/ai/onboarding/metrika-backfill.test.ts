import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Настоящий PrismaClient здесь не нужен: хранилище всегда приходит аргументом.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));
vi.mock('@/logger.js', () => ({
  logger: { child: () => ({ info: h.info, warn: h.warn, error: h.error, debug: vi.fn() }) },
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backfillMetrikaConfig', () => {
  it('переносит настройку Метрики из готового брифа в карточку клиента', async () => {
    const { db, rows } = harness([client({ id: 'cl1', brief: { data: BRIEF_WITH_METRIKA } })]);

    const result = await backfillMetrikaConfig({ db, apply: true });

    expect(result).toMatchObject({ scanned: 1, configured: 1, goalOnly: [], skipped: 0 });
    expect(rows[0]).toMatchObject({
      metrikaCounterId: 12_345_678,
      metrikaGoalId: 555,
      metrikaAttribution: 'LASTSIGN',
    });
  });

  it('без --apply ничего не пишет, но показывает, что сделал бы', async () => {
    const { db, rows } = harness([client({ id: 'cl1', brief: { data: BRIEF_WITH_METRIKA } })]);

    const result = await backfillMetrikaConfig({ db });

    expect(result).toMatchObject({ scanned: 1, configured: 1, applied: false });
    expect(rows[0]).toMatchObject({ metrikaCounterId: null, metrikaGoalId: null });
  });

  it('второй прогон ничего не пишет', async () => {
    const { db } = harness([client({ id: 'cl1', brief: { data: BRIEF_WITH_METRIKA } })]);

    await backfillMetrikaConfig({ db, apply: true });
    const second = await backfillMetrikaConfig({ db, apply: true });

    // Клиент со счётчиком в отбор уже не попадает — иначе это был бы вечный апдейт.
    expect(second).toMatchObject({ scanned: 0, configured: 0, goalOnly: [] });
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

    await backfillMetrikaConfig({ db, apply: true });

    expect(rows[0]).toMatchObject({
      metrikaCounterId: 12_345_678,
      metrikaGoalId: 42,
      metrikaAttribution: 'LAST',
    });
  });

  it('цель без счётчика считает отдельно: конверсии от такой записи не поедут', async () => {
    // Брифы, собранные до вопроса про Метрику: счётчика в них нет и взяться ему неоткуда.
    const { db, rows } = harness([
      client({
        id: 'cl1',
        brief: { data: { conversionGoals: [{ name: 'заявка', metrikaGoalId: 777 }] } },
      }),
    ]);

    const result = await backfillMetrikaConfig({ db, apply: true });

    expect(result).toMatchObject({ scanned: 1, configured: 0, goalOnly: ['cl1'] });
    expect(rows[0]).toMatchObject({ metrikaCounterId: null, metrikaGoalId: 777 });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'cl1' }),
      expect.stringContaining('incomplete'),
    );
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

    const result = await backfillMetrikaConfig({ db, apply: true });

    expect(result.ambiguous).toEqual(['cl1']);
    expect(rows[0]?.metrikaGoalId).toBeNull();
  });

  it('бриф без единого следа Метрики строку не трогает', async () => {
    const { db, rows } = harness([
      client({ id: 'cl1', brief: { data: { conversionGoals: [{ name: 'заявка' }] } } }),
    ]);

    const result = await backfillMetrikaConfig({ db, apply: true });

    expect(result).toMatchObject({ scanned: 1, configured: 0, goalOnly: [], skipped: 1 });
    expect(rows[0]?.metrikaGoalId).toBeNull();
  });

  it('«Метрики нет» в брифе — не повод что-либо писать', async () => {
    const { db, rows } = harness([
      client({
        id: 'cl1',
        brief: { data: { metrika: null, conversionGoals: [{ name: 'заявка', metrikaGoalId: 9 }] } },
      }),
    ]);

    expect(await backfillMetrikaConfig({ db, apply: true })).toMatchObject({
      configured: 0,
      goalOnly: [],
      skipped: 1,
    });
    expect(rows[0]?.metrikaGoalId).toBeNull();
  });

  it('битые данные брифа не роняют прогон, но и не молчат', async () => {
    const { db, rows } = harness([
      client({ id: 'cl1', brief: { data: 'не json-объект' } }),
      client({ id: 'cl2', brief: { data: BRIEF_WITH_METRIKA } }),
    ]);

    const result = await backfillMetrikaConfig({ db, apply: true });

    expect(result).toMatchObject({ scanned: 2, configured: 1, skipped: 1 });
    expect(rows[1]?.metrikaCounterId).toBe(12_345_678);
    // Молча пропущенный клиент выглядит как клиент без Метрики и теряется навсегда.
    expect(h.error).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'cl1' }),
      expect.stringContaining('brief data'),
    );
  });
});
