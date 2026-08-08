import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';
import type { MetrikaGoalStat } from '@/clients/metrika.js';
import type { MetrikaSource } from '@/ingestion/metrika.js';

import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { directCampaignId, readMetrikaSettings, syncMetrikaConversions } =
  await import('@/ingestion/metrika.js');

const CLIENT = 'cl1';
const RANGE = { from: '2026-07-19', to: '2026-08-08' };
const CREDENTIALS = { accessToken: 'y0_token', metrikaCounterId: 12345, metrikaGoalId: 777 };

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  db.seed('client', [{ id: CLIENT, name: 'Ромашка', status: 'ACTIVE' }]);
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
    campaignExternalId: '100',
    goalId: 777,
    conversions: 12,
    revenue: 0,
    ...patch,
  };
}

describe('readMetrikaSettings', () => {
  it('собирает счётчик, цель и токен из секретов кабинета Директа', () => {
    expect(readMetrikaSettings(CREDENTIALS)).toEqual({
      counterId: 12345,
      goalId: 777,
      token: 'y0_token',
    });
  });

  it('без счётчика или цели настройки считаются отсутствующими', () => {
    expect(readMetrikaSettings({ accessToken: 'y0_token' })).toBeNull();
    expect(readMetrikaSettings({ accessToken: 'y0_token', metrikaCounterId: 1 })).toBeNull();
  });
});

describe('directCampaignId', () => {
  it('понимает и голый номер, и номер внутри имени', () => {
    expect(directCampaignId('100')).toBe('100');
    expect(directCampaignId('Кампания №87654321')).toBe('87654321');
    expect(directCampaignId('не определено')).toBeUndefined();
    expect(directCampaignId(undefined)).toBeUndefined();
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
  });

  it('без настроенного счётчика тихо пропускает клиента', async () => {
    const result = await syncMetrikaConversions(CLIENT, deps([goalStat()], { accessToken: 'y0' }));

    expect(result.configured).toBe(false);
    expect(db.store.campaignStat).toHaveLength(0);
  });

  it('считает несопоставленные кампании, а не приписывает их первой попавшейся', async () => {
    const result = await syncMetrikaConversions(
      CLIENT,
      deps([goalStat({ campaignExternalId: 'не определено' })]),
    );

    expect(result.unresolved).toBe(1);
    expect(db.store.campaignStat).toHaveLength(0);
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
});
