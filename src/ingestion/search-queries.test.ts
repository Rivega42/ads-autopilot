import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext, SearchQueryRow } from '@/channels/types.js';

import { fakeAdapter } from '@/ingestion/__tests__/fake-adapter.js';
import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { syncSearchQueries } = await import('@/ingestion/search-queries.js');

const CLIENT = 'cl1';
const CTX: ChannelContext = { clientId: CLIENT, credentials: {}, dryRun: true };
const RANGE = { from: '2026-08-01', to: '2026-08-08' };

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  db.seed('client', [{ id: CLIENT, name: 'Ромашка', status: 'ACTIVE' }]);
  db.seed('campaign', [
    { id: 'camp-1', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '100' },
  ]);
  db.seed('adGroup', [{ id: 'ag-1', campaignId: 'camp-1', externalId: '200' }]);
});

function deps(adapter: ReturnType<typeof fakeAdapter>) {
  return {
    db: db.asPrisma(),
    adapterFor: () => adapter,
    contextFor: async (): Promise<ChannelContext> => CTX,
    range: RANGE,
  };
}

function queryRow(patch: Partial<SearchQueryRow> = {}): SearchQueryRow {
  return {
    date: '2026-08-01',
    campaignExternalId: '100',
    query: 'сео продвижение недорого',
    impressions: 40,
    clicks: 6,
    spend: 300.25,
    conversions: 0,
    ...patch,
  };
}

describe('syncSearchQueries', () => {
  it('привязывает запрос к единственной группе кампании', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', { searchQueries: [queryRow()] });

    const result = await syncSearchQueries(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    expect(result).toMatchObject({ supported: true, fetched: 1, written: 1, unattributed: 0 });
    const row = db.store.searchQueryStat[0];
    expect(row?.['adGroupId']).toBe('ag-1');
    expect(row?.['query']).toBe('сео продвижение недорого');
    expect(Number(row?.['spend'])).toBeCloseTo(300.25, 4);
    expect((row?.['date'] as Date).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('не гадает, когда групп в кампании несколько', async () => {
    db.seed('adGroup', [{ id: 'ag-2', campaignId: 'camp-1', externalId: '201' }]);
    const adapter = fakeAdapter('YANDEX_DIRECT', { searchQueries: [queryRow()] });

    const result = await syncSearchQueries(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    expect(result.unattributed).toBe(1);
    expect(db.store.searchQueryStat).toHaveLength(0);
  });

  it('берёт группу прямо из строки отчёта, если адаптер её прислал', async () => {
    db.seed('adGroup', [{ id: 'ag-2', campaignId: 'camp-1', externalId: '201' }]);
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      searchQueries: [{ ...queryRow(), adGroupExternalId: '201' } as SearchQueryRow],
    });

    const result = await syncSearchQueries(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    expect(result.written).toBe(1);
    expect(db.store.searchQueryStat[0]?.['adGroupId']).toBe('ag-2');
  });

  it('повторный прогон обновляет строку и сохраняет отметку negated', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', { searchQueries: [queryRow({ clicks: 6 })] });
    await syncSearchQueries(CLIENT, 'YANDEX_DIRECT', deps(adapter));
    const stat = db.store.searchQueryStat[0];
    stat!['negated'] = true;

    const later = fakeAdapter('YANDEX_DIRECT', { searchQueries: [queryRow({ clicks: 11 })] });
    await syncSearchQueries(CLIENT, 'YANDEX_DIRECT', deps(later));

    expect(db.store.searchQueryStat).toHaveLength(1);
    expect(db.store.searchQueryStat[0]?.['clicks']).toBe(11);
    expect(db.store.searchQueryStat[0]?.['negated']).toBe(true);
  });

  it('канал без отчёта по запросам не считается ошибкой', async () => {
    const adapter = fakeAdapter('VK_ADS', { withoutSearchQueries: true });

    const result = await syncSearchQueries(CLIENT, 'VK_ADS', deps(adapter));

    expect(result.supported).toBe(false);
    expect(result.written).toBe(0);
    expect(adapter.calls).toEqual([]);
  });

  it('игнорирует архивные группы при разборе адреса', async () => {
    db.seed('adGroup', [{ id: 'ag-old', campaignId: 'camp-1', externalId: '199', status: 'ARCHIVED' }]);
    const adapter = fakeAdapter('YANDEX_DIRECT', { searchQueries: [queryRow()] });

    const result = await syncSearchQueries(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    expect(result.written).toBe(1);
    expect(db.store.searchQueryStat[0]?.['adGroupId']).toBe('ag-1');
  });
});
