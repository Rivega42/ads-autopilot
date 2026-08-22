import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';
import type { MetrikaGoalStat } from '@/clients/metrika.js';
import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';
import type { MetrikaSettings, MetrikaSource } from '@/ingestion/metrika.js';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));
vi.mock('@/logger.js', () => ({
  logger: { child: () => ({ warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

const { directCampaignId, readMetrikaSettings, syncMetrikaConversions } =
  await import('@/ingestion/metrika.js');

const CLIENT = 'cl1';
const RANGE = { from: '2026-07-19', to: '2026-08-08' };
const CREDENTIALS = { accessToken: 'y0_token' };
const CONFIG = { metrikaCounterId: 12345, metrikaGoalId: 777, metrikaAttribution: null };

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  db.seed('client', [{ id: CLIENT, name: 'Ромашка', status: 'ACTIVE', ...CONFIG }]);
  db.seed('campaign', [
    { id: 'camp-1', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '100' },
  ]);
});

function deps(rows: MetrikaGoalStat[], credentials: Record<string, unknown> = CREDENTIALS) {
  const source: MetrikaSource = { getGoalConversions: vi.fn(async () => rows) };
  return {
    db: db.asPrisma(),
    contextFor: async (): Promise<ChannelContext> => ({
      clientId: CLIENT,
      credentials,
      dryRun: true,
    }),
    metrikaFor: () => source,
    range: RANGE,
    source,
  };
}

function goalStat(patch: Partial<MetrikaGoalStat> = {}): MetrikaGoalStat {
  return {
    date: '2026-08-01',
    campaignLabel: '100',
    goalId: 777,
    conversions: 12,
    revenue: 0,
    ...patch,
  };
}

describe('readMetrikaSettings', () => {
  it('берёт счётчик и цель из карточки клиента, а токен — из секретов кабинета', () => {
    expect(readMetrikaSettings(CONFIG, CREDENTIALS)).toEqual({
      counterId: 12345,
      goalId: 777,
      token: 'y0_token',
    });
  });

  it('игнорирует счётчик и цель, оставшиеся в зашифрованном payload', () => {
    // Настройка из payload недостижима: конфигурация читается только из Client.
    const legacy = { accessToken: 'y0_token', metrikaCounterId: 12345, metrikaGoalId: 777 };
    expect(
      readMetrikaSettings(
        { metrikaCounterId: null, metrikaGoalId: null, metrikaAttribution: null },
        legacy,
      ),
    ).toBeNull();
  });

  it('без счётчика или цели настройки считаются отсутствующими', () => {
    const empty = { metrikaCounterId: null, metrikaGoalId: null, metrikaAttribution: null };
    expect(readMetrikaSettings(empty, CREDENTIALS)).toBeNull();
    expect(readMetrikaSettings({ ...empty, metrikaCounterId: 1 }, CREDENTIALS)).toBeNull();
  });

  it('без токена настройки бесполезны, даже когда счётчик указан', () => {
    expect(readMetrikaSettings(CONFIG, {})).toBeNull();
  });

  it('передаёт модель атрибуции из карточки клиента', () => {
    expect(
      readMetrikaSettings({ ...CONFIG, metrikaAttribution: 'LASTSIGN' }, CREDENTIALS),
    ).toMatchObject({ attribution: 'LASTSIGN' });
    // Незнакомое значение молча не уезжает в запрос: у Метрики закрытый список.
    expect(
      readMetrikaSettings({ ...CONFIG, metrikaAttribution: 'КАК-НИБУДЬ' }, CREDENTIALS),
    ).not.toHaveProperty('attribution');
  });

  it('о незнакомой модели атрибуции говорит вслух, а не уезжает молча на умолчание', () => {
    readMetrikaSettings({ ...CONFIG, metrikaAttribution: 'КАК-НИБУДЬ' }, CREDENTIALS);

    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: 'КАК-НИБУДЬ' }),
      expect.stringContaining('metrikaAttribution'),
    );
  });
});

describe('directCampaignId', () => {
  const known = new Set(['100', '87654321']);

  it('понимает и голый номер, и номер внутри имени', () => {
    expect(directCampaignId({ campaignLabel: '100' }, known)).toEqual({
      status: 'matched',
      externalId: '100',
    });
    expect(directCampaignId({ campaignLabel: 'Кампания №87654321' }, known)).toEqual({
      status: 'matched',
      externalId: '87654321',
    });
  });

  it('год в названии больше не выигрывает у номера кампании', () => {
    // Прежняя регулярка `(\d{4,})` брала первую группу цифр — то есть «2026».
    expect(directCampaignId({ campaignLabel: 'Торты 2026 — поиск (№87654321)' }, known)).toEqual({
      status: 'matched',
      externalId: '87654321',
    });
  });

  it('принимает номер из поля id, когда Метрика его прислала', () => {
    expect(directCampaignId({ campaignId: '100', campaignLabel: 'Торты 2026' }, known)).toEqual({
      status: 'matched',
      externalId: '100',
    });
  });

  it('строку, в которой нет ни одной нашей кампании, не приписывает никому', () => {
    expect(directCampaignId({ campaignLabel: 'Поиск — торты 2026 (Москва)' }, known)).toEqual({
      status: 'unmatched',
      candidates: ['2026'],
    });
    expect(directCampaignId({ campaignLabel: 'не определено' }, known)).toEqual({
      status: 'unmatched',
      candidates: [],
    });
    expect(directCampaignId({}, known)).toEqual({ status: 'unmatched', candidates: [] });
  });

  it('на двух наших номерах в строке признаёт неоднозначность, а не берёт первый', () => {
    expect(directCampaignId({ campaignLabel: 'Копия 100 из 87654321' }, known)).toEqual({
      status: 'ambiguous',
      candidates: ['100', '87654321'],
    });
  });
});

describe('syncMetrikaConversions', () => {
  it('проставляет конверсии и пересчитывает CPA от уже записанного расхода', async () => {
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 6000,
        conversions: 3,
        cpa: 2000,
      },
    ]);

    const result = await syncMetrikaConversions(CLIENT, deps([goalStat({ conversions: 12 })]));

    expect(result).toMatchObject({ configured: true, fetched: 1, written: 1, unresolved: 0 });
    expect(db.store.campaignStat).toHaveLength(1);
    expect(db.store.campaignStat[0]?.['conversions']).toBe(12);
    expect(Number(db.store.campaignStat[0]?.['cpa'])).toBe(500);
    // Расход остаётся директовским: Метрика про деньги площадки ничего не знает.
    expect(Number(db.store.campaignStat[0]?.['spend'])).toBe(6000);
    // Строка обязана назвать свою модель атрибуции: CPA 500 ₽ посчитан по цели
    // Метрики и с директовским CPA соседней кампании не сравним.
    expect(db.store.campaignStat[0]?.['conversionSource']).toBe('METRIKA');
    expect(result.attribution).toMatchObject({ mixed: false, primary: 'METRIKA' });
  });

  it('токен берётся из секретов кабинета, а не из карточки клиента', async () => {
    const settings: MetrikaSettings[] = [];
    await syncMetrikaConversions(CLIENT, {
      ...deps([goalStat()]),
      metrikaFor: (s) => {
        settings.push(s);
        return { getGoalConversions: async () => [goalStat()] };
      },
    });

    expect(settings[0]).toEqual({ counterId: 12345, goalId: 777, token: 'y0_token' });
  });

  it('без настроенного счётчика тихо пропускает клиента', async () => {
    db.store.client[0] = { ...db.store.client[0], metrikaCounterId: null, metrikaGoalId: null };

    const result = await syncMetrikaConversions(CLIENT, deps([goalStat()]));

    expect(result.configured).toBe(false);
    expect(db.store.campaignStat).toHaveLength(0);
  });

  it('считает несопоставленные кампании, а не приписывает их первой попавшейся', async () => {
    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat({ campaignLabel: 'не определено' })]),
    );

    expect(result.unresolved).toBe(1);
    expect(db.store.campaignStat).toHaveLength(0);
  });

  it('год в названии кампании сопоставляется по номеру, а не по году', async () => {
    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat({ campaignLabel: 'Кофемашины 2024 — поиск (№100)' })]),
    );

    expect(result).toMatchObject({ written: 1, unresolved: 0 });
    expect(db.store.campaignStat[0]?.['conversions']).toBe(12);
  });

  it('неразобранный ответ не обнуляет окно и не уходит в лог молча', async () => {
    // Кампания переименована, номера в срезе нет вовсе: сопоставить нечем.
    // Прежнее поведение — все строки в `unresolved`, а дальше проход обнуления
    // стирал конверсии всего окна, потому что «Метрика про кампанию промолчала».
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 7,
        cpa: 1428.57,
        conversionSource: 'PLATFORM',
      },
    ]);

    const label = 'Поиск — торты 2026 (Москва)';
    const result = await syncMetrikaConversions(CLIENT, deps([goalStat({ campaignLabel: label })]));

    expect(result).toMatchObject({
      configured: true,
      fetched: 1,
      written: 0,
      zeroed: 0,
      unresolved: 1,
      zeroingSuspended: true,
    });
    // Человеку видно не только «одна строка не сопоставилась», но и какая именно.
    expect(result.unresolvedSamples).toEqual([label]);
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ unresolvedSamples: [label] }),
      expect.stringContaining('not matched'),
    );
    // Цифры остались на месте: их не за что было обнулять.
    expect(db.store.campaignStat[0]?.['conversions']).toBe(7);
    expect(Number(db.store.campaignStat[0]?.['cpa'])).toBe(1428.57);
  });

  it('одна несопоставленная строка не отменяет обнуление для остальных', async () => {
    // Метрика помнит кампанию, которой в кабинете уже нет: это её штатное
    // поведение, и оно не должно останавливать приведение окна к её ответу.
    db.seed('campaign', [
      { id: 'camp-2', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '200' },
    ]);
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-2',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 9,
        conversionSource: 'PLATFORM',
      },
    ]);

    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat(), goalStat({ campaignLabel: 'Кампания №87659999' })]),
    );

    expect(result).toMatchObject({
      written: 1,
      zeroed: 1,
      unresolved: 1,
      zeroingSuspended: false,
    });
    const second = db.store.campaignStat.find((r) => r['entityId'] === 'camp-2');
    expect(second?.['conversions']).toBe(0);
  });

  it('неоднозначная строка защищает от обнуления обе свои кампании', async () => {
    // «Копия 100 из 200» называет два номера, и оба — кампании этого клиента.
    // Строку адресовать нельзя, но известно, кому она могла принадлежать: обнулить
    // любую из двух значит выключить рабочую кампанию за то, что мы не поняли имя.
    db.seed('campaign', [
      { id: 'camp-2', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '200' },
    ]);
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-2',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 9,
        conversionSource: 'PLATFORM',
      },
    ]);

    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat(), goalStat({ campaignLabel: 'Копия 100 из 200' })]),
    );

    expect(result).toMatchObject({ unresolved: 1, shielded: 2, zeroingSuspended: false });
    const second = db.store.campaignStat.find((r) => r['entityId'] === 'camp-2');
    expect(second?.['conversions']).toBe(9);
    expect(second?.['conversionSource']).toBe('PLATFORM');
  });

  it('строка без единого опознавательного знака отменяет обнуление окна', async () => {
    // Ни номера в срезе, ни цифр в имени: строка могла принадлежать любой
    // кампании клиента, и исключить из обнуления некого. Единственный честный
    // ответ — не обнулять ничего.
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-02T00:00:00.000Z'),
        spend: 5000,
        conversions: 4,
        conversionSource: 'PLATFORM',
      },
    ]);

    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat(), goalStat({ campaignLabel: 'Поиск — окна' })]),
    );

    expect(result).toMatchObject({ unresolved: 1, zeroingSuspended: true, zeroed: 0 });
    const untouched = db.store.campaignStat.find(
      (r) => r['date'] instanceof Date && (r['date'] as Date).getUTCDate() === 2,
    );
    expect(untouched?.['conversions']).toBe(4);
  });

  it('складывает конверсии одной кампании за один день', async () => {
    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat({ conversions: 4 }), goalStat({ conversions: 6 })]),
    );

    expect(result.written).toBe(1);
    expect(db.store.campaignStat[0]?.['conversions']).toBe(10);
    // Расхода за этот день ещё нет — CPA не выдумываем.
    expect(db.store.campaignStat[0]?.['cpa']).toBeNull();
  });

  it('повторный прогон не создаёт вторую строку за тот же день', async () => {
    await syncMetrikaConversions(CLIENT, deps([goalStat()]));
    await syncMetrikaConversions(CLIENT, deps([goalStat()]));

    expect(db.store.campaignStat).toHaveLength(1);
  });

  it('обнуляет конверсии Директа там, где Метрика промолчала', async () => {
    db.seed('campaign', [
      { id: 'camp-2', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '200' },
    ]);
    // Обе кампании открутили по 10 000 ₽, Директ насчитал 7 и 9 конверсий.
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 7,
        cpa: 1428.57,
      },
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-2',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 9,
        cpa: 1111.11,
      },
    ]);

    // Метрика знает только про первую кампанию.
    const result = await syncMetrikaConversions(CLIENT, deps([goalStat({ conversions: 2 })]));

    expect(result).toMatchObject({ written: 1, zeroed: 1 });
    const first = db.store.campaignStat.find((r) => r['entityId'] === 'camp-1');
    const second = db.store.campaignStat.find((r) => r['entityId'] === 'camp-2');
    expect(first?.['conversions']).toBe(2);
    expect(Number(first?.['cpa'])).toBe(5_000);
    // Не 9 конверсий по атрибуции Директа: в колонке одна модель, и это Метрика.
    expect(second?.['conversions']).toBe(0);
    expect(second?.['cpa']).toBeNull();
    // Ноль — это ответ Метрики по её модели, а не остаток директовской цифры.
    expect(second?.['conversionSource']).toBe('METRIKA');
    expect(result.attribution).toMatchObject({ mixed: false, primary: 'METRIKA' });
  });

  it('перемечает нулевые строки Директа: ноль тоже принадлежит модели', async () => {
    db.seed('campaign', [
      { id: 'camp-2', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '200' },
    ]);
    // Директ уже записал честный ноль. Значение менять не на что, но модель
    // атрибуции у этой строки другая — и без перепометки клиент остаётся смешанным.
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-2',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 3_000,
        conversions: 0,
        conversionSource: 'PLATFORM',
      },
    ]);

    const result = await syncMetrikaConversions(CLIENT, deps([goalStat({ conversions: 2 })]));

    const second = db.store.campaignStat.find((r) => r['entityId'] === 'camp-2');
    expect(second?.['conversions']).toBe(0);
    expect(second?.['conversionSource']).toBe('METRIKA');
    expect(result.attribution.mixed).toBe(false);
  });

  it('видит смешанную атрибуцию, а не полагается на порядок шагов', async () => {
    db.seed('campaign', [
      { id: 'camp-2', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '200' },
    ]);
    // Строка вне окна прогона: Метрика до неё не дотянется, а отчёт за месяц её
    // возьмёт — и сложит директовские конверсии с метрикиными.
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-2',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 9,
        conversionSource: 'PLATFORM',
      },
    ]);

    // Счётчик выключили: конверсии Метрики больше не приезжают.
    db.store.client[0] = { ...db.store.client[0], metrikaCounterId: null, metrikaGoalId: null };
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-02T00:00:00.000Z'),
        spend: 10_000,
        conversions: 4,
        conversionSource: 'METRIKA',
      },
    ]);

    const result = await syncMetrikaConversions(CLIENT, deps([goalStat()]));

    expect(result.configured).toBe(false);
    expect(result.attribution).toMatchObject({
      mixed: true,
      primary: null,
      models: ['PLATFORM', 'METRIKA'],
    });
  });

  it('не трогает дни за пределами окна', async () => {
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-06-01T00:00:00.000Z'),
        spend: 5_000,
        conversions: 4,
      },
    ]);

    await syncMetrikaConversions(CLIENT, deps([goalStat()]));

    const old = db.store.campaignStat.find(
      (r) => (r['date'] as Date).toISOString() === '2026-06-01T00:00:00.000Z',
    );
    expect(old?.['conversions']).toBe(4);
  });

  it('пустой ответ Метрики не стирает уже записанные конверсии', async () => {
    db.seed('campaignStat', [
      {
        entityType: 'CAMPAIGN',
        entityId: 'camp-1',
        date: new Date('2026-08-01T00:00:00.000Z'),
        spend: 10_000,
        conversions: 7,
      },
    ]);

    const result = await syncMetrikaConversions(CLIENT, deps([]));

    expect(result).toMatchObject({ configured: true, fetched: 0, written: 0, zeroed: 0 });
    expect(db.store.campaignStat[0]?.['conversions']).toBe(7);
  });
});
