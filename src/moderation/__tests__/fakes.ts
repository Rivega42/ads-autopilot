import type { Provider } from '@prisma/client';
import { vi } from 'vitest';

import type {
  ChannelAdapter,
  ChannelContext,
  RemoteAd,
  WriteResult,
} from '@/channels/types.js';
import type { AgentRun, RunAgentOptions } from '@/clients/llm/index.js';
import type { AdText } from '@/moderation/types.js';

/** Ответ модели без сети и без ключей: форма ровно та, что отдаёт `runAgent`. */
export function agentRun<T>(data: T): AgentRun<T> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'deepseek',
    model: 'fake-model',
    usage: { tokensIn: 10, tokensOut: 10 },
    costUsd: 0,
    latencyMs: 1,
    cached: false,
    aiRunId: 'run-1',
  };
}

export interface FakeRunner<T> {
  run: (opts: RunAgentOptions<T>) => Promise<AgentRun<T>>;
  calls: RunAgentOptions<T>[];
}

/**
 * Очередь ответов модели. Последний ответ повторяется, пока очередь не кончится, —
 * иначе тест на «переписывай, пока не влезет» пришлось бы кормить вручную.
 */
export function queueRunner<T>(items: readonly (T | Error)[]): FakeRunner<T> {
  const calls: RunAgentOptions<T>[] = [];
  let index = 0;
  return {
    calls,
    run: async (opts: RunAgentOptions<T>): Promise<AgentRun<T>> => {
      calls.push(opts);
      const item = items[Math.min(index, items.length - 1)];
      index += 1;
      if (item instanceof Error) throw item;
      if (item === undefined) throw new Error('queueRunner: no responses configured');
      return agentRun(item);
    },
  };
}

export interface FakeAdapterOptions {
  channel: Provider;
  ads?: readonly RemoteAd[];
  listAds?: ChannelAdapter['listAds'];
  /** undefined — канал не умеет обновлять текст (проверка эскалации). */
  updateAdText?: (
    ctx: ChannelContext,
    adExternalId: string,
    text: AdText,
  ) => Promise<WriteResult> | WriteResult;
}

export interface FakeAdapter extends ChannelAdapter {
  updates: { adExternalId: string; text: AdText; dryRun: boolean }[];
}

function unsupported(name: string): () => never {
  return () => {
    throw new Error(`fake adapter: ${name} is not used by moderation`);
  };
}

export function fakeAdapter(options: FakeAdapterOptions): FakeAdapter {
  const updates: FakeAdapter['updates'] = [];
  const adapter: FakeAdapter = {
    channel: options.channel,
    updates,
    verifyAccess: async () => ({ ok: true }),
    listCampaigns: async () => [],
    listAdGroups: async () => [],
    // По умолчанию отдаём только объявления запрошенных групп — как настоящий кабинет.
    listAds:
      options.listAds ??
      (async (_ctx, adGroupExternalIds) =>
        (options.ads ?? []).filter((ad) => adGroupExternalIds.includes(ad.adGroupExternalId))),
    listKeywords: async () => [],
    getStats: async () => [],
    setBids: unsupported('setBids'),
    setBudgets: unsupported('setBudgets'),
    pauseEntities: unsupported('pauseEntities'),
    resumeEntities: unsupported('resumeEntities'),
  };

  if (options.updateAdText) {
    const impl = options.updateAdText;
    adapter.updateAdText = async (ctx, adExternalId, text) => {
      updates.push({ adExternalId, text, dryRun: ctx.dryRun });
      return impl(ctx, adExternalId, text);
    };
  }
  return adapter;
}

export function remoteAd(overrides: Partial<RemoteAd> = {}): RemoteAd {
  return {
    externalId: 'a-1',
    adGroupExternalId: 'g-1',
    title: 'Лучший ремонт стиральных машин',
    text: 'Приедем и починим сегодня, гарантия на работу.',
    status: 'ACCEPTED',
    moderationStatus: 'REJECTED',
    moderationReason: 'Превосходная степень без подтверждения',
    raw: {},
    ...overrides,
  };
}

export function channelContext(dryRun = false): ChannelContext {
  return { clientId: 'cl1', credentials: {}, dryRun };
}

/** Заглушка транспорта Telegram для эскалаций. */
export function fakeMessenger(): {
  sent: { chatId: string; text: string }[];
  sendMessage: ReturnType<typeof vi.fn>;
  editMessageText: ReturnType<typeof vi.fn>;
  answerCallbackQuery: ReturnType<typeof vi.fn>;
} {
  const sent: { chatId: string; text: string }[] = [];
  return {
    sent,
    sendMessage: vi.fn(async (chatId: string, text: string) => {
      sent.push({ chatId, text });
      return { messageId: sent.length };
    }),
    editMessageText: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => undefined),
  };
}
