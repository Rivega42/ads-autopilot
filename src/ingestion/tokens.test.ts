import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '@/channels/types.js';

import { FakePrisma } from '@/ingestion/__tests__/fake-prisma.js';
import { AuthError } from '@/lib/errors.js';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

const { refreshExpiringTokens } = await import('@/ingestion/tokens.js');

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
    { id: 'cr2', clientId: 'cl2', provider: 'VK_ADS' },
    { id: 'cr3', clientId: 'cl3', provider: 'YANDEX_DIRECT' },
    { id: 'cr4', clientId: 'cl1', provider: 'TIKTOK_ADS' },
  ]);
});

const context = async (clientId: string): Promise<ChannelContext> => ({
  clientId,
  credentials: {},
  dryRun: true,
});

describe('refreshExpiringTokens', () => {
  it('обходит только активных клиентов и каналы с продлением', async () => {
    const refreshYandex = vi.fn(async () => true);
    const refreshVk = vi.fn(async () => false);

    const result = await refreshExpiringTokens({
      db: db.asPrisma(),
      contextFor: context,
      refreshYandex,
      refreshVk,
    });

    expect(result).toEqual({ checked: 2, refreshed: 1, failures: [] });
    expect(refreshYandex).toHaveBeenCalledTimes(1);
    expect(refreshVk).toHaveBeenCalledTimes(1);
  });

  it('отказ по одному кабинету не мешает остальным и попадает в ErrorLog', async () => {
    const refreshVk = vi.fn(async () => true);

    const result = await refreshExpiringTokens({
      db: db.asPrisma(),
      contextFor: context,
      refreshYandex: async () => {
        throw new AuthError('YANDEX_DIRECT', 'refresh_token отозван');
      },
      refreshVk,
    });

    expect(result.checked).toBe(2);
    expect(result.refreshed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ clientId: 'cl1', stage: 'tokens' });
    expect(refreshVk).toHaveBeenCalledTimes(1);
    expect(db.store.errorLog[0]).toMatchObject({ scope: 'ingestion:tokens' });
  });

  it('результат сериализуется в JSON', async () => {
    const result = await refreshExpiringTokens({
      db: db.asPrisma(),
      contextFor: context,
      refreshYandex: async () => false,
      refreshVk: async () => false,
    });

    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
