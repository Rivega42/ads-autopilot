import { Provider } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  campaignSlot,
  createAddresses,
  createdCampaigns,
  keyOfAddress,
  type CreatedCampaign,
  type CreatedStore,
} from '@/campaigns/created.js';
import { campaignCreateKey, PENDING_EXTERNAL_ID } from '@/campaigns/idempotency.js';
import type { CampaignPlan } from '@/campaigns/plan.schema.js';
import { CAMPAIGN_PLAN_PROVIDER } from '@/campaigns/store.js';

/**
 * Адрес операции создания — единственное, что не даёт создать кампанию дважды
 * после того, как план пересобрали. Поэтому проверяется не «функция что-то
 * вернула», а два свойства: адрес переживает смену плана и не переиспользуется,
 * когда человек попросил ещё одну кампанию.
 */

const CLIENT_ID = 'client-1';
const OTHER_CLIENT = 'client-2';
const PLAN_ID = 'plan-1';

const SEARCH = { channel: Provider.YANDEX_DIRECT, placement: 'search' as const };
const NETWORK = { channel: Provider.YANDEX_DIRECT, placement: 'network' as const };

interface FakeState {
  keys?: { key: string; entityId: string }[];
  plans?: { id: string; payload: unknown }[];
}

interface KeyWhere {
  key?: { startsWith?: string };
  OR?: KeyWhere[];
}

function matchesKey(key: string, where: KeyWhere): boolean {
  if (where.OR) return where.OR.some((clause) => matchesKey(key, clause));
  const prefix = where.key?.startsWith;
  return prefix === undefined || key.startsWith(prefix);
}

function fakeStore(state: FakeState): CreatedStore {
  return {
    idempotencyKey: {
      findMany: ({ where }: { where: KeyWhere }) =>
        Promise.resolve((state.keys ?? []).filter((row) => matchesKey(row.key, where))),
    },
    creative: {
      findMany: () => Promise.resolve((state.plans ?? []).map((plan) => ({ id: plan.id }))),
      findUnique: ({ where }: { where: { id: string } }) => {
        const plan = (state.plans ?? []).find((row) => row.id === where.id);
        return Promise.resolve(
          plan ? { id: plan.id, provider: CAMPAIGN_PLAN_PROVIDER, payload: plan.payload } : null,
        );
      },
    },
  } as unknown as CreatedStore;
}

function planOf(): CampaignPlan {
  const campaign = {
    channel: Provider.YANDEX_DIRECT,
    targetCpaRub: 2_000,
    strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
    negativeKeywords: [],
    adGroups: [
      {
        name: 'Горячий спрос',
        regionIds: [213],
        keywords: [{ phrase: 'курсы английского', bidRub: 100 }],
        negativeKeywords: [],
        ads: [{ title: 'Английский для IT', text: 'Курс с практикой', href: 'https://e.com/a' }],
      },
    ],
  };
  return {
    id: PLAN_ID,
    clientId: CLIENT_ID,
    createdAt: new Date('2026-08-01T10:00:00Z').toISOString(),
    totalDailyBudgetRub: 5_000,
    summary: 'План на поиск и РСЯ',
    campaigns: [
      { ...campaign, ...SEARCH, name: 'Поиск — Курсы', dailyBudgetRub: 3_500 },
      { ...campaign, ...NETWORK, name: 'РСЯ — Курсы', dailyBudgetRub: 1_500 },
    ],
    warnings: [],
    prompts: [],
  };
}

function payloadOf(plan: CampaignPlan): unknown {
  return JSON.parse(JSON.stringify(plan)) as unknown;
}

describe('createdCampaigns: что у клиента уже создано', () => {
  it('читает адрес прямо из ключа — план для этого не нужен', async () => {
    const address = `${CLIENT_ID}:${Provider.YANDEX_DIRECT}:search:0`;
    const created = await createdCampaigns(
      fakeStore({ keys: [{ key: keyOfAddress(address), entityId: '777' }] }),
      CLIENT_ID,
    );

    expect(created).toEqual<CreatedCampaign[]>([
      {
        address,
        slot: campaignSlot(SEARCH),
        channel: Provider.YANDEX_DIRECT,
        placement: 'search',
        name: null,
        externalId: '777',
      },
    ]);
  });

  it('чужие ключи не считает своими', async () => {
    const created = await createdCampaigns(
      fakeStore({
        keys: [
          {
            key: keyOfAddress(`${OTHER_CLIENT}:${Provider.YANDEX_DIRECT}:search:0`),
            entityId: '1',
          },
        ],
      }),
      CLIENT_ID,
    );
    expect(created).toEqual([]);
  });

  it('незавершённая попытка тоже занимает место', async () => {
    const created = await createdCampaigns(
      fakeStore({
        keys: [
          {
            key: keyOfAddress(`${CLIENT_ID}:${Provider.YANDEX_DIRECT}:network:0`),
            entityId: PENDING_EXTERNAL_ID,
          },
        ],
      }),
      CLIENT_ID,
    );
    expect(created).toMatchObject([{ slot: campaignSlot(NETWORK), externalId: null }]);
  });

  it('ключи старого формата разбираются через план, которым кампания создавалась', async () => {
    // Без этого разбора первый же план, собранный после выката, не увидел бы
    // кампаний, созданных до него, — то есть предложил бы создать их второй раз.
    const created = await createdCampaigns(
      fakeStore({
        plans: [{ id: PLAN_ID, payload: payloadOf(planOf()) }],
        keys: [{ key: campaignCreateKey(PLAN_ID, 1), entityId: '888' }],
      }),
      CLIENT_ID,
    );

    expect(created).toEqual<CreatedCampaign[]>([
      {
        address: `${PLAN_ID}:1`,
        slot: campaignSlot(NETWORK),
        channel: Provider.YANDEX_DIRECT,
        placement: 'network',
        name: 'РСЯ — Курсы',
        externalId: '888',
      },
    ]);
  });

  it('кампания по нечитаемому плану остаётся видимой, но без места', async () => {
    // Место неизвестно — значит и «свободно ли оно» неизвестно. Молча выкинуть
    // такую строку значило бы занять его второй раз; разбирается это человеком.
    const created = await createdCampaigns(
      fakeStore({
        plans: [{ id: PLAN_ID, payload: { что: 'это не план' } }],
        keys: [{ key: campaignCreateKey(PLAN_ID, 0), entityId: '999' }],
      }),
      CLIENT_ID,
    );
    expect(created).toMatchObject([{ slot: null, externalId: '999' }]);
  });
});

describe('createAddresses: адрес переживает смену плана', () => {
  const created: CreatedCampaign[] = [
    {
      address: `${PLAN_ID}:0`,
      slot: campaignSlot(SEARCH),
      channel: Provider.YANDEX_DIRECT,
      placement: 'search',
      name: 'Поиск — Курсы',
      externalId: '777',
    },
  ];

  it('новый план наследует адрес уже созданной кампании', () => {
    const address = createAddresses(CLIENT_ID, created);
    // Тот же ключ — значит ✅ по карточке нового плана упрётся в занятый ключ,
    // а не создаст вторую кампанию с тем же именем и тем же бюджетом.
    expect(address(SEARCH)).toBe(`${PLAN_ID}:0`);
    // Место, которого ещё нет в кабинете, получает адрес нового формата.
    expect(address(NETWORK)).toBe(`${CLIENT_ID}:${Provider.YANDEX_DIRECT}:network:0`);
  });

  it('«ещё одну кампанию» человек получает новым поколением адреса', () => {
    const address = createAddresses(CLIENT_ID, created, { fresh: true });
    expect(address(SEARCH)).toBe(`${CLIENT_ID}:${Provider.YANDEX_DIRECT}:search:1`);
  });

  it('без единой созданной кампании поколения начинаются с нуля', () => {
    const address = createAddresses(CLIENT_ID, []);
    expect(address(SEARCH)).toBe(`${CLIENT_ID}:${Provider.YANDEX_DIRECT}:search:0`);
    expect(address(NETWORK)).toBe(`${CLIENT_ID}:${Provider.YANDEX_DIRECT}:network:0`);
  });

  it('второй запрос того же места в одном плане адрес не повторяет', () => {
    // Планировщик такого плана не собирает (`planBudgets` даёт одно место один
    // раз), но повторный адрес означал бы две кампании с одним ключом: первая
    // создалась бы, вторая молча схлопнулась в «уже создана».
    const address = createAddresses(CLIENT_ID, []);
    expect(address(SEARCH)).not.toBe(address(SEARCH));
  });
});
