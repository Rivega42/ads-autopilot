import { describe, expect, it } from 'vitest';

import { hashContacts, hashEmail, type VkHashedContact } from '@/clients/vk-ads/contacts.js';
import { RateLimitGovernor, VkHttpClient, type VkTransport } from '@/clients/vk-ads/http.js';
import {
  createLookalikeAudience,
  createSegmentFromUsersLists,
  createUsersList,
  listCounters,
  listGoals,
  listUsersLists,
  uploadContacts,
  VK_REMARKETING_PATHS,
} from '@/clients/vk-ads/remarketing.js';
import type { ChannelError } from '@/lib/errors.js';

interface Recorded {
  url: string;
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
}

/** Клиент поверх стаба: без сети, без токена, без пауз, с записью всех запросов. */
function clientOf(
  reply: (call: Recorded, index: number) => unknown,
  statusOf: (index: number) => number = () => 200,
): { client: VkHttpClient; calls: Recorded[] } {
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

const LIVE = { dryRun: false };
const DRY = { dryRun: true };

function contactsOf(count: number): VkHashedContact[] {
  const emails = Array.from({ length: count }, (_, i) => `user${i + 1}@example.com`);
  return hashContacts({ emails }).contacts;
}

/** Всё, что уехало бы в лог или в ErrorLog по этой ошибке. */
function errorSurface(err: unknown): string {
  const e = err as ChannelError;
  return `${e.message} ${JSON.stringify(e.context)}`;
}

describe('remarketing reads', () => {
  it('drops the campaign status filter, which these paths do not share', async () => {
    const { client, calls } = clientOf(() => ({ count: 0, items: [] }));
    await listUsersLists(client);
    await listCounters(client);
    expect(calls.map((c) => c.url)).toEqual([
      `${VK_REMARKETING_PATHS.usersLists}.json`,
      `${VK_REMARKETING_PATHS.counters}.json`,
    ]);
    expect(calls.every((c) => c.params?.['_status__in'] === undefined)).toBe(true);
  });

  it('validates the response and normalises ids to strings', async () => {
    const { client } = clientOf(() => ({
      count: 1,
      items: [{ id: 4210, name: 'Покупатели 2026', type: 'email', users_count: '1500' }],
    }));
    const lists = await listUsersLists(client);
    expect(lists[0]).toMatchObject({ id: '4210', name: 'Покупатели 2026', users_count: 1500 });
  });

  it('rejects a response that is not a VK list envelope', async () => {
    const { client } = clientOf(() => ({ items: [{ name: 'no id at all' }] }));
    await expect(listUsersLists(client)).rejects.toMatchObject({ code: 'VK_SCHEMA_MISMATCH' });
  });

  it('filters goals by pixel through a validated numeric id', async () => {
    const { client, calls } = clientOf(() => ({ count: 0, items: [] }));
    await listGoals(client, { counterId: '77' });
    expect(calls[0]?.url).toBe(`${VK_REMARKETING_PATHS.goals}.json`);
    expect(calls[0]?.params?.['_counter_id__in']).toBe(77);
    await expect(listGoals(client, { counterId: 'nope' })).rejects.toMatchObject({
      code: 'VK_INVALID_ID',
    });
  });
});

describe('createUsersList', () => {
  it('returns the new id', async () => {
    const { client, calls } = clientOf(() => ({ id: 9001 }));
    const res = await createUsersList(client, LIVE, { name: 'CRM', type: 'email' });
    expect(res).toMatchObject({ applied: true, result: { id: '9001' } });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `${VK_REMARKETING_PATHS.usersLists}.json`,
      data: { name: 'CRM', type: 'email' },
    });
  });

  it('fails loudly when VK answers 200 without an id', async () => {
    const { client } = clientOf(() => ({ ok: true }));
    await expect(createUsersList(client, LIVE, { name: 'CRM' })).rejects.toMatchObject({
      code: 'VK_REMARKETING_CREATE_NO_ID',
    });
  });

  it('writes nothing on dryRun', async () => {
    const { client, calls } = clientOf(() => ({ id: 1 }));
    const res = await createUsersList(client, DRY, { name: 'CRM' });
    expect(res.applied).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('uploadContacts', () => {
  it('chunks 450 contacts into 3 requests of 200/200/50', async () => {
    const { client, calls } = clientOf(() => ({ accepted: undefined }));
    const res = await uploadContacts(client, LIVE, '4210', contactsOf(450));

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === `${VK_REMARKETING_PATHS.usersLists}/4210/items.json`)).toBe(
      true,
    );
    const sizes = calls.map((c) => (c.data as { items: unknown[] }).items.length);
    expect(sizes).toEqual([200, 200, 50]);
    expect(res.result).toMatchObject({ requested: 450, uploaded: 450, batches: 3 });
  });

  it('sends hashes only, under a sha256 field name', async () => {
    const { client, calls } = clientOf(() => ({}));
    const hashed = hashEmail('Test@Example.com');
    await uploadContacts(client, LIVE, '10', [hashed]);
    expect((calls[0]?.data as { items: unknown[] }).items).toEqual([{ email_sha256: hashed.hash }]);
    // Ни один запрос не должен нести исходный адрес ни в каком виде.
    expect(JSON.stringify(calls)).not.toContain('example.com');
  });

  it('lets VK report how many records it actually took', async () => {
    const { client } = clientOf(() => ({ accepted: 180 }));
    const res = await uploadContacts(client, LIVE, '10', contactsOf(200));
    expect(res.result?.uploaded).toBe(180);
  });

  it('sends nothing on dryRun but still reports the plan', async () => {
    const { client, calls } = clientOf(() => ({}));
    const res = await uploadContacts(client, DRY, '4210', contactsOf(450));
    expect(calls).toHaveLength(0);
    expect(res.applied).toBe(false);
    expect(res.plan).toMatchObject({ listId: '4210', contacts: 450, batches: 3 });
  });

  it('keeps raw contacts out of the plan even on dryRun', async () => {
    const { client } = clientOf(() => ({}));
    const res = await uploadContacts(
      client,
      DRY,
      '4210',
      hashContacts({
        emails: ['roman.gudkov@example.com'],
        phones: ['+7 (900) 123-45-67'],
      }).contacts,
    );

    const plan = JSON.stringify(res.plan);
    expect(plan).not.toContain('roman.gudkov');
    expect(plan).not.toContain('79001234567');
    expect(res.plan).toMatchObject({ byKind: { email: 1, phone: 1 } });
  });

  it('refuses a raw contact smuggled past the type system before touching the network', async () => {
    const { client, calls } = clientOf(() => ({}));
    const smuggled = ['roman.gudkov@example.com'] as unknown as VkHashedContact[];

    const err = await uploadContacts(client, LIVE, '10', smuggled).catch((e: unknown) => e);

    expect((err as ChannelError).code).toBe('VK_RAW_CONTACT');
    expect(errorSurface(err)).not.toContain('roman.gudkov@example.com');
    expect(calls).toHaveLength(0);
  });

  it('refuses a raw contact on dryRun too, so a dry run cannot green-light a bad call', async () => {
    const { client } = clientOf(() => ({}));
    const smuggled = ['79001234567'] as unknown as VkHashedContact[];
    await expect(uploadContacts(client, DRY, '10', smuggled)).rejects.toMatchObject({
      code: 'VK_RAW_CONTACT',
    });
  });

  it('rejects an unusable list id before building the url', async () => {
    const { client, calls } = clientOf(() => ({}));
    await expect(uploadContacts(client, LIVE, 'not-an-id', contactsOf(1))).rejects.toMatchObject({
      code: 'VK_INVALID_ID',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports what already landed when a later batch fails, without leaking hashes', async () => {
    const { client, calls } = clientOf(
      () => ({ error: { message: 'internal' } }),
      (index) => (index === 0 ? 200 : 500),
    );

    const err = await uploadContacts(client, LIVE, '10', contactsOf(250)).catch((e: unknown) => e);

    expect((err as ChannelError).code).toBe('VK_CONTACT_UPLOAD_PARTIAL');
    expect((err as ChannelError).context).toMatchObject({
      requested: 250,
      uploaded: 200,
      failedBatch: 1,
      pendingContacts: 50,
    });
    expect(errorSurface(err)).not.toMatch(/[0-9a-f]{64}/);
    expect(calls).toHaveLength(2);
  });

  it('rethrows the original error untouched when nothing was applied', async () => {
    const { client } = clientOf(
      () => ({ error: { message: 'internal' } }),
      () => 500,
    );
    await expect(uploadContacts(client, LIVE, '10', contactsOf(10))).rejects.toMatchObject({
      code: 'VK_SERVER_ERROR',
    });
  });

  it('does not touch the network for an empty upload', async () => {
    const { client, calls } = clientOf(() => ({}));
    const res = await uploadContacts(client, LIVE, '10', []);
    expect(res.applied).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('segments and lookalikes', () => {
  it('builds a segment out of users lists', async () => {
    const { client, calls } = clientOf(() => ({ id: '555' }));
    const res = await createSegmentFromUsersLists(client, LIVE, {
      name: 'CRM 90d',
      usersListIds: ['10', '11'],
    });

    expect(res.result).toEqual({ id: '555' });
    expect(calls[0]?.data).toEqual({
      name: 'CRM 90d',
      relations: [
        { object_type: 'remarketing_users_list', object_id: 10, params: { type: 'positive' } },
        { object_type: 'remarketing_users_list', object_id: 11, params: { type: 'positive' } },
      ],
    });
  });

  it('refuses a segment with no source', async () => {
    const { client, calls } = clientOf(() => ({ id: '1' }));
    await expect(
      createSegmentFromUsersLists(client, LIVE, { name: 'empty', usersListIds: [] }),
    ).rejects.toMatchObject({ code: 'VK_SEGMENT_NO_SOURCE' });
    expect(calls).toHaveLength(0);
  });

  it('creates a lookalike from a segment', async () => {
    const { client, calls } = clientOf(() => ({ id: 777 }));
    const res = await createLookalikeAudience(client, LIVE, {
      name: 'LAL CRM',
      sourceSegmentId: '555',
    });
    expect(res.result).toEqual({ id: '777' });
    expect(calls[0]?.data).toEqual({ name: 'LAL CRM', source_segment_id: 555 });
  });

  it('writes nothing on dryRun', async () => {
    const { client, calls } = clientOf(() => ({ id: 1 }));
    await createSegmentFromUsersLists(client, DRY, { name: 'x', usersListIds: ['10'] });
    await createLookalikeAudience(client, DRY, { name: 'y', sourceSegmentId: '555' });
    expect(calls).toHaveLength(0);
  });
});
