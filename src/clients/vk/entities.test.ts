import { describe, expect, it } from 'vitest';
import { RateLimitGovernor, VkHttpClient, type VkTransport } from '@/clients/vk/http.js';
import {
  chunk,
  listAdPlans,
  listBanners,
  massUpdateEntities,
  setEntitiesStatus,
  VK_BATCH_LIMIT,
  VK_PATHS,
  VK_STATUS_BLOCKED,
} from '@/clients/vk/entities.js';

interface Recorded {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

/** Клиент поверх стаба: без сети, без пауз, с записью всех запросов. */
function clientOf(reply: (call: Recorded, index: number) => unknown): {
  client: VkHttpClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: VkTransport = async (config) => {
    const call: Recorded = {
      url: config.url ?? '',
      method: config.method ?? 'GET',
      params: config.params as Record<string, unknown> | undefined,
      data: config.data,
    };
    calls.push(call);
    return { status: 200, data: reply(call, calls.length - 1), headers: {} };
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

describe('chunk', () => {
  it('splits by the VK batch limit and keeps every element exactly once', () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));
    const batches = chunk(ids, VK_BATCH_LIMIT);
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  it('rejects a non-positive size instead of looping forever', () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('listEntities id chunking', () => {
  it('splits a 450-id read into 3 requests of 200/200/50', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(i + 1));
    const { client, calls } = clientOf((call) => {
      const raw = String((call.params ?? {})['_id__in'] ?? '');
      const batch = raw === '' ? [] : raw.split(',');
      return {
        count: batch.length,
        items: batch.map((id) => ({ id: Number(id), name: `plan ${id}`, status: 'active' })),
      };
    });

    const plans = await listAdPlans(client, { ids });

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === `${VK_PATHS.adPlans}.json`)).toBe(true);
    const sizes = calls.map((c) => String(c.params?.['_id__in']).split(',').length);
    expect(sizes).toEqual([200, 200, 50]);
    expect(plans).toHaveLength(450);
    expect(plans[449]?.id).toBe(450);
  });

  it('deduplicates ids before chunking', async () => {
    const { client, calls } = clientOf(() => ({ count: 0, items: [] }));
    await listAdPlans(client, { ids: ['1', '1', '2', '2', '3'] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params?.['_id__in']).toBe('1,2,3');
  });
});

describe('listEntities pagination', () => {
  it('walks pages until the reported count is covered', async () => {
    const total = 450;
    const { client, calls } = clientOf((call) => {
      const offset = Number((call.params ?? {})['offset'] ?? 0);
      const size = Math.min(200, total - offset);
      return {
        count: total,
        offset,
        items: Array.from({ length: size }, (_, i) => ({
          id: offset + i + 1,
          ad_group_id: 1,
          status: 'active',
        })),
      };
    });

    const banners = await listBanners(client);
    expect(banners).toHaveLength(total);
    expect(calls.map((c) => c.params?.['offset'])).toEqual([0, 200, 400]);
  });
});

describe('write helpers', () => {
  it('chunks mass updates at 200 and numeric-casts ids', async () => {
    const patches = Array.from({ length: 450 }, (_, i) => ({
      id: String(i + 1),
      max_price: 100,
    }));
    const { client, calls } = clientOf(() => ({ success: 1 }));

    const applied = await massUpdateEntities(client, VK_PATHS.adGroups, patches);

    expect(applied).toBe(450);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(`${VK_PATHS.adGroups}/mass_action.json`);
    expect((calls[0]?.data as unknown[]).length).toBe(200);
    expect((calls[0]?.data as Array<{ id: unknown }>)[0]?.id).toBe(1);
  });

  it('does not touch the network for an empty update', async () => {
    const { client, calls } = clientOf(() => ({ success: 1 }));
    await expect(massUpdateEntities(client, VK_PATHS.banners, [])).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('sends a status switch as a mass update', async () => {
    const { client, calls } = clientOf(() => ({ success: 1 }));
    await setEntitiesStatus(client, VK_PATHS.banners, ['7', '8'], VK_STATUS_BLOCKED);
    expect(calls[0]?.data).toEqual([
      { id: 7, status: 'blocked' },
      { id: 8, status: 'blocked' },
    ]);
  });
});
