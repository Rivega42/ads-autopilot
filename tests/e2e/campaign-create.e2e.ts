import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDirectAddMock,
  plannerStubs,
  seedCampaignClient,
  structureOf,
  type DirectAddCall,
  type DirectAddMock,
} from './support/campaign-create-seed.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { applyPlan, type CampaignApplyResult } from '@/campaigns/apply.js';
import type { StructureDraft } from '@/campaigns/plan.schema.js';
import { EmptyPlanError, planCampaigns } from '@/campaigns/planner.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';

/**
 * Сквозной прогон создания кампании: бриф в базе → план → заливка в кабинет.
 *
 * Создание — единственная операция системы, которая тратит деньги клиента с нуля,
 * и до сих пор она ни разу не проверялась целиком: юниты писателя ходили в фикстуру,
 * которая отвечала заготовленным телом на что угодно, и три отказа площадки подряд
 * (пачка `Keywords.add` по лимиту чужого метода, `TextAd` без `Href`, минус-регион
 * вне регионов показа) жили под зелёными тестами.
 *
 * Здесь площадка отвечает по протоколу (`support/campaign-create-seed.ts`): 9300 на
 * перебор объектов в запросе, 4003 на объявление без цели показа, 5120 на негодный
 * геотаргетинг. Живого токена нет и быть не может, поэтому доказательство — тело
 * запроса и ответ по документированным правилам, а не «функция вернула успех».
 *
 * Наружу не уходит ничего: HTTP Директа перехвачен msw с `onUnhandledRequest: 'error'`,
 * оба агента подменены детерминированной подстановкой. Живая только наша БД.
 */

const TOKEN = 'campaign-create-e2e-token';
const LANDING = 'https://example.com/course';

function briefOf(over: Partial<ClientBriefData> = {}): ClientBriefData {
  return {
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
    landingUrl: LANDING,
    ...over,
  };
}

let direct: DirectAddMock;
let nextUser = 900_001n;

async function seed(brief: ClientBriefData): Promise<string> {
  const tgUserId = nextUser;
  nextUser += 1n;
  return seedCampaignClient({ tgUserId, name: `Клиент ${tgUserId}`, token: TOKEN, brief });
}

beforeAll(async () => {
  await resetDatabase();
  direct = createDirectAddMock({ token: TOKEN });
  direct.server.listen({ onUnhandledRequest: 'error' });
});

beforeEach(() => {
  direct.reset();
  resetYandexRuntimeState();
});

afterAll(async () => {
  direct.server.close();
  await prisma.$disconnect();
});

describe('план доезжает до кабинета целиком', () => {
  /**
   * Прогон один на весь блок, а снимок запросов — копия: `beforeEach` чистит
   * журнал мока перед каждым тестом, и без копии проверять было бы нечего.
   */
  let calls: DirectAddCall[] = [];
  let created: Record<string, Record<string, unknown>[]> = {};
  let campaign: CampaignApplyResult | undefined;
  let warnings: string[] = [];
  let dryRun = true;

  beforeAll(async () => {
    // Шесть групп по 200 фраз: 1200 фраз в одном `createKeywords` — больше предела
    // `Keywords.add` (1000) и меньше предела `KeywordBids.set` (10 000). Именно на
    // этом промежутке видно, чей лимит взят.
    const structure = structureOf(6, 200);
    const stubs = plannerStubs(structure);
    const clientId = await seed(briefOf());

    const plan = await planCampaigns(clientId, {
      runStructure: stubs.runStructure,
      runTexts: stubs.runTexts,
    });
    expect(plan.id).not.toBeNull();
    warnings = [...plan.warnings];

    // Только поисковая кампания: РСЯ-кампания повторяет те же 1200 фраз, а каждая
    // фраза — это отдельный upsert в нашей БД. Проверяемое от этого не меняется.
    const result = await applyPlan(plan.id ?? '', { campaignIndex: 0 });
    calls = [...direct.calls];
    created = Object.fromEntries(
      Object.entries(direct.created).map(([service, items]) => [service, [...items]]),
    );
    campaign = result.campaigns[0];
    dryRun = result.dryRun;
  });

  it('кампания, группы, фразы и объявления созданы, и площадка не отказала ни разу', () => {
    expect(dryRun).toBe(false);
    expect(campaign?.status).toBe('created');
    expect(campaign?.note).toBeUndefined();
    expect(campaign?.adGroups).toBe(6);
    expect(campaign?.keywords).toBe(1_200);
    expect(campaign?.ads).toBe(6);

    // Ни одного отказа: ни на весь запрос, ни по объекту.
    expect(calls.filter((c) => c.requestError !== undefined)).toEqual([]);
    expect(calls.flatMap((c) => c.operationErrors)).toEqual([]);
    expect(calls.every((c) => c.token === TOKEN)).toBe(true);
  });

  it('фразы режутся по лимиту Keywords.add, а не по лимиту KeywordBids.set', () => {
    const sizes = calls.filter((c) => c.service === 'keywords').map((call) => call.items.length);

    // Одной пачкой на 1200 площадка ответила бы 9300 и не создала ни одной фразы.
    expect(sizes).toEqual([1_000, 200]);
    expect(created['keywords']).toHaveLength(1_200);
  });

  it('отброшенный минус-город виден человеку в предупреждениях плана', () => {
    expect(warnings.some((w) => w.includes('Минус-города не попали в таргетинг'))).toBe(true);
  });

  it('минус-город вне регионов показа в кабинет не уезжает', () => {
    const groups = calls.filter((c) => c.service === 'adgroups').flatMap((call) => call.items);

    expect(groups).toHaveLength(6);
    // Сочи (239) не входит ни в Москву, ни в Питер: `[2, 213, -239]` — это 5120
    // на каждую группу, то есть кампания без единой группы.
    for (const group of groups) expect(group['RegionIds']).toEqual([2, 213]);
  });

  it('каждое объявление уходит с Href и уезжает на модерацию', () => {
    const ads = calls
      .filter((c) => c.service === 'ads' && c.method === 'add')
      .flatMap((c) => c.items);

    expect(ads).toHaveLength(6);
    for (const ad of ads) {
      expect(ad['TextAd']).toMatchObject({ Href: LANDING, Mobile: 'NO' });
    }
    // Объявление создаётся черновиком: без Ads.moderate кампания есть, а показов нет.
    expect(calls.filter((c) => c.method === 'moderate')).toHaveLength(1);
  });
});

describe('план, который площадка бы отклонила, не строится вовсе', () => {
  it('вложенный минус-город сохраняется: «Россия, кроме Москвы» кабинет принимает', async () => {
    const structure = structureOf(1, 3);
    const stubs = plannerStubs(structure);
    const clientId = await seed(briefOf({ geo: ['Россия'], negativeCities: ['Москва'] }));

    const plan = await planCampaigns(clientId, {
      runStructure: stubs.runStructure,
      runTexts: stubs.runTexts,
    });
    const result = await applyPlan(plan.id ?? '', { campaignIndex: 0 });

    expect(result.campaigns[0]?.status).toBe('created');
    expect(direct.callsTo('adgroups')[0]?.items[0]?.['RegionIds']).toEqual([225, -213]);
    expect(direct.calls.flatMap((c) => c.operationErrors)).toEqual([]);
  });

  it('«Россия, кроме Сочи и Казани» — законный таргетинг, и он доезжает до кабинета', async () => {
    const structure = structureOf(1, 3);
    const stubs = plannerStubs(structure);
    const clientId = await seed(briefOf({ geo: ['Россия'], negativeCities: ['Сочи', 'Казань'] }));

    const plan = await planCampaigns(clientId, {
      runStructure: stubs.runStructure,
      runTexts: stubs.runTexts,
    });
    const result = await applyPlan(plan.id ?? '', { campaignIndex: 0 });

    // Оба города вложены в Россию, значит оба минус-региона законны: ни планировщик
    // их не выбрасывает, ни площадка не отказывает. Казань здесь не для числа —
    // она проверяет, что мок не строже Директа на городе, которого нет в его
    // куске справочника.
    expect(direct.callsTo('adgroups')[0]?.items[0]?.['RegionIds']).toEqual([225, -43, -239]);
    expect(result.campaigns[0]?.status).toBe('created');
    expect(direct.calls.flatMap((c) => c.operationErrors)).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('Минус-города не попали в таргетинг'))).toBe(false);
  });

  it('бриф без ссылки на сайт: отказ до первого платного вызова модели', async () => {
    const structure = structureOf(1, 3);
    const stubs = plannerStubs(structure);
    const brief = briefOf();
    delete brief.landingUrl;
    const clientId = await seed(brief);

    await expect(
      planCampaigns(clientId, { runStructure: stubs.runStructure, runTexts: stubs.runTexts }),
    ).rejects.toThrow(EmptyPlanError);

    expect(stubs.structureCalls).toBe(0);
    expect(stubs.textsCalls).toBe(0);
    expect(direct.calls).toEqual([]);
  });

  it('бриф, исключающий все свои же города показа, планом не становится', async () => {
    const structure = structureOf(1, 3);
    const stubs = plannerStubs(structure);
    const clientId = await seed(briefOf({ geo: ['Москва'], negativeCities: ['Москва'] }));

    await expect(
      planCampaigns(clientId, { runStructure: stubs.runStructure, runTexts: stubs.runTexts }),
    ).rejects.toThrow(EmptyPlanError);

    expect(direct.calls).toEqual([]);
  });
});

describe('две группы с одинаковым именем не сливаются в одну', () => {
  /**
   * Стратег вправе назвать две группы одинаково — схема плана этого не запрещает,
   * и Директ не запрещает тоже. До починки такая пара складывалась в одну: фразы и
   * объявления обеих уезжали в группу, попавшую в `Map` по имени последней, первая
   * оставалась пустой, а заливка отчитывалась статусом `created`. Половина
   * оплаченной семантики показывалась не под теми объявлениями.
   */
  const DUPLICATE: StructureDraft = {
    summary: 'Стратег дал двум группам одно имя',
    groups: [
      {
        name: 'Доставка',
        intent: 'Ищут доставку прямо сейчас',
        keywords: ['доставка пиццы', 'привезти пиццу'],
        negativeKeywords: [],
      },
      {
        name: 'Доставка',
        intent: 'Ищут заказ на дом',
        keywords: ['заказать пиццу домой', 'пицца на дом'],
        negativeKeywords: [],
      },
    ],
    campaignNegativeKeywords: [],
  };

  it('каждая группа уносит в кабинет свои фразы и свои объявления', async () => {
    const stubs = plannerStubs(DUPLICATE);
    const clientId = await seed(briefOf({ geo: ['Москва'], negativeCities: [] }));

    const plan = await planCampaigns(clientId, {
      runStructure: stubs.runStructure,
      runTexts: stubs.runTexts,
    });
    const result = await applyPlan(plan.id ?? '', { campaignIndex: 0 });

    // Имя различает группы и для человека в кабинете, и для модели: тексты она
    // возвращает по именам, и об одноимённых группах её просто нельзя спросить.
    expect(plan.campaigns[0]?.adGroups.map((g) => g.name)).toEqual(['Доставка', 'Доставка 2']);
    expect(stubs.askedGroups).toEqual(['Доставка', 'Доставка 2']);
    expect(plan.warnings.some((w) => w.includes('переименованы'))).toBe(true);

    expect(result.campaigns[0]?.status).toBe('created');
    expect(direct.calls.flatMap((c) => c.operationErrors)).toEqual([]);

    // Раскладка по группам глазами площадки: id групп мок выдаёт сам, поэтому
    // проверяем не сами id, а то, что фразы и объявления одной группы попали
    // в один и тот же id, а разных — в разные.
    const cabinet = new Map<unknown, { phrases: string[]; titles: string[] }>();
    const groupOf = (id: unknown): { phrases: string[]; titles: string[] } => {
      const known = cabinet.get(id);
      if (known) return known;
      const fresh = { phrases: [], titles: [] };
      cabinet.set(id, fresh);
      return fresh;
    };
    for (const item of direct.callsTo('keywords').flatMap((c) => c.items)) {
      groupOf(item['AdGroupId']).phrases.push(String(item['Keyword']));
    }
    for (const item of direct.callsTo('ads').flatMap((c) => c.items)) {
      const ad = item['TextAd'] as Record<string, unknown>;
      groupOf(item['AdGroupId']).titles.push(String(ad['Title']));
    }

    expect([...cabinet.values()].map((g) => ({ ...g, phrases: [...g.phrases].sort() }))).toEqual([
      { phrases: ['доставка пиццы', 'привезти пиццу'], titles: ['Английский: Доставка'] },
      {
        phrases: ['заказать пиццу домой', 'пицца на дом'],
        titles: ['Английский: Доставка 2'],
      },
    ]);

    // Зеркало в БД обязано показывать то же самое: иначе оптимизатор завтра будет
    // двигать ставки фразам, которых в этой группе нет.
    const mirrored = await prisma.adGroup.findMany({
      where: { campaign: { externalId: result.campaigns[0]?.externalId ?? '' } },
      select: { name: true, keywords: { select: { phrase: true } } },
      orderBy: { name: 'asc' },
    });
    expect(
      mirrored.map((g) => ({ name: g.name, phrases: g.keywords.map((k) => k.phrase).sort() })),
    ).toEqual([
      { name: 'Доставка', phrases: ['доставка пиццы', 'привезти пиццу'] },
      { name: 'Доставка 2', phrases: ['заказать пиццу домой', 'пицца на дом'] },
    ]);
  });
});
