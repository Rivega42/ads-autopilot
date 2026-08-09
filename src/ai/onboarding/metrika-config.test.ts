import { describe, expect, it, vi } from 'vitest';

import type { ClientBriefData } from './brief.schema.js';

// Настоящий PrismaClient здесь не нужен: хранилище всегда приходит аргументом.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { metrikaConfigFromBrief, saveMetrikaConfig } = await import('./metrika-config.js');

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
  it('берёт единственную названную цель', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [{ name: 'заявка', metrikaGoalId: 555 }],
    };

    expect(metrikaConfigFromBrief(brief)).toEqual({
      config: { metrikaCounterId: null, metrikaGoalId: 555 },
      ambiguousGoalIds: [],
    });
  });

  it('номер счётчика не выдумывает: в брифе его нет', () => {
    // Счётчик чужого аккаунта тихо приписал бы клиенту чужие конверсии, а по ним
    // потом двигаются ставки. Пусто — честнее.
    expect(metrikaConfigFromBrief(BRIEF).config.metrikaCounterId).toBeNull();
  });

  it('две разные цели — выбор человека, а не первой попавшейся', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [
        { name: 'заявка', metrikaGoalId: 1 },
        { name: 'звонок', metrikaGoalId: 2 },
      ],
    };

    const { config, ambiguousGoalIds } = metrikaConfigFromBrief(brief);
    expect(config.metrikaGoalId).toBeNull();
    expect(ambiguousGoalIds).toEqual([1, 2]);
  });

  it('одна и та же цель, названная дважды, неоднозначностью не считается', () => {
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [
        { name: 'заявка с формы', metrikaGoalId: 7 },
        { name: 'заявка из квиза', metrikaGoalId: 7 },
      ],
    };

    expect(metrikaConfigFromBrief(brief)).toEqual({
      config: { metrikaCounterId: null, metrikaGoalId: 7 },
      ambiguousGoalIds: [],
    });
  });
});

describe('saveMetrikaConfig', () => {
  it('пишет цель из брифа в карточку клиента', async () => {
    const store = clientStore();
    const brief: ClientBriefData = {
      ...BRIEF,
      conversionGoals: [{ name: 'заявка', metrikaGoalId: 555 }],
    };

    const saved = await saveMetrikaConfig(CLIENT, brief, store.db);

    expect(saved).toEqual({ metrikaCounterId: null, metrikaGoalId: 555 });
    expect(store.updates).toEqual([{ id: CLIENT, metrikaGoalId: 555 }]);
  });

  it('без цели в брифе строку не трогает', async () => {
    const store = clientStore();

    expect(await saveMetrikaConfig(CLIENT, BRIEF, store.db)).toBeNull();
    // Пустой апдейт затёр бы то, что могли проставить руками.
    expect(store.updates).toEqual([]);
  });
});
