import { CreativeKind } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { saveCreative, type CreativeStore } from './store.js';

function storeOf(create: () => Promise<{ id: string }>): CreativeStore {
  return { creative: { create: vi.fn(create) } } as unknown as CreativeStore;
}

describe('saveCreative', () => {
  it('возвращает id созданной строки', async () => {
    const db = storeOf(() => Promise.resolve({ id: 'creative-1' }));
    const id = await saveCreative(db, {
      clientId: 'c1',
      kind: CreativeKind.TEXT,
      provider: 'claude-sonnet-5',
      prompt: 'creatives-texts@1.0.0',
      payload: { variants: [] },
      costUsd: 0.01,
    });
    expect(id).toBe('creative-1');
  });

  it('не роняет генерацию, если БД недоступна', async () => {
    const db = storeOf(() => Promise.reject(new Error('нет соединения')));
    const id = await saveCreative(db, {
      clientId: 'c1',
      kind: CreativeKind.IMAGE,
      provider: 'fusionbrain:kandinsky-3.1',
      prompt: 'баннер',
      payload: {},
      costUsd: 0,
    });
    expect(id).toBeNull();
  });

  it('приводит payload к JSON: Map и Date драйвер не принимает', async () => {
    let captured: unknown;
    const db = {
      creative: {
        create: vi.fn((args: { data: { payload: unknown } }) => {
          captured = args.data.payload;
          return Promise.resolve({ id: 'creative-1' });
        }),
      },
    } as unknown as CreativeStore;

    await saveCreative(db, {
      clientId: 'c1',
      kind: CreativeKind.TEXT,
      provider: 'model',
      prompt: 'p',
      payload: { at: new Date('2026-08-10T00:00:00.000Z'), skipped: undefined, n: 1 },
      costUsd: null,
    });

    expect(captured).toEqual({ at: '2026-08-10T00:00:00.000Z', n: 1 });
  });
});
