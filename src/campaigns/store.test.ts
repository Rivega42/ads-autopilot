import { Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { campaignPlanSchema, type CampaignPlan } from '@/campaigns/plan.schema.js';
import {
  CAMPAIGN_PLAN_PROVIDER,
  loadPlan,
  PlanCorruptedError,
  PlanNotFoundError,
  savePlan,
  type PlanStore,
} from '@/campaigns/store.js';

const PLAN: CampaignPlan = campaignPlanSchema.parse({
  id: null,
  clientId: 'c1',
  createdAt: '2026-08-08T09:00:00.000Z',
  totalDailyBudgetRub: 300,
  summary: 'Один поиск',
  campaigns: [
    {
      channel: Provider.YANDEX_DIRECT,
      placement: 'search',
      name: 'Поиск',
      dailyBudgetRub: 300,
      targetCpaRub: 2_000,
      strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
      negativeKeywords: [],
      adGroups: [
        {
          name: 'Группа',
          regionIds: [213],
          keywords: [{ phrase: 'фраза', bidRub: 100 }],
          negativeKeywords: [],
          ads: [{ title: 'Заголовок', text: 'Текст объявления.' }],
        },
      ],
    },
  ],
  warnings: ['Проверьте формулировки'],
  prompts: ['campaign-structure@1.0.0'],
});

function storeOf(row: unknown): PlanStore {
  return {
    creative: {
      create: vi.fn(() => Promise.resolve({ id: 'plan-1' })),
      findUnique: vi.fn(() => Promise.resolve(row)),
    },
  } as unknown as PlanStore;
}

describe('savePlan', () => {
  it('возвращает план с проставленным id и не пишет id внутрь payload', async () => {
    const created: Record<string, unknown>[] = [];
    const db = {
      creative: {
        create: vi.fn((args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return Promise.resolve({ id: 'plan-1' });
        }),
      },
    } as unknown as PlanStore;

    const saved = await savePlan(db, PLAN, { costUsd: 0.12 });

    expect(saved.id).toBe('plan-1');
    expect(created[0]).toMatchObject({
      clientId: 'c1',
      provider: CAMPAIGN_PLAN_PROVIDER,
      prompt: 'campaign-structure@1.0.0',
      costUsd: 0.12,
    });
    // id живёт в колонке, а не в payload: иначе копия плана указывала бы на чужую строку.
    expect((created[0]?.['payload'] as { id: unknown }).id).toBeNull();
  });
});

describe('loadPlan', () => {
  it('читает сохранённый план обратно без потерь', async () => {
    const db = storeOf({
      id: 'plan-1',
      provider: CAMPAIGN_PLAN_PROVIDER,
      payload: JSON.parse(JSON.stringify({ ...PLAN, id: null })) as unknown,
    });

    const plan = await loadPlan(db, 'plan-1');
    expect(plan).toEqual({ ...PLAN, id: 'plan-1' });
  });

  it('строки нет — PlanNotFoundError', async () => {
    await expect(loadPlan(storeOf(null), 'plan-1')).rejects.toThrow(PlanNotFoundError);
  });

  it('чужой креатив планом не считается', async () => {
    const db = storeOf({ id: 'plan-1', provider: 'openai', payload: {} });
    await expect(loadPlan(db, 'plan-1')).rejects.toThrow(PlanNotFoundError);
  });

  it('план, не проходящий схему, не применяется', async () => {
    const broken = { ...PLAN, id: null, totalDailyBudgetRub: 999 };
    const db = storeOf({
      id: 'plan-1',
      provider: CAMPAIGN_PLAN_PROVIDER,
      payload: JSON.parse(JSON.stringify(broken)) as unknown,
    });

    // Сумма бюджетов кампаний не сходится с общим — ровно то, что ловит superRefine.
    await expect(loadPlan(db, 'plan-1')).rejects.toThrow(PlanCorruptedError);
  });
});
