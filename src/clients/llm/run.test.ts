import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  getProvider: vi.fn(),
}));

// Реестр провайдеров подменяем целиком: тесты не должны знать про SDK и сеть.
vi.mock('./providers/index.js', () => ({
  getProvider: mocks.getProvider,
}));

// Prisma не поднимаем: во всех тестах передаём собственное хранилище через opts.db,
// но сам модуль импортируется в run.ts, поэтому его надо чем-то заменить.
vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { LlmCache } from './cache.js';
import type { AiRunStore } from './cost.js';
import { LlmApiError, LlmBudgetError, LlmConfigError } from './errors.js';
import { runAgent } from './run.js';
import type { LlmResponse } from './types.js';

interface FakeDb {
  db: AiRunStore;
  create: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
}

function fakeDb(spentUsd = '0'): FakeDb {
  const create = vi.fn().mockResolvedValue({ id: 'run_1' });
  const aggregate = vi.fn().mockResolvedValue({ _sum: { costUsd: spentUsd } });
  return {
    db: { aiRun: { create, aggregate } } as unknown as Pick<PrismaClient, 'aiRun'>,
    create,
    aggregate,
  };
}

function ok(text: string, tokensIn = 1_000, tokensOut = 200): LlmResponse {
  return {
    text,
    usage: { tokensIn, tokensOut },
    provider: 'anthropic',
    model: 'claude-opus-5',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProvider.mockReturnValue({
    name: 'anthropic',
    isConfigured: () => true,
    complete: mocks.complete,
  });
});

describe('runAgent — успешный прогон', () => {
  it('пишет строку AiRun с моделью, токенами, стоимостью и латентностью', async () => {
    const { db, create } = fakeDb();
    mocks.complete.mockResolvedValue(ok('Отчёт готов.', 1_000_000, 100_000));

    const run = await runAgent({
      agent: 'analyst',
      task: 'analytics.weekly',
      clientId: 'cl1',
      messages: 'Разбери неделю',
      db,
      cacheStore: new LlmCache(),
    });

    expect(run.data).toBe('Отчёт готов.');
    expect(run.model).toBe('claude-opus-5');
    expect(run.usage).toEqual({ tokensIn: 1_000_000, tokensOut: 100_000 });
    expect(run.costUsd).toBe(7.5); // $5/1M вход + $25/1M выход
    expect(run.aiRunId).toBe('run_1');

    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      clientId: 'cl1',
      agent: 'analyst',
      model: 'claude-opus-5',
      tokensIn: 1_000_000,
      tokensOut: 100_000,
      costUsd: 7.5,
      error: null,
    });
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
    expect(data.input).toMatchObject({ task: 'analytics.weekly', provider: 'anthropic' });
  });

  it('валидирует ответ по zod-схеме, когда она передана', async () => {
    const { db } = fakeDb();
    mocks.complete.mockResolvedValue(ok('{"cpa": 1900, "verdict":"ok"}'));

    const run = await runAgent({
      agent: 'optimizer',
      task: 'optimizer.decide',
      messages: 'Что делать со ставками?',
      schema: z.object({ cpa: z.number(), verdict: z.string() }),
      schemaName: 'decision',
      db,
      cacheStore: new LlmCache(),
    });

    expect(run.data).toEqual({ cpa: 1900, verdict: 'ok' });
  });
});

describe('runAgent — кеш', () => {
  it('второй одинаковый вызов не ходит к провайдеру', async () => {
    const { db, create } = fakeDb();
    const cacheStore = new LlmCache();
    mocks.complete.mockResolvedValue(ok('кешируемый ответ'));

    const args = {
      agent: 'moderator',
      task: 'moderation.classify',
      messages: 'реклама без рецепта',
      db,
      cacheStore,
    } as const;

    const first = await runAgent({ ...args });
    const second = await runAgent({ ...args });

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.text).toBe('кешируемый ответ');
    // За повтор не платим, но след в AiRun остаётся.
    expect(second.costUsd).toBe(0);
    expect(second.usage).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].data.input.cached).toBe(true);
  });

  it('разные промпты в кеше не смешиваются', async () => {
    const { db } = fakeDb();
    const cacheStore = new LlmCache();
    mocks.complete.mockResolvedValueOnce(ok('первый')).mockResolvedValueOnce(ok('второй'));

    const a = await runAgent({
      agent: 'moderator',
      task: 'moderation.classify',
      messages: 'первый текст',
      db,
      cacheStore,
    });
    const b = await runAgent({
      agent: 'moderator',
      task: 'moderation.classify',
      messages: 'второй текст',
      db,
      cacheStore,
    });

    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(a.text).toBe('первый');
    expect(b.text).toBe('второй');
  });

  it('cache:false отключает кеш', async () => {
    const { db } = fakeDb();
    const cacheStore = new LlmCache();
    mocks.complete.mockResolvedValue(ok('ответ'));

    const args = {
      agent: 'moderator',
      task: 'moderation.classify',
      messages: 'текст',
      cache: false,
      db,
      cacheStore,
    } as const;

    await runAgent({ ...args });
    await runAgent({ ...args });

    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });
});

describe('runAgent — ошибки', () => {
  it('ошибка провайдера всё равно попадает в AiRun и пробрасывается наверх', async () => {
    const { db, create } = fakeDb();
    mocks.complete.mockRejectedValue(
      new LlmApiError('Anthropic API error (HTTP 500): boom', {
        provider: 'anthropic',
        model: 'claude-opus-5',
        status: 500,
        retryable: false,
      }),
    );

    await expect(
      runAgent({
        agent: 'strategist',
        task: 'strategy.plan',
        clientId: 'cl1',
        messages: 'Построй план',
        db,
        cacheStore: new LlmCache(),
      }),
    ).rejects.toBeInstanceOf(LlmApiError);

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    expect(data.error).toContain('HTTP 500');
    expect(data.agent).toBe('strategist');
    expect(data.clientId).toBe('cl1');
    expect(data.output).toBeUndefined();
    expect(data.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('отсутствие ключа не ретраится и не подменяется другим провайдером', async () => {
    const { db, create } = fakeDb();
    mocks.complete.mockRejectedValue(
      new LlmConfigError('DEEPSEEK_API_KEY is not set — cannot call the deepseek provider'),
    );

    await expect(
      runAgent({
        agent: 'wordstat',
        task: 'keywords.expand',
        messages: 'курсы английского',
        db,
        cacheStore: new LlmCache(),
      }),
    ).rejects.toBeInstanceOf(LlmConfigError);

    // Ровно одна попытка: ключ от повторов не появится.
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    // Провайдер запрошен ровно тот, что назначен задаче.
    expect(mocks.getProvider).toHaveBeenCalledWith('deepseek');
    expect(create.mock.calls[0]![0].data.error).toContain('DEEPSEEK_API_KEY');
  });

  it('исчерпанный месячный бюджет останавливает вызов до похода в модель', async () => {
    const { db, create } = fakeDb('999');

    await expect(
      runAgent({
        agent: 'creatives',
        task: 'creatives.texts',
        clientId: 'cl1',
        messages: 'Напиши заголовки',
        budgetUsd: 50,
        db,
        cacheStore: new LlmCache(),
      }),
    ).rejects.toBeInstanceOf(LlmBudgetError);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![0].data.error).toContain('budget');
  });

  it('без clientId бюджет не проверяется', async () => {
    const { db, aggregate } = fakeDb('999');
    mocks.complete.mockResolvedValue(ok('ответ'));

    await runAgent({
      agent: 'recon',
      task: 'strategy.recon',
      messages: 'Собери конкурентов',
      db,
      cacheStore: new LlmCache(),
    });

    expect(aggregate).not.toHaveBeenCalled();
  });

  it('падение записи в AiRun не роняет полезный ответ', async () => {
    const { db, create } = fakeDb();
    create.mockRejectedValue(new Error('db is down'));
    mocks.complete.mockResolvedValue(ok('ответ'));

    const run = await runAgent({
      agent: 'analyst',
      task: 'analytics.daily',
      messages: 'сводка',
      db,
      cacheStore: new LlmCache(),
    });

    expect(run.text).toBe('ответ');
    expect(run.aiRunId).toBeNull();
  });
});
