import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('axios', () => ({ default: { create: () => ({ get }) } }));

const { MetrikaClient, METRIKA_MAX_PAGES, METRIKA_PAGE_LIMIT } =
  await import('@/clients/metrika.js');

interface MetrikaPage {
  data: Array<{
    dimensions: Array<{ name: string | null; id?: string | number }>;
    metrics: Array<number | null>;
  }>;
  total_rows?: number;
}

/** Страница ответа: `count` строк одной даты по разным кампаниям. */
function page(count: number, totalRows?: number, startId = 1): MetrikaPage {
  const data = Array.from({ length: count }, (_, i) => ({
    dimensions: [{ name: '2026-08-01' }, { name: String(startId + i) }],
    metrics: [1, 0],
  }));
  return totalRows === undefined ? { data } : { data, total_rows: totalRows };
}

function reply(pages: MetrikaPage[]): void {
  get.mockReset();
  for (const body of pages) get.mockResolvedValueOnce({ status: 200, data: body });
  get.mockResolvedValue({ status: 200, data: pages.at(-1) ?? { data: [] } });
}

function client(): InstanceType<typeof MetrikaClient> {
  return new MetrikaClient({ oauthToken: 'y0_token', counterId: 42 });
}

const PARAMS = { goalId: 777, from: '2026-07-19', to: '2026-08-08' };

beforeEach(() => {
  get.mockReset();
});

describe('getGoalConversions', () => {
  it('одна неполная страница — один запрос', async () => {
    reply([page(3)]);

    const rows = await client().getGoalConversions(PARAMS);

    expect(rows).toHaveLength(3);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]?.params).toMatchObject({ limit: '10000', offset: '1' });
  });

  it('дочитывает хвост, который не влез в первую страницу', async () => {
    // 480 кампаний × 21 день переваливают за страницу — раньше хвост терялся молча.
    reply([
      page(METRIKA_PAGE_LIMIT, METRIKA_PAGE_LIMIT + 5),
      page(5, METRIKA_PAGE_LIMIT + 5, METRIKA_PAGE_LIMIT + 1),
    ]);

    const rows = await client().getGoalConversions(PARAMS);

    expect(rows).toHaveLength(METRIKA_PAGE_LIMIT + 5);
    expect(get).toHaveBeenCalledTimes(2);
    // Смещение Метрики считается от единицы.
    expect(get.mock.calls[1]?.[1]?.params).toMatchObject({
      offset: String(METRIKA_PAGE_LIMIT + 1),
    });
  });

  it('не делает лишний запрос, когда страница ровно закрыла total_rows', async () => {
    reply([page(METRIKA_PAGE_LIMIT, METRIKA_PAGE_LIMIT)]);

    const rows = await client().getGoalConversions(PARAMS);

    expect(rows).toHaveLength(METRIKA_PAGE_LIMIT);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('падает, а не отдаёт половину, когда срез не влезает в бюджет страниц', async () => {
    reply([page(METRIKA_PAGE_LIMIT, METRIKA_PAGE_LIMIT * METRIKA_MAX_PAGES + 1)]);

    await expect(client().getGoalConversions(PARAMS)).rejects.toMatchObject({
      code: 'METRIKA_TOO_MANY_ROWS',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('строки без даты отбрасываются, а не превращаются в мусорный день', async () => {
    reply([{ data: [{ dimensions: [{ name: null }, { name: '100' }], metrics: [5, 0] }] }]);

    expect(await client().getGoalConversions(PARAMS)).toEqual([]);
  });

  it('берёт из среза и печатное имя, и номер из поля id', async () => {
    reply([
      {
        data: [
          {
            dimensions: [{ name: '2026-08-01' }, { id: 87_651_001, name: 'Торты 2026 — поиск' }],
            metrics: [5, 1200],
          },
        ],
      },
    ]);

    const rows = await client().getGoalConversions(PARAMS);

    // Номер не выцарапывается из имени: Метрика назвала его сама.
    expect(rows[0]).toEqual({
      date: '2026-08-01',
      campaignLabel: 'Торты 2026 — поиск',
      campaignId: '87651001',
      goalId: 777,
      conversions: 5,
      revenue: 1200,
    });
  });

  it('нечисловой id среза номером кампании не притворяется', async () => {
    reply([
      {
        data: [
          {
            dimensions: [{ name: '2026-08-01' }, { id: 'не определено', name: 'Не определено' }],
            metrics: [1, 0],
          },
        ],
      },
    ]);

    const rows = await client().getGoalConversions(PARAMS);

    expect(rows[0]).not.toHaveProperty('campaignId');
    expect(rows[0]).toMatchObject({ campaignLabel: 'Не определено' });
  });

  it('401 от Метрики — это ошибка авторизации, а не пустой отчёт', async () => {
    get.mockResolvedValue({ status: 401, data: {} });

    await expect(client().getGoalConversions(PARAMS)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});
