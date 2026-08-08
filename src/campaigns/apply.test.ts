import { Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { applyPlan, type ApplyStore } from '@/campaigns/apply.js';
import {
  campaignCreateKey,
  createInMemoryCampaignIdempotency,
  type CampaignIdempotency,
} from '@/campaigns/idempotency.js';
import { campaignPlanSchema, type CampaignPlan } from '@/campaigns/plan.schema.js';
import { CAMPAIGN_PLAN_PROVIDER } from '@/campaigns/store.js';
import type {
  AdCreateSpec,
  AdGroupCreateSpec,
  CampaignCreateSpec,
  CampaignWriter,
  KeywordCreateSpec,
} from '@/campaigns/writer.js';
import type { ChannelContext } from '@/channels/types.js';

/**
 * Заливка плана. Ни площадки, ни БД: writer, Prisma и контекст канала подменены.
 * Проверяем ровно то, что стоит денег, — dry-run и повторное создание.
 */

const PLAN: CampaignPlan = campaignPlanSchema.parse({
  id: 'plan-1',
  clientId: 'c1',
  createdAt: '2026-08-08T09:00:00.000Z',
  totalDailyBudgetRub: 5_000,
  summary: 'Поиск плюс сети',
  campaigns: [
    {
      channel: Provider.YANDEX_DIRECT,
      placement: 'search',
      name: 'Поиск — Курсы',
      dailyBudgetRub: 3_500,
      targetCpaRub: 2_000,
      strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
      negativeKeywords: ['скачать'],
      adGroups: [
        {
          name: 'Горячий спрос',
          regionIds: [213],
          keywords: [{ phrase: 'курсы английского', bidRub: 100 }],
          negativeKeywords: [],
          ads: [{ title: 'Английский для IT', text: 'Разговорный курс.' }],
        },
      ],
    },
    {
      channel: Provider.YANDEX_DIRECT,
      placement: 'network',
      name: 'РСЯ — Курсы',
      dailyBudgetRub: 1_500,
      targetCpaRub: 2_000,
      strategy: { search: { type: 'SERVING_OFF' }, network: { type: 'MAXIMUM_COVERAGE' } },
      negativeKeywords: [],
      adGroups: [
        {
          name: 'Горячий спрос',
          regionIds: [213],
          keywords: [{ phrase: 'курсы английского', bidRub: 50 }],
          negativeKeywords: [],
          ads: [{ title: 'Английский для IT', text: 'Разговорный курс.' }],
        },
      ],
    },
  ],
  warnings: [],
  prompts: ['campaign-structure@1.0.0'],
});

interface WriterHarness {
  writer: CampaignWriter;
  calls: {
    campaigns: CampaignCreateSpec[];
    groups: AdGroupCreateSpec[];
    keywords: KeywordCreateSpec[];
    ads: AdCreateSpec[];
    moderated: string[];
  };
}

function makeWriter(overrides: Partial<CampaignWriter> = {}): WriterHarness {
  const calls: WriterHarness['calls'] = {
    campaigns: [],
    groups: [],
    keywords: [],
    ads: [],
    moderated: [],
  };
  let counter = 0;

  const writer: CampaignWriter = {
    channel: Provider.YANDEX_DIRECT,
    createCampaign: (_ctx, spec) => {
      calls.campaigns.push(spec);
      counter += 1;
      return Promise.resolve({ externalId: `ext-${counter}` });
    },
    createAdGroups: (_ctx, _campaignExternalId, groups) => {
      calls.groups.push(...groups);
      return Promise.resolve(groups.map((g, i) => ({ externalId: `g${i}`, name: g.name })));
    },
    createKeywords: (_ctx, keywords) => {
      calls.keywords.push(...keywords);
      return Promise.resolve(keywords.map((_, i) => ({ externalId: `k${i}` })));
    },
    createAds: (_ctx, ads) => {
      calls.ads.push(...ads);
      return Promise.resolve(ads.map((_, i) => ({ externalId: `a${i}` })));
    },
    submitForModeration: (_ctx, ids) => {
      calls.moderated.push(...ids);
      return Promise.resolve();
    },
    ...overrides,
  };

  return { writer, calls };
}

interface DbHarness {
  db: ApplyStore;
  campaigns: Record<string, unknown>[];
  adGroups: Record<string, unknown>[];
  keywords: Record<string, unknown>[];
}

function makeDb(plan: CampaignPlan = PLAN): DbHarness {
  const campaigns: Record<string, unknown>[] = [];
  const adGroups: Record<string, unknown>[] = [];
  const keywords: Record<string, unknown>[] = [];
  let campaignSeq = 0;
  let groupSeq = 0;

  const db = {
    creative: {
      findUnique: () =>
        Promise.resolve({
          id: plan.id,
          provider: CAMPAIGN_PLAN_PROVIDER,
          payload: JSON.parse(JSON.stringify(plan)) as unknown,
        }),
    },
    campaign: {
      upsert: (args: { create: Record<string, unknown> }) => {
        campaigns.push(args.create);
        campaignSeq += 1;
        return Promise.resolve({ id: `db-campaign-${campaignSeq}` });
      },
    },
    adGroup: {
      upsert: (args: { create: Record<string, unknown> }) => {
        adGroups.push(args.create);
        groupSeq += 1;
        return Promise.resolve({ id: `db-group-${groupSeq}` });
      },
    },
    keyword: {
      create: (args: { data: Record<string, unknown> }) => {
        keywords.push(args.data);
        return Promise.resolve({ id: 'db-keyword' });
      },
    },
    idempotencyKey: {},
  } as unknown as ApplyStore;

  return { db, campaigns, adGroups, keywords };
}

function ctxFor(dryRun: boolean): ChannelContext {
  return { clientId: 'c1', credentials: { token: 'x' }, dryRun };
}

function deps(dryRun: boolean, idempotency: CampaignIdempotency) {
  return {
    buildContext: () => Promise.resolve(ctxFor(dryRun)),
    idempotency,
  };
}

describe('applyPlan: dry-run', () => {
  it('ничего не отправляет и не резервирует ключ', async () => {
    const { db } = makeDb();
    const { writer, calls } = makeWriter();
    const idempotency = createInMemoryCampaignIdempotency();
    const reserve = vi.spyOn(idempotency, 'reserve');

    const result = await applyPlan('plan-1', {
      db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      ...deps(true, idempotency),
    });

    expect(result.dryRun).toBe(true);
    expect(result.campaigns.map((c) => c.status)).toEqual(['planned', 'planned']);
    expect(calls.campaigns).toEqual([]);
    expect(calls.groups).toEqual([]);
    expect(calls.ads).toEqual([]);
    // Ключ не занят: dry-run не должен мешать настоящему запуску того же плана.
    expect(reserve).not.toHaveBeenCalled();
  });

  it('возвращает полный план того, что было бы создано', async () => {
    const { db } = makeDb();
    const { writer } = makeWriter();

    const result = await applyPlan('plan-1', {
      db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      ...deps(true, createInMemoryCampaignIdempotency()),
    });

    expect(result.campaigns[0]?.plan).toMatchObject({
      action: 'Campaigns.add',
      name: 'Поиск — Курсы',
      dailyBudgetRub: 3_500,
      adGroups: 1,
      keywords: 1,
      ads: 1,
    });
  });

  it('dryRun из опций включается даже при разрешающем контексте', async () => {
    const { db } = makeDb();
    const { writer, calls } = makeWriter();

    const result = await applyPlan('plan-1', {
      db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      buildContext: () => Promise.resolve(ctxFor(false)),
      idempotency: createInMemoryCampaignIdempotency(),
      dryRun: true,
    });

    expect(result.campaigns.every((c) => c.status === 'planned')).toBe(true);
    expect(calls.campaigns).toEqual([]);
  });
});

describe('applyPlan: создание', () => {
  it('создаёт кампанию, группы, фразы и объявления и шлёт их на модерацию', async () => {
    const { db, campaigns, keywords } = makeDb();
    const { writer, calls } = makeWriter();

    const result = await applyPlan('plan-1', {
      db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      ...deps(false, createInMemoryCampaignIdempotency()),
    });

    expect(result.campaigns.map((c) => c.status)).toEqual(['created', 'created']);
    expect(result.campaigns.map((c) => c.externalId)).toEqual(['ext-1', 'ext-2']);
    expect(calls.campaigns).toHaveLength(2);
    expect(calls.campaigns[0]).toMatchObject({
      name: 'Поиск — Курсы',
      dailyBudgetRub: 3_500,
      negativeKeywords: ['скачать'],
    });
    expect(calls.campaigns[0]?.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls.keywords).toHaveLength(2);
    expect(calls.ads).toHaveLength(2);
    expect(calls.moderated).toEqual(['a0', 'a0']);

    expect(campaigns).toHaveLength(2);
    expect(campaigns[0]).toMatchObject({ clientId: 'c1', externalId: 'ext-1', status: 'DRAFT' });
    expect(keywords).toHaveLength(2);
  });

  it('применяет одну кампанию плана по индексу', async () => {
    const { db } = makeDb();
    const { writer, calls } = makeWriter();

    const result = await applyPlan('plan-1', {
      db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      campaignIndex: 1,
      ...deps(false, createInMemoryCampaignIdempotency()),
    });

    expect(result.campaigns).toHaveLength(1);
    expect(result.campaigns[0]?.name).toBe('РСЯ — Курсы');
    expect(calls.campaigns).toHaveLength(1);
  });

  it('без реализации для канала не падает, а возвращает failed', async () => {
    const { db } = makeDb();

    const result = await applyPlan('plan-1', {
      db,
      writers: {},
      ...deps(false, createInMemoryCampaignIdempotency()),
    });

    expect(result.campaigns.every((c) => c.status === 'failed')).toBe(true);
    expect(result.campaigns[0]?.note).toContain('нет реализации');
  });
});

describe('applyPlan: идемпотентность', () => {
  it('повторная заливка того же плана не создаёт вторую кампанию', async () => {
    const idempotency = createInMemoryCampaignIdempotency();
    const { writer, calls } = makeWriter();

    const first = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      ...deps(false, idempotency),
    });
    const second = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      ...deps(false, idempotency),
    });

    expect(first.campaigns.map((c) => c.status)).toEqual(['created', 'created']);
    expect(second.campaigns.map((c) => c.status)).toEqual(['skipped', 'skipped']);
    // Главная проверка эпика: площадка увидела ровно два вызова, а не четыре.
    expect(calls.campaigns).toHaveLength(2);
    expect(second.campaigns[0]?.externalId).toBe('ext-1');
    expect(second.campaigns[0]?.note).toContain('уже создана');
  });

  it('ключ детерминирован: тот же план и та же позиция — тот же ключ', () => {
    expect(campaignCreateKey('plan-1', 0)).toBe('campaigns.create:plan-1:0');
    expect(campaignCreateKey('plan-1', 0)).toBe(campaignCreateKey('plan-1', 0));
    expect(campaignCreateKey('plan-1', 1)).not.toBe(campaignCreateKey('plan-1', 0));
  });

  it('упавшее создание освобождает ключ — повтор должен быть возможен', async () => {
    const idempotency = createInMemoryCampaignIdempotency();
    const failing = makeWriter({
      createCampaign: () => Promise.reject(new Error('Директ отклонил кампанию')),
    });

    const failed = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: failing.writer },
      campaignIndex: 0,
      ...deps(false, idempotency),
    });
    expect(failed.campaigns[0]?.status).toBe('failed');
    expect(failed.campaigns[0]?.note).toContain('Директ отклонил кампанию');

    const retry = makeWriter();
    const second = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: retry.writer },
      campaignIndex: 0,
      ...deps(false, idempotency),
    });
    expect(second.campaigns[0]?.status).toBe('created');
    expect(retry.calls.campaigns).toHaveLength(1);
  });

  it('незавершённая попытка не создаёт вторую кампанию, а требует разбора', async () => {
    const idempotency = createInMemoryCampaignIdempotency();
    // Кампания создана, но внешний id дописать не успели: процесс умер между шагами.
    await idempotency.reserve(campaignCreateKey('plan-1', 0));

    const { writer, calls } = makeWriter();
    const result = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: writer },
      campaignIndex: 0,
      ...deps(false, idempotency),
    });

    expect(result.campaigns[0]?.status).toBe('skipped');
    expect(result.campaigns[0]?.externalId).toBeNull();
    expect(result.campaigns[0]?.note).toContain('вручную');
    expect(calls.campaigns).toEqual([]);
  });

  it('падение на группах оставляет кампанию созданной и не даёт создать её снова', async () => {
    const idempotency = createInMemoryCampaignIdempotency();
    const broken = makeWriter({
      createAdGroups: () => Promise.reject(new Error('группы не приняты')),
    });

    const first = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: broken.writer },
      campaignIndex: 0,
      ...deps(false, idempotency),
    });
    expect(first.campaigns[0]?.status).toBe('created');
    expect(first.campaigns[0]?.note).toContain('структура создана не полностью');

    const retry = makeWriter();
    const second = await applyPlan('plan-1', {
      db: makeDb().db,
      writers: { [Provider.YANDEX_DIRECT]: retry.writer },
      campaignIndex: 0,
      ...deps(false, idempotency),
    });
    expect(second.campaigns[0]?.status).toBe('skipped');
    expect(retry.calls.campaigns).toEqual([]);
  });
});
