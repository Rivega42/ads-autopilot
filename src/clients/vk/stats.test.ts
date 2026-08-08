import { describe, expect, it } from 'vitest';
import { RateLimitGovernor, VkHttpClient, type VkTransport } from '@/clients/vk/http.js';
import { VK_PATHS } from '@/clients/vk/entities.js';
import {
  clampStatsRange,
  fetchVkStats,
  mapStatsResponse,
  statLevelToPath,
  VK_STATS_MAX_DAYS,
} from '@/clients/vk/stats.js';

function clientOf(reply: (params: Record<string, unknown>) => unknown): {
  client: VkHttpClient;
  calls: Array<{ url: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ url: string; params: Record<string, unknown> }> = [];
  const transport: VkTransport = async (config) => {
    const params = (config.params ?? {}) as Record<string, unknown>;
    calls.push({ url: config.url ?? '', params });
    return { status: 200, data: reply(params), headers: {} };
  };
  const client = new VkHttpClient({
    transport,
    getAccessToken: async () => 'token',
    attempts: 1,
    governor: new RateLimitGovernor(
      () => Date.now(),
      async () => undefined,
    ),
  });
  return { client, calls };
}

describe('statLevelToPath', () => {
  it('maps the shared levels onto VK entities and admits it has no keywords', () => {
    expect(statLevelToPath('campaign')).toBe(VK_PATHS.adPlans);
    expect(statLevelToPath('adgroup')).toBe(VK_PATHS.adGroups);
    expect(statLevelToPath('ad')).toBe(VK_PATHS.banners);
    expect(statLevelToPath('keyword')).toBeNull();
  });
});

describe('clampStatsRange', () => {
  it('pulls the start date up to the 365-day horizon', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    const clamped = clampStatsRange({ from: '2020-01-01', to: '2026-08-07' }, now);
    expect(clamped.from > '2025-08-01').toBe(true);
    expect(clamped.to).toBe('2026-08-07');
  });

  it('leaves a range inside the horizon untouched', () => {
    const now = new Date('2026-08-08T12:00:00Z');
    const range = { from: '2026-07-01', to: '2026-07-31' };
    expect(clampStatsRange(range, now)).toEqual(range);
    expect(VK_STATS_MAX_DAYS).toBe(365);
  });
});

describe('mapStatsResponse', () => {
  it('maps shows/clicks/spent/goals onto the shared StatRow', () => {
    const rows = mapStatsResponse(
      {
        items: [
          {
            id: '101',
            rows: [
              { date: '2026-08-01', base: { shows: 1000, clicks: 40, spent: '523.45', goals: 3 } },
              { date: '2026-08-02', base: { shows: '2000', clicks: 0, spent: 0, goals: 0 } },
            ],
          },
        ],
      },
      '2026-08-02',
    );

    expect(rows).toEqual([
      {
        date: '2026-08-01',
        entityExternalId: '101',
        impressions: 1000,
        clicks: 40,
        cost: 523.45,
        conversions: 3,
      },
      {
        date: '2026-08-02',
        entityExternalId: '101',
        impressions: 2000,
        clicks: 0,
        cost: 0,
        conversions: 0,
      },
    ]);
  });

  it('reads flat rows and falls back to the range end when there is no date', () => {
    const rows = mapStatsResponse(
      { items: [{ id: '9', rows: [{ shows: 5, clicks: 1, spent: '2.5', goals: 1 }] }] },
      '2026-08-07',
    );
    expect(rows[0]).toEqual({
      date: '2026-08-07',
      entityExternalId: '9',
      impressions: 5,
      clicks: 1,
      cost: 2.5,
      conversions: 1,
    });
  });
});

describe('fetchVkStats', () => {
  it('requests statistics in batches of 200 ids', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));
    const { client, calls } = clientOf((params) => {
      const batch = String(params['id']).split(',');
      return {
        items: batch.map((id) => ({
          id,
          rows: [{ date: '2026-08-01', base: { shows: 1, clicks: 1, spent: 1, goals: 1 } }],
        })),
      };
    });

    const rows = await fetchVkStats(client, {
      objectType: VK_PATHS.banners,
      ids,
      range: { from: '2026-08-01', to: '2026-08-01' },
      now: new Date('2026-08-08T00:00:00Z'),
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(`statistics/${VK_PATHS.banners}/day.json`);
    expect(calls.map((c) => String(c.params['id']).split(',').length)).toEqual([200, 200, 50]);
    expect(rows).toHaveLength(450);
  });

  it('skips the network entirely when there is nothing to ask about', async () => {
    const { client, calls } = clientOf(() => ({ items: [] }));
    await expect(
      fetchVkStats(client, {
        objectType: VK_PATHS.adPlans,
        ids: [],
        range: { from: '2026-08-01', to: '2026-08-02' },
      }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
