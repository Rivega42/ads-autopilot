import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext, StatRow } from '@/channels/types.js';
import { fakeAdapter } from '@/ingestion/__tests__/fake-adapter.js';
import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { syncStats } = await import('@/ingestion/stats.js');
const { STATS_WINDOW_DAYS } = await import('@/ingestion/window.js');

const CLIENT = 'cl1';
const CTX: ChannelContext = { clientId: CLIENT, credentials: {}, dryRun: true };
const NOW = new Date('2026-08-08T09:00:00Z');

let db: FakePrisma;

beforeEach(() => {
  db = new FakePrisma();
  db.seed('client', [{ id: CLIENT, name: 'Ромашка', status: 'ACTIVE' }]);
  db.seed('campaign', [
    { id: 'camp-internal', clientId: CLIENT, provider: 'YANDEX_DIRECT', externalId: '100' },
  ]);
});

function deps(adapter: ReturnType<typeof fakeAdapter>) {
  return {
    db: db.asPrisma(),
    adapterFor: () => adapter,
    contextFor: async (): Promise<ChannelContext> => CTX,
    now: () => NOW,
  };
}

function statRow(patch: Partial<StatRow> = {}): StatRow {
  return {
    date: '2026-08-01',
    entityExternalId: '100',
    impressions: 1000,
    clicks: 50,
    spend: 1234.5678,
    conversions: 5,
    ...patch,
  };
}

describe('syncStats', () => {
  it('пишет статистику на внутренний id сущности, а не на идентификатор площадки', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', { stats: { campaign: [statRow()] } });

    const result = await syncStats(CLIENT, 'YANDEX_DIRECT', {
      ...deps(adapter),
      levels: ['campaign'],
    });

    expect(result.levels.campaign).toEqual({ fetched: 1, written: 1, unresolved: 0 });
    const row = db.store.campaignStat[0];
    expect(row?.['entityId']).toBe('camp-internal');
    expect(row?.['entityType']).toBe('CAMPAIGN');
    expect((row?.['date'] as Date).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(Number(row?.['spend'])).toBeCloseTo(1234.5678, 4);
    expect(Number(row?.['ctr'])).toBeCloseTo(0.05, 4);
    expect(Number(row?.['cpc'])).toBeCloseTo(24.6914, 4);
    expect(Number(row?.['cpa'])).toBeCloseTo(246.9136, 4);
  });

  it('по умолчанию перезаливает скользящее окно в 21 день, включая сегодня', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {});
    const ranges: Array<{ from: string; to: string }> = [];
    adapter.getStats = async (_ctx, _level, range) => {
      ranges.push(range);
      return [];
    };

    const result = await syncStats(CLIENT, 'YANDEX_DIRECT', {
      ...deps(adapter),
      levels: ['campaign'],
    });

    expect(STATS_WINDOW_DAYS).toBe(21);
    // 08.08 по МСК минус 20 дней — итого 21 сутки включительно.
    expect(result.from).toBe('2026-07-19');
    expect(result.to).toBe('2026-08-08');
    expect(ranges).toEqual([{ from: '2026-07-19', to: '2026-08-08' }]);
  });

  it('дозаливка обновляет строку того же дня, а не добавляет вторую', async () => {
    const first = fakeAdapter('YANDEX_DIRECT', {
      stats: { campaign: [statRow({ conversions: 2, spend: 100 })] },
    });
    await syncStats(CLIENT, 'YANDEX_DIRECT', { ...deps(first), levels: ['campaign'] });
    const idAfterFirst = db.store.campaignStat[0]?.['id'];

    // Через три недели Метрика досчитала конверсии за тот же день.
    const later = fakeAdapter('YANDEX_DIRECT', {
      stats: { campaign: [statRow({ conversions: 9, spend: 100 })] },
    });
    await syncStats(CLIENT, 'YANDEX_DIRECT', { ...deps(later), levels: ['campaign'] });

    expect(db.store.campaignStat).toHaveLength(1);
    expect(db.store.campaignStat[0]?.['id']).toBe(idAfterFirst);
    expect(db.store.campaignStat[0]?.['conversions']).toBe(9);
    expect(Number(db.store.campaignStat[0]?.['cpa'])).toBeCloseTo(100 / 9, 4);
  });

  it('повторный прогон с теми же данными ничего не меняет', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      stats: { campaign: [statRow({ date: '2026-08-01' }), statRow({ date: '2026-08-02' })] },
    });

    await syncStats(CLIENT, 'YANDEX_DIRECT', { ...deps(adapter), levels: ['campaign'] });
    const snapshot = JSON.stringify(db.store.campaignStat, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    await syncStats(CLIENT, 'YANDEX_DIRECT', { ...deps(adapter), levels: ['campaign'] });

    expect(db.store.campaignStat).toHaveLength(2);
    expect(
      JSON.stringify(db.store.campaignStat, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).toBe(snapshot);
  });

  it('складывает несколько строк отчёта по одной паре (сущность, дата)', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      stats: {
        campaign: [
          statRow({ impressions: 100, clicks: 10, spend: 1.1, conversions: 1 }),
          statRow({ impressions: 200, clicks: 20, spend: 2.2, conversions: 2 }),
        ],
      },
    });

    const result = await syncStats(CLIENT, 'YANDEX_DIRECT', {
      ...deps(adapter),
      levels: ['campaign'],
    });

    expect(result.levels.campaign.written).toBe(1);
    expect(db.store.campaignStat[0]?.['impressions']).toBe(300);
    // 1.1 + 2.2 в double даёт 3.3000000000000003 — в колонку должно уехать 3.3.
    expect(String(db.store.campaignStat[0]?.['spend'])).toBe('3.3');
  });

  it('отбрасывает строки с неизвестным внешним идентификатором', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      stats: { campaign: [statRow(), statRow({ entityExternalId: '999' })] },
    });

    const result = await syncStats(CLIENT, 'YANDEX_DIRECT', {
      ...deps(adapter),
      levels: ['campaign'],
    });

    expect(result.levels.campaign).toEqual({ fetched: 2, written: 1, unresolved: 1 });
    expect(db.store.campaignStat).toHaveLength(1);
  });

  it('не ходит в отчёт того уровня, сущностей которого в БД нет', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', { stats: { adgroup: [statRow()] } });

    const result = await syncStats(CLIENT, 'YANDEX_DIRECT', {
      ...deps(adapter),
      levels: ['adgroup'],
    });

    expect(adapter.calls).not.toContain('getStats:adgroup');
    expect(result.levels.adgroup.fetched).toBe(0);
  });

  it('разрешает внутренние id на всех четырёх уровнях', async () => {
    db.seed('adGroup', [{ id: 'ag-internal', campaignId: 'camp-internal', externalId: '200' }]);
    db.seed('ad', [{ id: 'ad-internal', adGroupId: 'ag-internal', externalId: '300' }]);
    db.seed('keyword', [{ id: 'kw-internal', adGroupId: 'ag-internal', externalId: '400' }]);

    const adapter = fakeAdapter('YANDEX_DIRECT', {
      stats: {
        campaign: [statRow({ entityExternalId: '100' })],
        adgroup: [statRow({ entityExternalId: '200' })],
        ad: [statRow({ entityExternalId: '300' })],
        keyword: [statRow({ entityExternalId: '400' })],
      },
    });

    await syncStats(CLIENT, 'YANDEX_DIRECT', deps(adapter));

    const written = db.store.campaignStat.map((r) => [r['entityType'], r['entityId']]);
    expect(written).toEqual([
      ['CAMPAIGN', 'camp-internal'],
      ['ADGROUP', 'ag-internal'],
      ['AD', 'ad-internal'],
      ['KEYWORD', 'kw-internal'],
    ]);
  });

  it('оставляет производные метрики пустыми, когда делить не на что', async () => {
    const adapter = fakeAdapter('YANDEX_DIRECT', {
      stats: {
        campaign: [statRow({ impressions: 0, clicks: 0, conversions: 0, spend: 0 })],
      },
    });

    await syncStats(CLIENT, 'YANDEX_DIRECT', { ...deps(adapter), levels: ['campaign'] });

    expect(db.store.campaignStat[0]?.['ctr']).toBeNull();
    expect(db.store.campaignStat[0]?.['cpc']).toBeNull();
    expect(db.store.campaignStat[0]?.['cpa']).toBeNull();
  });
});
