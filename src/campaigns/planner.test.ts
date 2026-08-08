import { Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import {
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  textLength,
} from '@/campaigns/limits.js';
import type { AdTextsDraft, StructureDraft } from '@/campaigns/plan.schema.js';
import {
  EmptyPlanError,
  IncompleteBriefError,
  planBudgets,
  planCampaigns,
  startingBid,
  type PlannerStore,
  type RunStructureAgent,
  type RunTextsAgent,
} from '@/campaigns/planner.js';
import type { AgentRun } from '@/clients/llm/index.js';

/**
 * Планировщик проверяется целиком, но без сети: модель, БД и промпты подменены
 * или читаются с диска. Ни один тест не должен уметь потратить деньги.
 */

const BRIEF: ClientBriefData = {
  product: 'Курсы английского для программистов',
  audience: { description: 'Разработчики 25-40 лет', ageFrom: 25, ageTo: 40 },
  geo: ['Москва', 'Санкт-Петербург'],
  negativeCities: ['Сочи'],
  usp: ['IT-лексика', 'Преподаватели из индустрии'],
  targetCpaRub: 2_000,
  dailyBudgetRub: 5_000,
  budgetScope: 'per_channel',
  competitors: [{ name: 'Skyeng' }],
  conversionGoals: [{ name: 'заявка с формы' }],
  landingUrl: 'https://example.com/course',
};

const STRUCTURE: StructureDraft = {
  summary: 'Горячий спрос на поиске плюс охват в сетях',
  groups: [
    {
      name: 'Горячий спрос',
      intent: 'Ищут курс прямо сейчас',
      keywords: ['курсы английского для программистов', 'английский для айтишников'],
      negativeKeywords: ['бесплатно'],
    },
    {
      name: 'Бренд',
      intent: 'Знают нас по имени',
      // Дубль первой фразы и фраза из девяти слов: обе не должны доехать до кабинета.
      keywords: [
        'курсы английского для программистов',
        'один два три четыре пять шесть семь восемь девять',
        'школа английского для разработчиков',
      ],
    },
  ],
  campaignNegativeKeywords: ['скачать', 'скачать'],
};

const TEXTS: AdTextsDraft = {
  groups: [
    {
      name: 'Горячий спрос',
      ads: [{ title: 'Английский для программистов', title2: 'Старт сегодня', text: 'Текст.' }],
    },
    {
      name: 'Бренд',
      ads: [{ title: 'Школа английского для IT', text: 'Разговорный курс с IT-лексикой.' }],
    },
  ],
};

function agentRun<T>(data: T): AgentRun<T> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'anthropic',
    model: 'test-model',
    usage: { tokensIn: 0, tokensOut: 0 },
    costUsd: 0,
    latencyMs: 1,
    cached: false,
    aiRunId: null,
  };
}

interface Harness {
  db: PlannerStore;
  saved: Record<string, unknown>[];
}

function makeDb(brief: unknown | null): Harness {
  const saved: Record<string, unknown>[] = [];
  const db = {
    clientBrief: {
      findUnique: vi.fn(() =>
        Promise.resolve(brief === null ? null : { data: brief, status: 'COMPLETE' }),
      ),
    },
    creative: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        saved.push(args.data);
        return Promise.resolve({ id: 'plan-1' });
      }),
    },
  } as unknown as PlannerStore;
  return { db, saved };
}

const runStructure: RunStructureAgent = () => Promise.resolve(agentRun(STRUCTURE));
const runTexts: RunTextsAgent = () => Promise.resolve(agentRun(TEXTS));

describe('planCampaigns: неполный бриф', () => {
  it('отказывается планировать, если брифа нет', async () => {
    const { db } = makeDb(null);
    const structure = vi.fn(runStructure);

    await expect(planCampaigns('c1', { db, runStructure: structure, runTexts })).rejects.toThrow(
      IncompleteBriefError,
    );
    // Главное: до модели дело не дошло — за неполный бриф платить нечем.
    expect(structure).not.toHaveBeenCalled();
  });

  it('отказывается планировать при отсутствующем целевом CPA', async () => {
    const partial = { ...BRIEF } as Partial<ClientBriefData>;
    delete partial.targetCpaRub;
    const { db } = makeDb(partial);
    const structure = vi.fn(runStructure);

    const error = await planCampaigns('c1', {
      db,
      runStructure: structure,
      runTexts,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(IncompleteBriefError);
    expect((error as IncompleteBriefError).context['issues']).toContainEqual(
      expect.stringContaining('targetCpaRub'),
    );
    expect(structure).not.toHaveBeenCalled();
  });
});

describe('planCampaigns: обычный план', () => {
  it('строит поиск и РСЯ, бюджет делится точно', async () => {
    const { db, saved } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    expect(plan.id).toBe('plan-1');
    expect(plan.campaigns.map((c) => c.placement)).toEqual(['search', 'network']);
    expect(plan.campaigns.map((c) => c.dailyBudgetRub)).toEqual([3_500, 1_500]);
    expect(plan.totalDailyBudgetRub).toBe(5_000);

    const sum = plan.campaigns.reduce((acc, c) => acc + Math.round(c.dailyBudgetRub * 100), 0);
    expect(sum).toBe(500_000);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ clientId: 'c1', provider: 'campaign-plan' });
  });

  it('отбрасывает дубли и слишком длинные фразы', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    const phrases = plan.campaigns[0]?.adGroups.flatMap((g) => g.keywords.map((k) => k.phrase));
    expect(phrases).toEqual([
      'курсы английского для программистов',
      'английский для айтишников',
      'школа английского для разработчиков',
    ]);
  });

  it('ставки считает код: 5% от целевого CPA, в сетях вдвое ниже', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    expect(plan.campaigns[0]?.adGroups[0]?.keywords[0]?.bidRub).toBe(100);
    expect(plan.campaigns[1]?.adGroups[0]?.keywords[0]?.bidRub).toBe(50);
    expect(startingBid(2_000, 'search')).toBe(100);
    expect(startingBid(1, 'network')).toBe(0.3);
  });

  it('переносит регионы и минус-города в таргетинг группы', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    // Москва 213, Санкт-Петербург 2, минус-Сочи -239.
    expect(plan.campaigns[0]?.adGroups[0]?.regionIds).toEqual([2, 213, -239]);
  });

  it('подставляет посадочную страницу в объявления', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });
    expect(plan.campaigns[0]?.adGroups[0]?.ads[0]?.href).toBe('https://example.com/course');
  });

  it('минус-фразы кампании дедуплицируются', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });
    expect(plan.campaigns[0]?.negativeKeywords).toEqual(['скачать']);
  });

  it('persist:false не пишет план в БД', async () => {
    const { db, saved } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts, persist: false });
    expect(plan.id).toBeNull();
    expect(saved).toEqual([]);
  });
});

describe('planCampaigns: лимиты текстов', () => {
  const longAds: AdTextsDraft = {
    groups: TEXTS.groups.map((group) => ({
      name: group.name,
      ads: [
        {
          title: 'Курсы английского языка для программистов и тестировщиков из IT',
          title2: 'Старт в любой день недели, в любое удобное для вас время',
          text: `Разговорный курс с IT-лексикой и практикой ${'очень длинный хвост '.repeat(6)}`,
        },
      ],
    })),
  };

  it('сначала просит модель переписать, потом обрезает сам', async () => {
    const { db } = makeDb(BRIEF);
    const runLong = vi.fn(() => Promise.resolve(agentRun(longAds)));

    const plan = await planCampaigns('c1', { db, runStructure, runTexts: runLong });

    // Одна повторная попытка — и только после неё обрезаем.
    expect(runLong).toHaveBeenCalledTimes(2);
    expect(plan.warnings.some((w) => w.includes('Обрезано полей объявлений'))).toBe(true);

    for (const campaign of plan.campaigns) {
      for (const group of campaign.adGroups) {
        for (const ad of group.ads) {
          expect(textLength(ad.title)).toBeLessThanOrEqual(DIRECT_TITLE_MAX);
          expect(textLength(ad.title2 ?? '')).toBeLessThanOrEqual(DIRECT_TITLE2_MAX);
          expect(textLength(ad.text)).toBeLessThanOrEqual(DIRECT_TEXT_MAX);
        }
      }
    }
  });

  it('вторая попытка не берётся из кеша', async () => {
    const { db } = makeDb(BRIEF);
    const calls: (boolean | undefined)[] = [];
    const runLong: RunTextsAgent = (opts) => {
      calls.push(opts.cache);
      return Promise.resolve(agentRun(longAds));
    };

    await planCampaigns('c1', { db, runStructure, runTexts: runLong });
    expect(calls).toEqual([true, false]);
  });

  it('группа без текстов пропускается с предупреждением', async () => {
    const { db } = makeDb(BRIEF);
    const partial: AdTextsDraft = { groups: TEXTS.groups.slice(0, 1) };

    const plan = await planCampaigns('c1', {
      db,
      runStructure,
      runTexts: () => Promise.resolve(agentRun(partial)),
    });

    expect(plan.campaigns[0]?.adGroups.map((g) => g.name)).toEqual(['Горячий спрос']);
    expect(plan.warnings.some((w) => w.includes('Бренд'))).toBe(true);
  });
});

describe('planCampaigns: бюджет', () => {
  it('бюджета на одну кампанию хватает — РСЯ не создаётся', async () => {
    const { db } = makeDb({ ...BRIEF, dailyBudgetRub: 400 });
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    expect(plan.campaigns).toHaveLength(1);
    expect(plan.campaigns[0]?.dailyBudgetRub).toBe(400);
    expect(plan.warnings.some((w) => w.includes('РСЯ'))).toBe(true);
  });

  it('бюджет ниже минимума площадки не даёт ни одной кампании', () => {
    const warnings: string[] = [];
    // Схема брифа не пропустит такую сумму, но раскладка обязана держаться сама:
    // именно она решает, создавать кампанию или нет.
    const budgets = planBudgets(
      { ...BRIEF, dailyBudgetRub: 100, budgetScope: 'total' },
      [Provider.YANDEX_DIRECT],
      warnings,
    );

    expect(budgets).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('два канала делят общий бюджет без потери копеек', async () => {
    const { db } = makeDb({ ...BRIEF, dailyBudgetRub: 10_001, budgetScope: 'total' });
    const plan = await planCampaigns('c1', {
      db,
      channels: [Provider.YANDEX_DIRECT, Provider.VK_ADS],
      runStructure,
      runTexts,
    });

    const sum = plan.campaigns.reduce((acc, c) => acc + Math.round(c.dailyBudgetRub * 100), 0);
    expect(sum).toBe(1_000_100);
    expect(plan.totalDailyBudgetRub).toBe(10_001);
    expect(new Set(plan.campaigns.map((c) => c.channel))).toEqual(
      new Set([Provider.YANDEX_DIRECT, Provider.VK_ADS]),
    );
  });

  it('без единой группы с текстами план не собирается', async () => {
    const { db } = makeDb(BRIEF);

    await expect(
      planCampaigns('c1', {
        db,
        runStructure,
        runTexts: () => Promise.resolve(agentRun({ groups: [{ name: 'Другая', ads: [] }] })),
      }),
    ).rejects.toThrow(EmptyPlanError);
  });
});
