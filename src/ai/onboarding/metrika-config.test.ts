import { describe, expect, it, vi } from 'vitest';

import type { ClientBriefData } from './brief.schema.js';

// Настоящий PrismaClient здесь не нужен: хранилище всегда приходит аргументом.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { isMetrikaConfigComplete, metrikaConfigFromBrief, saveMetrikaConfig } =
  await import('./metrika-config.js');

const CLIENT = 'cl1';

const BRIEF: ClientBriefData = {
  product: 'Курсы английского для айтишников',
  audience: { description: 'Разработчики 25-40 лет' },
  geo: ['Москва'],
  negativeCities: [],
  usp: ['Преподаватели из IT'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [],
  conversionGoals: [{ name: 'заявка на пробный урок' }],
  metrika: null,
};

interface ClientStoreHarness {
  db: Parameters<typeof saveMetrikaConfig>[2];
  updates: Array<Record<string, unknown>>;
}

function clientStore(): ClientStoreHarness {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    client: {
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: args.where.id, ...args.data });
        return Promise.resolve({ id: args.where.id });
      },
    },
  } as unknown as ClientStoreHarness['db'];
  return { db, updates };
}

describe('metrikaConfigFromBrief', () => {
  it('берёт счётчик, цель и модель атрибуции из ответа клиента', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      metrika: { counterId: 12_345_678, goalId: 555, attribution: 'LAST_YANDEX_DIRECT_CLICK' },
    };

    expect(metrikaConfigFromBrief(brief)).toEqual({
      config: {
        metrikaCounterId: 12_345_678,
        metrikaGoalId: 555,
        metrikaAttribution: 'LAST_YANDEX_DIRECT_CLICK',
      },
      ambiguousGoalIds: [],
    });
  });

  it('«Метрики нет» — пустая конфигурация, а не ошибка', () => {
    expect(metrikaConfigFromBrief(BRIEF)).toEqual({
      config: { metrikaCounterId: null, metrikaGoalId: null, metrikaAttribution: null },
      ambiguousGoalIds: [],
    });
  });

  it('«Метрики нет» перебивает id цели из целевых действий', () => {
    // Клиент сказал прямо; id цели в списке действий — в лучшем случае чужой.
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [{ name: 'заявка', metrikaGoalId: 555 }],
    };

    expect(metrikaConfigFromBrief(brief).config.metrikaGoalId).toBeNull();
  });

  it('цель берёт из целевых действий, если отдельно её не назвали', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [{ name: 'заявка', metrikaGoalId: 555 }],
      metrika: { counterId: 12_345_678 },
    };

    expect(metrikaConfigFromBrief(brief).config.metrikaGoalId).toBe(555);
  });

  it('две разные цели — выбор человека, а не первой попавшейся', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [
        { name: 'заявка', metrikaGoalId: 1 },
        { name: 'звонок', metrikaGoalId: 2 },
      ],
      metrika: { counterId: 12_345_678 },
    };

    const { config, ambiguousGoalIds } = metrikaConfigFromBrief(brief);
    expect(config.metrikaGoalId).toBeNull();
    expect(ambiguousGoalIds).toEqual([1, 2]);
  });

  it('названная цель снимает неоднозначность целевых действий', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [
        { name: 'заявка', metrikaGoalId: 1 },
        { name: 'звонок', metrikaGoalId: 2 },
      ],
      metrika: { counterId: 12_345_678, goalId: 2 },
    };

    const { config, ambiguousGoalIds } = metrikaConfigFromBrief(brief);
    expect(config.metrikaGoalId).toBe(2);
    expect(ambiguousGoalIds).toEqual([]);
  });

  it('одна и та же цель, названная дважды, неоднозначностью не считается', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [
        { name: 'заявка с формы', metrikaGoalId: 7 },
        { name: 'заявка из квиза', metrikaGoalId: 7 },
      ],
      metrika: { counterId: 12_345_678 },
    };

    expect(metrikaConfigFromBrief(brief).ambiguousGoalIds).toEqual([]);
  });
});

describe('saveMetrikaConfig', () => {
  it('пишет счётчик, цель и атрибуцию в карточку клиента', async () => {
    const store = clientStore();
    const brief: ClientBriefData = {
      ...BRIEF,
      metrika: { counterId: 12_345_678, goalId: 555, attribution: 'LASTSIGN' },
    };

    const saved = await saveMetrikaConfig(CLIENT, brief, store.db);

    expect(saved).toEqual({
      metrikaCounterId: 12_345_678,
      metrikaGoalId: 555,
      metrikaAttribution: 'LASTSIGN',
    });
    expect(store.updates).toEqual([
      {
        id: CLIENT,
        metrikaCounterId: 12_345_678,
        metrikaGoalId: 555,
        metrikaAttribution: 'LASTSIGN',
      },
    ]);
  });

  it('не пишет колонки, о которых бриф молчит', async () => {
    const store = clientStore();
    const brief: ClientBriefData = { ...BRIEF, metrika: { counterId: 12_345_678 } };

    await saveMetrikaConfig(CLIENT, brief, store.db);

    // `null` в апдейте затёр бы то, что могли проставить руками.
    expect(store.updates).toEqual([{ id: CLIENT, metrikaCounterId: 12_345_678 }]);
  });

  it('без Метрики строку не трогает', async () => {
    const store = clientStore();

    expect(await saveMetrikaConfig(CLIENT, BRIEF, store.db)).toBeNull();
    expect(store.updates).toEqual([]);
  });

  it('бриф без счётчика даёт заведомо неполную настройку, а не включённую Метрику', async () => {
    const store = clientStore();
    const { metrika: _metrika, ...legacy } = BRIEF;
    const brief: ClientBriefData = {
      ...legacy,
      conversionGoals: [{ name: 'заявка', metrikaGoalId: 555 }],
    };

    const saved = await saveMetrikaConfig(CLIENT, brief, store.db);

    // Цель записывается — она пригодится, когда счётчик проставят руками. Но
    // загрузка конверсий требует обоих значений, и вызывающий обязан это видеть.
    expect(store.updates).toEqual([{ id: CLIENT, metrikaGoalId: 555 }]);
    expect(saved).not.toBeNull();
    expect(saved && isMetrikaConfigComplete(saved)).toBe(false);
  });
});

describe('isMetrikaConfigComplete', () => {
  it('полной считается только пара «счётчик + цель»', () => {
    expect(
      isMetrikaConfigComplete({
        metrikaCounterId: 12_345_678,
        metrikaGoalId: 555,
        metrikaAttribution: null,
      }),
    ).toBe(true);
  });

  it('одна цель без счётчика — это выключенная загрузка конверсий', () => {
    expect(
      isMetrikaConfigComplete({
        metrikaCounterId: null,
        metrikaGoalId: 555,
        metrikaAttribution: 'LASTSIGN',
      }),
    ).toBe(false);
    expect(
      isMetrikaConfigComplete({
        metrikaCounterId: 12_345_678,
        metrikaGoalId: null,
        metrikaAttribution: null,
      }),
    ).toBe(false);
  });
});
