import { Provider } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import {
  DIRECT_TEXT_MAX,
  DIRECT_TITLE2_MAX,
  DIRECT_TITLE_MAX,
  textLength,
} from '@/campaigns/limits.js';
import {
  PLANNED_GROUP_NAME_MAX,
  type AdTextsDraft,
  type StructureDraft,
} from '@/campaigns/plan.schema.js';
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

  it('минус-город вне регионов показа в таргетинг не уезжает', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    // Москва 213 и Санкт-Петербург 2. Сочи (239) не входит ни в один из них:
    // `[2, 213, -239]` Директ отклоняет ошибкой 5120, а показов в Сочи и так нет.
    expect(plan.campaigns[0]?.adGroups[0]?.regionIds).toEqual([2, 213]);
    expect(plan.warnings.some((w) => w.includes('Минус-города не попали в таргетинг'))).toBe(true);
  });

  it('вложенный минус-город сохраняется: «Россия, кроме Москвы» — валидный набор', async () => {
    const { db } = makeDb({ ...BRIEF, geo: ['Россия'], negativeCities: ['Москва'] });
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    expect(plan.campaigns[0]?.adGroups[0]?.regionIds).toEqual([225, -213]);
    expect(plan.warnings.some((w) => w.includes('Минус-города не попали'))).toBe(false);
  });

  it('город и в показах, и в минусах — запрет сильнее, и об этом предупреждают', async () => {
    const { db } = makeDb({
      ...BRIEF,
      geo: ['Москва', 'Санкт-Петербург'],
      negativeCities: ['Москва'],
    });
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    expect(plan.campaigns[0]?.adGroups[0]?.regionIds).toEqual([2]);
    expect(plan.warnings.some((w) => w.includes('Из городов показа убраны'))).toBe(true);
  });

  it('план не строится, если бриф исключает всё, что просит показывать', async () => {
    const { db } = makeDb({ ...BRIEF, geo: ['Москва'], negativeCities: ['Москва'] });

    await expect(planCampaigns('c1', { db, runStructure, runTexts })).rejects.toThrow(
      EmptyPlanError,
    );
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

  it('обрезанные тексты не выбрасываются, если на второй попытке группу пропустили', async () => {
    const { db } = makeDb(BRIEF);
    // Первая попытка: обе группы с переливом. Вторая: модель починила только одну,
    // про «Бренд» промолчала. Валидный обрезанный вариант «Бренда» терять нельзя —
    // он уже оплачен, уложен в лимиты и отличается от «текстов не было вовсе».
    const onlyFirstGroup: AdTextsDraft = { groups: TEXTS.groups.slice(0, 1) };
    const runTwice = vi.fn((): Promise<AgentRun<AdTextsDraft>> => {
      const attempt = runTwice.mock.calls.length;
      return Promise.resolve(agentRun(attempt === 1 ? longAds : onlyFirstGroup));
    });

    const plan = await planCampaigns('c1', { db, runStructure, runTexts: runTwice });

    expect(runTwice).toHaveBeenCalledTimes(2);
    expect(plan.campaigns[0]?.adGroups.map((g) => g.name)).toEqual(['Горячий спрос', 'Бренд']);
    // Ложное «модель не вернула тексты» здесь было бы враньём: тексты она вернула.
    expect(plan.warnings.some((w) => w.includes('модель не вернула тексты'))).toBe(false);
    expect(plan.warnings.some((w) => w.includes('Обрезано полей объявлений'))).toBe(true);

    for (const ad of plan.campaigns[0]?.adGroups[1]?.ads ?? []) {
      expect(textLength(ad.title)).toBeLessThanOrEqual(DIRECT_TITLE_MAX);
      expect(textLength(ad.text)).toBeLessThanOrEqual(DIRECT_TEXT_MAX);
    }
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

/**
 * Объявление обязано вести хоть куда-то: Директ принимает `TextAd` только с одним из
 * `Href`, `TurboPageId`, `VCardId`, `BusinessId` (Ads.add), а из них система умеет
 * заполнить только `Href`. План без ссылки применить нельзя — значит и строить его
 * нельзя, тем более что до отказа площадки успели бы отработать два платных прогона
 * модели, а кампания и группы в кабинете уже были бы созданы.
 */
describe('planCampaigns: объявлению нужна цель показа', () => {
  const briefWithoutSite: ClientBriefData = { ...BRIEF };
  delete briefWithoutSite.landingUrl;

  it('без ссылки на сайт план не строится', async () => {
    const { db } = makeDb(briefWithoutSite);

    await expect(planCampaigns('c1', { db, runStructure, runTexts })).rejects.toThrow(
      EmptyPlanError,
    );
  });

  it('отказ случается до обращения к модели: платить за неприменимый план не за что', async () => {
    const { db } = makeDb(briefWithoutSite);
    const structure = vi.fn(() => Promise.resolve(agentRun(STRUCTURE)));
    const texts = vi.fn(() => Promise.resolve(agentRun(TEXTS)));

    await expect(
      planCampaigns('c1', { db, runStructure: structure, runTexts: texts }),
    ).rejects.toThrow(EmptyPlanError);
    expect(structure).not.toHaveBeenCalled();
    expect(texts).not.toHaveBeenCalled();
  });

  it('со ссылкой каждое объявление плана несёт href', async () => {
    const { db } = makeDb(BRIEF);
    const plan = await planCampaigns('c1', { db, runStructure, runTexts });

    const ads = plan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.ads));
    expect(ads.length).toBeGreaterThan(0);
    expect(ads.every((ad) => ad.href === BRIEF.landingUrl)).toBe(true);
  });
});

/**
 * Имя группы — единственная ручка, за которую её берут снаружи: по имени модель
 * возвращает тексты (`### <имя>` в промпте), по имени группу узнаёт клиент в
 * кабинете. Двум группам одно имя носить нельзя: спросить у модели тексты
 * отдельно для каждой невозможно в принципе, а `Map` по имени схлопывает их
 * содержимое в одно.
 */
describe('planCampaigns: одноимённые группы', () => {
  function structureWith(names: [string, string]): StructureDraft {
    return {
      summary: 'Две группы, одно имя',
      groups: [
        {
          name: names[0],
          intent: 'Ищут курс прямо сейчас',
          keywords: ['курсы английского для программистов'],
          negativeKeywords: [],
        },
        {
          name: names[1],
          intent: 'Знают нас по имени',
          keywords: ['школа английского для разработчиков'],
          negativeKeywords: [],
        },
      ],
      campaignNegativeKeywords: [],
    };
  }

  /** Модель отвечает ровно про те группы, о которых её спросили, — как живая. */
  function textsByPrompt(): { run: RunTextsAgent; asked: string[] } {
    const asked: string[] = [];
    const run: RunTextsAgent = (opts) => {
      const names = (opts.system ?? '')
        .split('\n')
        .filter((line) => line.startsWith('### '))
        .map((line) => line.slice('### '.length).trim());
      asked.push(...names);
      return Promise.resolve(
        agentRun({
          groups: names.map((name) => ({
            name,
            ads: [{ title: `Курс: ${name}`, text: `Разговорный курс. ${name}.` }],
          })),
        }),
      );
    };
    return { run, asked };
  }

  it('второе такое же имя получает номер, и тексты не смешиваются', async () => {
    const { db } = makeDb(BRIEF);
    const texts = textsByPrompt();

    const plan = await planCampaigns('c1', {
      db,
      runStructure: () => Promise.resolve(agentRun(structureWith(['Бренд', 'Бренд']))),
      runTexts: texts.run,
    });

    expect(texts.asked).toEqual(['Бренд', 'Бренд 2']);
    const groups = plan.campaigns[0]?.adGroups ?? [];
    expect(
      groups.map((g) => ({
        name: g.name,
        phrases: g.keywords.map((k) => k.phrase),
        titles: g.ads.map((a) => a.title),
      })),
    ).toEqual([
      {
        name: 'Бренд',
        phrases: ['курсы английского для программистов'],
        titles: ['Курс: Бренд'],
      },
      {
        name: 'Бренд 2',
        phrases: ['школа английского для разработчиков'],
        titles: ['Курс: Бренд 2'],
      },
    ]);
  });

  it('переименование не прячется от человека: оно в предупреждениях плана', async () => {
    const { db } = makeDb(BRIEF);
    const texts = textsByPrompt();

    const plan = await planCampaigns('c1', {
      db,
      runStructure: () => Promise.resolve(agentRun(structureWith(['Бренд', 'Бренд']))),
      runTexts: texts.run,
    });

    expect(plan.warnings.some((w) => w.includes('«Бренд» → «Бренд 2»'))).toBe(true);
  });

  it('регистр и лишние пробелы различием не считаются', async () => {
    const { db } = makeDb(BRIEF);
    const texts = textsByPrompt();

    const plan = await planCampaigns('c1', {
      db,
      runStructure: () => Promise.resolve(agentRun(structureWith(['Бренд', 'бренд']))),
      runTexts: texts.run,
    });

    // Клиент в кабинете видит две строки, отличающиеся регистром одной буквы;
    // модель на такой промпт отвечает одним блоком текстов на обе группы.
    expect(plan.campaigns[0]?.adGroups.map((g) => g.name)).toEqual(['Бренд', 'бренд 2']);
  });

  it('длинное имя с номером остаётся в пределах схемы плана', async () => {
    const { db } = makeDb(BRIEF);
    const texts = textsByPrompt();
    const long = 'Группа '.repeat(20).trim().slice(0, PLANNED_GROUP_NAME_MAX);

    const plan = await planCampaigns('c1', {
      db,
      runStructure: () => Promise.resolve(agentRun(structureWith([long, long]))),
      runTexts: texts.run,
    });

    const names = plan.campaigns[0]?.adGroups.map((g) => g.name) ?? [];
    expect(names[1]).toMatch(/ 2$/u);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(PLANNED_GROUP_NAME_MAX);
  });
});
