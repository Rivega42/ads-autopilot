import type { Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';
import { fakeAdapter, remoteAdGroup, remoteCampaign } from '@/ingestion/__tests__/fake-adapter.js';
import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';
import { AuthError } from '@/lib/errors.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { listIngestionTargets, runIngestion, runSearchQueryIngestion } =
  await import('@/ingestion/run.js');

const RANGE = { from: '2026-08-01', to: '2026-08-08' };
const CHANNELS = (): Provider[] => ['YANDEX_DIRECT', 'VK_ADS'];

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  db.seed('client', [
    { id: 'cl1', name: 'Ромашка', status: 'ACTIVE' },
    { id: 'cl2', name: 'Василёк', status: 'ACTIVE' },
    { id: 'cl3', name: 'Уснувший', status: 'PAUSED' },
  ]);
  db.seed('credential', [
    { id: 'cr1', clientId: 'cl1', provider: 'YANDEX_DIRECT' },
    { id: 'cr2', clientId: 'cl2', provider: 'YANDEX_DIRECT' },
    { id: 'cr3', clientId: 'cl3', provider: 'YANDEX_DIRECT' },
    { id: 'cr4', clientId: 'cl1', provider: 'TIKTOK_ADS' },
  ]);
});

const cabinet = {
  campaigns: [remoteCampaign()],
  adGroups: [remoteAdGroup()],
  stats: {
    campaign: [
      {
        date: '2026-08-01',
        entityExternalId: '100',
        impressions: 10,
        clicks: 1,
        spend: 12.34,
        conversions: 1,
      },
    ],
  },
};

/** Токен второго клиента протух — ровно та ситуация, которая не должна стоить данных первому. */
function contextForExcept(brokenClientId: string) {
  return async (clientId: string, provider: Provider): Promise<ChannelContext> => {
    if (clientId === brokenClientId) {
      throw new AuthError(provider, 'token expired', { clientId });
    }
    return { clientId, credentials: {}, dryRun: true };
  };
}

describe('listIngestionTargets', () => {
  it('берёт только активных клиентов и зарегистрированные каналы', async () => {
    const targets = await listIngestionTargets({ db: db.asPrisma(), channels: CHANNELS });

    expect(targets).toEqual([
      { clientId: 'cl1', provider: 'YANDEX_DIRECT' },
      { clientId: 'cl2', provider: 'YANDEX_DIRECT' },
    ]);
  });

  it('умеет сузиться до одного клиента', async () => {
    const targets = await listIngestionTargets({
      db: db.asPrisma(),
      channels: CHANNELS,
      clientId: 'cl2',
    });

    expect(targets).toEqual([{ clientId: 'cl2', provider: 'YANDEX_DIRECT' }]);
  });
});

describe('runIngestion', () => {
  it('падение одного кабинета не лишает данных остальные', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', cabinet);

    const summary = await runIngestion({
      db: db.asPrisma(),
      channels: CHANNELS,
      adapterFor: () => adapter,
      contextFor: contextForExcept('cl2'),
      range: RANGE,
    });

    expect(summary.targets).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      clientId: 'cl2',
      provider: 'YANDEX_DIRECT',
      stage: 'entities',
      code: 'AUTH_FAILED',
    });

    // Данные первого клиента доехали целиком.
    expect(db.store.campaign).toHaveLength(1);
    expect(db.store.campaign[0]?.['clientId']).toBe('cl1');
    expect(db.store.campaignStat).toHaveLength(1);
    expect(summary.statsWritten).toBe(1);
  });

  it('пишет отказ в ErrorLog с контекстом', async () => {
    await runIngestion({
      db: db.asPrisma(),
      channels: CHANNELS,
      adapterFor: () => fakeAdapter('YANDEX_DIRECT', cabinet),
      contextFor: contextForExcept('cl2'),
      range: RANGE,
    });

    expect(db.store.errorLog).toHaveLength(1);
    expect(db.store.errorLog[0]).toMatchObject({
      clientId: 'cl2',
      provider: 'YANDEX_DIRECT',
      scope: 'ingestion:entities',
      code: 'AUTH_FAILED',
    });
  });

  it('после протухшего токена не дёргает остальные этапы того же кабинета', async () => {
    const perClient: string[] = [];
    const adapter = fakeAdapter('YANDEX_DIRECT', cabinet);
    const original = adapter.getStats.bind(adapter);
    adapter.getStats = async (ctx, level, range) => {
      perClient.push(`${ctx.clientId}:${level}`);
      return original(ctx, level, range);
    };

    await runIngestion({
      db: db.asPrisma(),
      channels: CHANNELS,
      adapterFor: () => adapter,
      contextFor: contextForExcept('cl2'),
      range: RANGE,
    });

    expect(perClient.every((call) => call.startsWith('cl1:'))).toBe(true);
    expect(db.store.errorLog).toHaveLength(1);
  });

  it('обычная ошибка этапа не отменяет следующие этапы кабинета', async () => {
    // Счётчик Метрики настроен в карточке клиента, токен — в секретах кабинета.
    db.store.client[0] = { ...db.store.client[0], metrikaCounterId: 1, metrikaGoalId: 2 };
    const adapter = fakeAdapter('YANDEX_DIRECT', cabinet);
    adapter.getStats = async () => {
      throw new Error('report queue timed out');
    };
    const getGoalConversions = vi.fn(async () => []);

    const summary = await runIngestion({
      db: db.asPrisma(),
      channels: CHANNELS,
      clientId: 'cl1',
      adapterFor: () => adapter,
      contextFor: async (clientId): Promise<ChannelContext> => ({
        clientId,
        credentials: { accessToken: 'y0' },
        dryRun: true,
      }),
      range: RANGE,
      metrikaFor: () => ({ getGoalConversions }),
    });

    expect(summary.failures.map((f) => f.stage)).toEqual(['stats']);
    // Сущности записаны, а конверсии всё равно поехали: отчёт упал, токен жив.
    expect(db.store.campaign).toHaveLength(1);
    expect(getGoalConversions).toHaveBeenCalledTimes(1);
  });

  it('повторный прогон не создаёт дублей', async () => {
    const options = {
      db: db.asPrisma(),
      channels: CHANNELS,
      adapterFor: () => fakeAdapter('YANDEX_DIRECT', cabinet),
      contextFor: contextForExcept('cl2'),
      range: RANGE,
    };

    await runIngestion(options);
    await runIngestion(options);

    expect(db.store.campaign).toHaveLength(1);
    expect(db.store.adGroup).toHaveLength(1);
    expect(db.store.campaignStat).toHaveLength(1);
  });

  it('сводка сериализуется в JSON — BigInt наружу не течёт', async () => {
    const summary = await runIngestion({
      db: db.asPrisma(),
      channels: CHANNELS,
      adapterFor: () => fakeAdapter('YANDEX_DIRECT', cabinet),
      contextFor: contextForExcept('cl2'),
      range: RANGE,
    });

    expect(() => JSON.stringify(summary)).not.toThrow();
  });
});

describe('runSearchQueryIngestion', () => {
  it('обходит клиентов независимо и складывает результаты', async () => {
    db.seed('campaign', [
      { id: 'camp-1', clientId: 'cl1', provider: 'YANDEX_DIRECT', externalId: '100' },
    ]);
    db.seed('adGroup', [{ id: 'ag-1', campaignId: 'camp-1', externalId: '200' }]);

    const summary = await runSearchQueryIngestion({
      db: db.asPrisma(),
      channels: CHANNELS,
      adapterFor: () =>
        fakeAdapter('YANDEX_DIRECT', {
          searchQueries: [
            {
              date: '2026-08-01',
              campaignExternalId: '100',
              query: 'сео бесплатно',
              impressions: 10,
              clicks: 6,
              spend: 100,
              conversions: 0,
            },
          ],
        }),
      contextFor: contextForExcept('cl2'),
      range: RANGE,
    });

    expect(summary.ok).toBe(1);
    expect(summary.written).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.stage).toBe('search-queries');
    expect(db.store.searchQueryStat).toHaveLength(1);
  });
});
