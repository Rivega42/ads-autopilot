import { MatchType } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import type { AgentRun } from '@/clients/llm/index.js';
import type { KeywordExpansion, RunExpandAgent } from '@/keywords/expand.js';
import type { FrequencySource } from '@/keywords/frequency.js';
import type { NegativeSuggestion, RunNegativesAgent } from '@/keywords/negatives.js';
import {
  listRefreshTargets,
  runWeeklyKeywordRefresh,
  type KeywordRefreshStore,
} from '@/keywords/refresh.js';

/** Полный прогон крона без Postgres, без сети и без ключей. */

const BRIEF: ClientBriefData = {
  product: 'Курсы английского для программистов',
  audience: { description: 'Разработчики 25-40' },
  geo: ['Москва'],
  negativeCities: [],
  usp: ['IT-лексика'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [],
  conversionGoals: [{ name: 'заявка' }],
};

interface StoreMocks {
  db: KeywordRefreshStore;
  upsert: ReturnType<typeof vi.fn>;
  createSet: ReturnType<typeof vi.fn>;
  findQueries: ReturnType<typeof vi.fn>;
}

function store(
  options: {
    clients?: Array<{ id: string }>;
    previousSeed?: string | null;
    brief?: { data: unknown; status: string } | null;
    queries?: Array<{ adGroupId: string; query: string }>;
  } = {},
): StoreMocks {
  const upsert = vi.fn().mockResolvedValue({ id: 'k1' });
  const createSet = vi.fn().mockResolvedValue({ id: 'ks1' });
  const findQueries = vi.fn().mockResolvedValue(options.queries ?? []);

  const db = {
    client: { findMany: vi.fn().mockResolvedValue(options.clients ?? [{ id: 'c1' }]) },
    clientBrief: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.brief === undefined ? { data: BRIEF, status: 'COMPLETE' } : options.brief,
        ),
    },
    keywordSet: {
      create: createSet,
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.previousSeed
            ? { id: 'ks0', seed: options.previousSeed, createdAt: new Date() }
            : null,
        ),
    },
    keyword: { upsert },
    searchQueryStat: { findMany: findQueries },
  } as unknown as KeywordRefreshStore;

  return { db, upsert, createSet, findQueries };
}

const runExpand: RunExpandAgent = () =>
  Promise.resolve({
    data: { phrases: ['курсы английского', 'английский для программистов'] },
    text: '',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: { tokensIn: 1, tokensOut: 1 },
    costUsd: 0,
    latencyMs: 1,
    cached: false,
    aiRunId: '1',
  } satisfies AgentRun<KeywordExpansion>);

const runNegatives: RunNegativesAgent = () =>
  Promise.resolve({
    data: { negatives: [] },
    text: '',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    usage: { tokensIn: 1, tokensOut: 1 },
    costUsd: 0,
    latencyMs: 1,
    cached: false,
    aiRunId: '2',
  } satisfies AgentRun<NegativeSuggestion>);

const BASE = {
  runExpand,
  runNegatives,
  dryRun: false,
  now: (): Date => new Date('2026-08-10T09:00:00Z'),
};

describe('listRefreshTargets', () => {
  it('берёт seed из прошлого снимка, а не из брифа', async () => {
    const { db } = store({ previousSeed: 'английский для айтишников' });
    const targets = await listRefreshTargets(db);
    expect(targets[0]?.seed).toBe('английский для айтишников');
  });

  it('без снимка берёт продукт из готового брифа', async () => {
    const { db } = store();
    const targets = await listRefreshTargets(db);
    expect(targets[0]?.seed).toBe('Курсы английского для программистов');
  });

  it('пропускает клиента без снимка и без готового брифа', async () => {
    const { db } = store({ brief: null });
    await expect(listRefreshTargets(db)).resolves.toEqual([]);
  });

  it('незаконченный бриф seed-фразой не считается', async () => {
    const { db } = store({ brief: { data: BRIEF, status: 'IN_PROGRESS' } });
    await expect(listRefreshTargets(db)).resolves.toEqual([]);
  });
});

describe('runWeeklyKeywordRefresh', () => {
  it('пересобирает ядро и сохраняет новый снимок', async () => {
    const { db, createSet } = store();

    const summary = await runWeeklyKeywordRefresh({ db, ...BASE });

    expect(summary.clients).toBe(1);
    expect(summary.ok).toBe(1);
    expect(summary.phrases).toBe(2);
    expect(createSet).toHaveBeenCalledTimes(1);
    expect(summary.results[0]?.keywordSetId).toBe('ks1');
  });

  it('окно поисковых запросов — неделя', async () => {
    const { db, findQueries } = store();

    const summary = await runWeeklyKeywordRefresh({ db, ...BASE });

    expect(summary.from).toBe('2026-08-04');
    expect(summary.to).toBe('2026-08-10');
    const where = findQueries.mock.calls[0]?.[0].where;
    expect(where.adGroup).toEqual({ campaign: { clientId: 'c1' } });
  });

  it('пишет минус-слова в ту группу, чей запрос их и породил', async () => {
    const { db, upsert } = store({
      queries: [
        { adGroupId: 'ag1', query: 'курсы английского бесплатно' },
        { adGroupId: 'ag2', query: 'курсы английского цена' },
      ],
    });

    const summary = await runWeeklyKeywordRefresh({ db, ...BASE });

    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0]?.[0];
    expect(call.where.adGroupId_matchType_phrase).toEqual({
      adGroupId: 'ag1',
      matchType: MatchType.NEGATIVE,
      phrase: 'бесплатно',
    });
    expect(summary.negativesWritten).toBe(1);
    expect(summary.results[0]?.adGroups).toBe(1);
  });

  it('в dry run ничего не пишет, но считает', async () => {
    const { db, upsert } = store({
      queries: [{ adGroupId: 'ag1', query: 'скачать учебник английского' }],
    });

    const summary = await runWeeklyKeywordRefresh({ db, ...BASE, dryRun: true });

    expect(upsert).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
    expect(summary.results[0]?.negatives).toBe(1);
    expect(summary.negativesWritten).toBe(0);
  });

  it('считает клиентов со слабой кластеризацией', async () => {
    const { db } = store();
    const summary = await runWeeklyKeywordRefresh({ db, ...BASE });
    expect(summary.degraded).toBe(1);
    expect(summary.results[0]?.degradedClustering).toBe(true);
  });

  it('источник частот прокидывается насквозь', async () => {
    const source: FrequencySource = {
      name: 'stub',
      isConfigured: () => true,
      fetch: (request) =>
        Promise.resolve(request.phrases.map((phrase) => ({ phrase, impressions: 500 }))),
    };
    const { db } = store();

    const summary = await runWeeklyKeywordRefresh({ db, ...BASE, frequencySource: source });

    expect(summary.results[0]?.frequenciesAvailable).toBe(true);
  });

  it('отказ по одному клиенту не мешает остальным', async () => {
    const { db } = store({ clients: [{ id: 'c1' }, { id: 'c2' }] });
    let calls = 0;
    const flaky: RunExpandAgent = (opts) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('429')) : runExpand(opts);
    };

    const summary = await runWeeklyKeywordRefresh({ db, ...BASE, runExpand: flaky });

    expect(summary.clients).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failures).toEqual([{ clientId: 'c1', error: expect.stringContaining('429') }]);
  });
});
