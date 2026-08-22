import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createDirectAddMock,
  plannerStubs,
  seedCampaignClient,
  structureOf,
  textsFor,
  type DirectAddCall,
  type DirectAddMock,
} from './support/campaign-create-seed.js';
import { resetDatabase } from './support/database.js';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import { applyPlan, type CampaignApplyResult } from '@/campaigns/apply.js';
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
    const stubs = plannerStubs(structure, textsFor(structure));
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
    const stubs = plannerStubs(structure, textsFor(structure));
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

  it('бриф без ссылки на сайт: отказ до первого платного вызова модели', async () => {
    const structure = structureOf(1, 3);
    const stubs = plannerStubs(structure, textsFor(structure));
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
    const stubs = plannerStubs(structure, textsFor(structure));
    const clientId = await seed(briefOf({ geo: ['Москва'], negativeCities: ['Москва'] }));

    await expect(
      planCampaigns(clientId, { runStructure: stubs.runStructure, runTexts: stubs.runTexts }),
    ).rejects.toThrow(EmptyPlanError);

    expect(direct.calls).toEqual([]);
  });
});
