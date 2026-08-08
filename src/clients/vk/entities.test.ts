import { describe, expect, it } from 'vitest';

import {
  chunk,
  listAdPlans,
  listBanners,
  massUpdateEntities,
  setEntitiesStatus,
  toVkMoney,
  toVkNumericId,
  VK_BATCH_LIMIT,
  VK_DEFAULT_STATUSES,
  VK_PATHS,
  VK_STATUS_BLOCKED,
} from '@/clients/vk/entities.js';
import { RateLimitGovernor, VkHttpClient, type VkTransport } from '@/clients/vk/http.js';
import { ChannelError } from '@/lib/errors.js';

interface Recorded {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

/** Клиент поверх стаба: без сети, без пауз, с записью всех запросов. */
function clientOf(
  reply: (call: Recorded, index: number) => unknown,
  statusOf: (index: number) => number = () => 200,
): {
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
    const index = calls.length - 1;
    return { status: statusOf(index), data: reply(call, index), headers: {} };
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

describe('default status filter', () => {
  it('asks for everything but deleted, so the 200-object budget is not spent on corpses', async () => {
    const { client, calls } = clientOf(() => ({ count: 0, items: [] }));
    await listBanners(client);
    expect(calls[0]?.params?.['_status__in']).toBe(VK_DEFAULT_STATUSES.join(','));
    expect(VK_DEFAULT_STATUSES).not.toContain('deleted');
  });

  it('lets an explicit empty list ask for deleted objects too', async () => {
    const { client, calls } = clientOf(() => ({ count: 0, items: [] }));
    await listBanners(client, { statuses: [] });
    expect(calls[0]?.params?.['_status__in']).toBeUndefined();
  });
});

describe('toVkNumericId', () => {
  it('rejects ids that JSON.stringify would turn into null or silently round', () => {
    expect(toVkNumericId('42')).toBe(42);
    // Number('abc') === NaN → "id": null в теле запроса.
    expect(() => toVkNumericId('abc')).toThrow(ChannelError);
    expect(() => toVkNumericId('')).toThrow(ChannelError);
    expect(() => toVkNumericId('0')).toThrow(ChannelError);
    // За 2^53 число уже адресует другой объект.
    expect(() => toVkNumericId('9007199254740993')).toThrow(ChannelError);
  });
});

describe('toVkMoney', () => {
  it('refuses NaN and non-positive sums instead of writing null', () => {
    // JSON.stringify({budget_limit_day: NaN}) === '{"budget_limit_day":null}',
    // а null в дневном лимите VK означает «без ограничения».
    expect(() => toVkMoney(Number.NaN, 'budget_limit_day')).toThrow(ChannelError);
    expect(() => toVkMoney(Number.POSITIVE_INFINITY, 'budget_limit_day')).toThrow(ChannelError);
    expect(() => toVkMoney(0, 'budget_limit_day')).toThrow(ChannelError);
    expect(() => toVkMoney(-5, 'budget_limit_day')).toThrow(ChannelError);
  });

  it('quantises to kopecks so the write matches what the cabinet shows', () => {
    expect(toVkMoney(1049.376, 'budget_limit_day')).toBe(1049.38);
    expect(toVkMoney(0.1 + 0.2, 'max_price')).toBe(0.3);
  });
});

describe('write helpers', () => {
  it('chunks mass updates at 200 and numeric-casts ids', async () => {
    const patches = Array.from({ length: 450 }, (_, i) => ({
      id: String(i + 1),
      max_price: 100,
    }));
    const { client, calls } = clientOf(() => ({ success: 1 }));

    const outcome = await massUpdateEntities(client, VK_PATHS.adGroups, patches);

    expect(outcome).toEqual({ requested: 450, updated: 450, failed: [] });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe(`${VK_PATHS.adGroups}/mass_action.json`);
    expect((calls[0]?.data as unknown[]).length).toBe(200);
    expect((calls[0]?.data as Array<{ id: unknown }>)[0]?.id).toBe(1);
  });

  it('does not send a batch at all when one of its ids is unusable', async () => {
    const { client, calls } = clientOf(() => ({ success: 1 }));
    await expect(
      massUpdateEntities(client, VK_PATHS.adGroups, [
        { id: '11', max_price: 10 },
        { id: 'not-an-id', max_price: 10 },
      ]),
    ).rejects.toMatchObject({ code: 'VK_INVALID_ID' });
    expect(calls).toHaveLength(0);
  });

  it('does not count per-item rejections inside a 200 response as applied', async () => {
    const { client } = clientOf(() => ({
      items: [
        { id: 7, success: true },
        { id: 8, error: { code: 'invalid_value', message: 'max_price is too low' } },
      ],
    }));

    const outcome = await massUpdateEntities(client, VK_PATHS.adGroups, [
      { id: '7', max_price: 10 },
      { id: '8', max_price: 10 },
    ]);

    expect(outcome.updated).toBe(1);
    expect(outcome.failed).toEqual([{ id: '8', message: 'max_price is too low' }]);
  });

  it('reports what already landed when a later batch fails', async () => {
    const patches = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 1),
      status: 'blocked',
    }));
    // Первый батч (200 объектов) применился, второй упал.
    const { client, calls } = clientOf(
      () => ({ error: { message: 'internal' } }),
      (index) => (index === 0 ? 200 : 500),
    );

    const err = await massUpdateEntities(client, VK_PATHS.banners, patches).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).code).toBe('VK_MASS_UPDATE_PARTIAL');
    expect((err as ChannelError).context).toMatchObject({ requested: 250, updated: 200 });
    expect((err as ChannelError).context['pendingIds']).toHaveLength(50);
    expect(calls).toHaveLength(2);
  });

  it('rethrows the original error untouched when nothing was applied', async () => {
    const { client } = clientOf(
      () => ({ error: { message: 'internal' } }),
      () => 500,
    );
    await expect(
      massUpdateEntities(client, VK_PATHS.banners, [{ id: '1', status: 'blocked' }]),
    ).rejects.toMatchObject({ code: 'VK_SERVER_ERROR' });
  });

  it('does not touch the network for an empty update', async () => {
    const { client, calls } = clientOf(() => ({ success: 1 }));
    await expect(massUpdateEntities(client, VK_PATHS.banners, [])).resolves.toEqual({
      requested: 0,
      updated: 0,
      failed: [],
    });
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
