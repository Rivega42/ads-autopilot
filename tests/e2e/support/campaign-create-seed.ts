import { BriefStatus, Provider } from '@prisma/client';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';

import type { ClientBriefData } from '@/ai/onboarding/brief.schema.js';
import type { AdTextsDraft, StructureDraft } from '@/campaigns/plan.schema.js';
import type { RunStructureAgent, RunTextsAgent } from '@/campaigns/planner.js';
import type { AgentRun } from '@/clients/llm/index.js';
import { prisma } from '@/db/prisma.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

/** Совпадает с `YANDEX_DIRECT_BASE_URL` при `YANDEX_DIRECT_USE_SANDBOX=true`. */
const BASE = 'https://api-sandbox.direct.yandex.com/json/v5';

const HEADERS = {
  Units: '10/60000/64000',
  RequestId: '1234567890123456789',
};

// ── Кабинет ──────────────────────────────────────────────────────────────────

/**
 * Мок методов `add` Директа v5.
 *
 * Существующие моки кабинета (`yandex-api-mock.ts`, `moderation-direct-mock.ts`)
 * знают только чтение и правку — ни одного `add` в них нет, потому что до этого
 * эпика система ничего не создавала.
 *
 * Правила ровно те, на которых площадка отказывает, и ни одного удобного
 * послабления (docs/LESSONS.md — мок, отвечающий удобно, прячет блокеры):
 *
 *  • «не более N объектов в одном вызове метода»: 10 кампаний, 1000 групп,
 *    1000 фраз, 1000 объявлений в `add` и 10 000 идентификаторов в `Ads.moderate`.
 *    Перебор — ошибка запроса 9300 на весь запрос, не создано ничего;
 *  • `TextAd` обязан вести хоть куда-то: без `Href`, `TurboPageId`, `VCardId` и
 *    `BusinessId` — ошибка операции 4003;
 *  • `RegionIds` проверяется как геотаргетинг: только минус-регионы, повтор
 *    региона, минус-регион, совпадающий с регионом показа, и минус-регион, не
 *    вложенный ни в один из регионов показа — ошибка операции 5120;
 *  • токен обязателен на каждом запросе: без него 53, а не создание;
 *  • незнакомый метод — исключение, а не пустой ответ: тест обязан падать на
 *    незапланированном обращении.
 *
 * Дерево регионов здесь своё, а не импортированное из `@/campaigns/geo.js`:
 * мок, который спрашивает вложенность у проверяемого кода, доказывает сам себя.
 */

const RUSSIA = 225;

/** Кусок настоящего справочника GeoRegions: ребёнок → родитель. */
const REGION_PARENT: Readonly<Record<number, number>> = {
  1: RUSSIA, // Москва и область → Россия
  213: 1, // Москва → Москва и область
  10174: RUSSIA, // Санкт-Петербург и Ленинградская область → Россия
  2: 10174, // Санкт-Петербург → Санкт-Петербург и Ленинградская область
  10995: RUSSIA, // Краснодарский край → Россия
  35: 10995, // Краснодар → Краснодарский край
  239: 10995, // Сочи → Краснодарский край
};

/** Корни справочника: у страны родителя нет, и это не пробел в дереве. */
const COUNTRIES: ReadonlySet<number> = new Set([RUSSIA, 149, 159]);

/**
 * Всё, что не страна и не выписано выше, справочник держит внутри России через
 * область, которой здесь нет: её номер ни на один ответ мока не влияет.
 *
 * Так отвечает и площадка: «Россия, кроме Сочи» Директ принимает, и с любым
 * другим российским городом на месте Сочи — тоже. Мок, у которого неизвестный
 * номер не вложен никуда, был бы строже площадки и отказывал бы исправному коду.
 */
function parentOf(id: number): number | undefined {
  if (COUNTRIES.has(id)) return undefined;
  return REGION_PARENT[id] ?? RUSSIA;
}

const MAX_OBJECTS: Readonly<Record<string, number>> = {
  campaigns: 10,
  adgroups: 1_000,
  keywords: 1_000,
  ads: 1_000,
};

/** У `Ads.moderate` предел свой, и он на порядок больше, чем у `Ads.add`. */
const MAX_IDS_PER_MODERATE = 10_000;

const ITEMS_KEY: Readonly<Record<string, string>> = {
  campaigns: 'Campaigns',
  adgroups: 'AdGroups',
  keywords: 'Keywords',
  ads: 'Ads',
};

function within(ancestor: number, id: number): boolean {
  for (let cur: number | undefined = id; cur !== undefined; cur = parentOf(cur)) {
    if (cur === ancestor) return true;
  }
  return false;
}

interface OperationError {
  Code: number;
  Message: string;
  Details?: string;
}

const GEO_ERROR: OperationError = { Code: 5120, Message: 'Геотаргетинг задан неправильно' };

function checkRegions(value: unknown): OperationError | null {
  if (!Array.isArray(value) || value.length === 0) return GEO_ERROR;
  const ids = value as number[];
  const positive = ids.filter((id) => id > 0);
  const negative = ids.filter((id) => id < 0).map((id) => -id);

  if (positive.length === 0) return { ...GEO_ERROR, Details: 'указаны только минус-регионы' };
  if (new Set(ids.map((id) => Math.abs(id))).size !== ids.length) {
    return { ...GEO_ERROR, Details: 'регион повторяется несколько раз' };
  }
  for (const id of negative) {
    if (positive.includes(id)) {
      return { ...GEO_ERROR, Details: `минус-регион ${id} совпадает с регионом показа` };
    }
    if (!positive.some((region) => within(region, id))) {
      return { ...GEO_ERROR, Details: `минус-регион ${id} не входит ни в один регион показа` };
    }
  }
  return null;
}

function checkAd(item: Record<string, unknown>): OperationError | null {
  const ad = item['TextAd'];
  if (typeof ad !== 'object' || ad === null) {
    return { Code: 5000, Message: 'Поле обязательно для заполнения', Details: 'TextAd' };
  }
  const text = ad as Record<string, unknown>;
  for (const field of ['Title', 'Text', 'Mobile']) {
    if (!text[field]) {
      return { Code: 5000, Message: 'Поле обязательно для заполнения', Details: field };
    }
  }
  if (!text['Href'] && !text['TurboPageId'] && !text['VCardId'] && !text['BusinessId']) {
    return {
      Code: 4003,
      Message: 'Не передано ни одного из необходимых параметров',
      Details: 'Href, TurboPageId, VCardId, BusinessId',
    };
  }
  return null;
}

function checkItem(service: string, item: Record<string, unknown>): OperationError | null {
  switch (service) {
    case 'campaigns':
      return item['Name'] && item['StartDate']
        ? null
        : { Code: 5000, Message: 'Поле обязательно для заполнения', Details: 'Name/StartDate' };
    case 'adgroups':
      return item['CampaignId'] === undefined
        ? { Code: 5000, Message: 'Поле обязательно для заполнения', Details: 'CampaignId' }
        : checkRegions(item['RegionIds']);
    case 'keywords':
      return item['Keyword'] && item['AdGroupId'] !== undefined
        ? null
        : { Code: 5000, Message: 'Поле обязательно для заполнения', Details: 'Keyword/AdGroupId' };
    case 'ads':
      return checkAd(item);
    default:
      return null;
  }
}

export interface DirectAddCall {
  service: string;
  method: string;
  /** Объекты, уехавшие в этом запросе: по ним видно и размер пачки, и её содержимое. */
  items: Record<string, unknown>[];
  params: Record<string, unknown>;
  token: string | null;
  /** Ошибка запроса, если площадка отказала целиком. */
  requestError?: number;
  /** Коды ошибок уровня операции по каждому объекту. */
  operationErrors: number[];
}

export interface DirectAddMock {
  server: SetupServer;
  calls: DirectAddCall[];
  callsTo(service: string): DirectAddCall[];
  /** Всё, что площадка реально создала, по сервисам. */
  created: Record<string, Record<string, unknown>[]>;
  reset(): void;
}

export function createDirectAddMock(options: { token: string }): DirectAddMock {
  const calls: DirectAddCall[] = [];
  const created: Record<string, Record<string, unknown>[]> = {
    campaigns: [],
    adgroups: [],
    keywords: [],
    ads: [],
  };
  let nextId = 100_000;

  const handler: HttpHandler = http.post(`${BASE}/:service`, async ({ request, params }) => {
    const service = String(params['service']);
    const body = (await request.json()) as { method?: string; params?: Record<string, unknown> };
    const method = body.method ?? '';
    const sent = body.params ?? {};
    const raw = request.headers.get('authorization');
    const token = raw?.startsWith('Bearer ') ? raw.slice('Bearer '.length) : null;

    if (method === 'moderate') {
      const ids = (sent['SelectionCriteria'] as { Ids?: number[] } | undefined)?.Ids ?? [];
      const call: DirectAddCall = {
        service,
        method,
        items: [],
        params: sent,
        token,
        operationErrors: [],
      };
      calls.push(call);
      if (ids.length > MAX_IDS_PER_MODERATE) {
        call.requestError = 9300;
        return HttpResponse.json(
          {
            error: {
              error_code: 9300,
              error_string: 'Превышено ограничение на количество объектов в одном запросе',
              error_detail: `${service}.moderate: ${ids.length} при пределе ${MAX_IDS_PER_MODERATE}`,
              request_id: HEADERS.RequestId,
            },
          },
          { headers: HEADERS },
        );
      }
      return HttpResponse.json(
        { result: { ModerateResults: ids.map((id) => ({ Id: id })) } },
        { headers: HEADERS },
      );
    }

    const key = ITEMS_KEY[service];
    if (method !== 'add' || key === undefined) {
      throw new Error(`мок Директа не знает вызова ${service}.${method}`);
    }
    const items = (sent[key] ?? []) as Record<string, unknown>[];
    const call: DirectAddCall = {
      service,
      method,
      items,
      params: sent,
      token,
      operationErrors: [],
    };
    calls.push(call);

    if (token !== options.token) {
      return HttpResponse.json(
        { error: { error_code: 53, error_string: 'Authorization error' } },
        { status: 401, headers: HEADERS },
      );
    }

    const limit = MAX_OBJECTS[service] ?? 0;
    if (items.length > limit) {
      call.requestError = 9300;
      return HttpResponse.json(
        {
          error: {
            error_code: 9300,
            error_string: 'Превышено ограничение на количество объектов в одном запросе',
            error_detail: `${service}.add: ${items.length} объектов при пределе ${limit}`,
            request_id: HEADERS.RequestId,
          },
        },
        { headers: HEADERS },
      );
    }

    const AddResults = items.map((item) => {
      const error = checkItem(service, item);
      if (error) {
        call.operationErrors.push(error.Code);
        return { Errors: [error] };
      }
      nextId += 1;
      created[service]?.push(item);
      return { Id: nextId };
    });

    return HttpResponse.json({ result: { AddResults } }, { headers: HEADERS });
  });

  const server = setupServer(handler);
  return {
    server,
    calls,
    callsTo: (service: string): DirectAddCall[] => calls.filter((c) => c.service === service),
    created,
    reset: (): void => {
      calls.length = 0;
      for (const list of Object.values(created)) list.length = 0;
    },
  };
}

// ── Клиент и бриф ────────────────────────────────────────────────────────────

export interface CampaignClientSeed {
  tgUserId: bigint;
  name: string;
  token: string;
  brief: ClientBriefData;
}

export async function seedCampaignClient(seed: CampaignClientSeed): Promise<string> {
  const client = await prisma.client.create({
    data: { tgUserId: seed.tgUserId, name: seed.name },
    select: { id: true },
  });

  await new CredentialRepository().save(client.id, Provider.YANDEX_DIRECT, {
    accessToken: seed.token,
  });

  await prisma.clientBrief.create({
    data: {
      clientId: client.id,
      status: BriefStatus.COMPLETE,
      data: JSON.parse(JSON.stringify(seed.brief)) as object,
      completedAt: new Date(),
    },
  });

  return client.id;
}

// ── Модель ───────────────────────────────────────────────────────────────────

function agentRun<T>(data: T): AgentRun<T> {
  return {
    data,
    text: JSON.stringify(data),
    provider: 'anthropic',
    model: 'e2e-stub',
    usage: { tokensIn: 0, tokensOut: 0 },
    costUsd: 0,
    latencyMs: 1,
    cached: false,
    aiRunId: null,
  };
}

export interface PlannerStubs {
  runStructure: RunStructureAgent;
  runTexts: RunTextsAgent;
  structureCalls: number;
  textsCalls: number;
  /** Имена групп, о которых спрашивали тексты, — в порядке запроса. */
  askedGroups: string[];
}

/**
 * Детерминированная подмена обоих агентов (CLAUDE.md §5: LLM в тестах не зовём).
 * Счётчики нужны, чтобы доказать, что отказ случается до платного прогона модели.
 *
 * Тексты собираются не из черновика стратега, а из имён групп, перечисленных в
 * промпте: живая модель отвечает на то, о чём её спросили, и мок обязан вести себя
 * так же (docs/LESSONS.md). Мок, отвечающий по исходному черновику, не заметил бы
 * переименования группы внутри планировщика, а модель заметит.
 */
export function plannerStubs(structure: StructureDraft): PlannerStubs {
  const stubs: PlannerStubs = {
    structureCalls: 0,
    textsCalls: 0,
    askedGroups: [],
    runStructure: () => {
      stubs.structureCalls += 1;
      return Promise.resolve(agentRun(structure));
    },
    runTexts: (opts) => {
      stubs.textsCalls += 1;
      const names = groupNamesFromPrompt(opts.system ?? '');
      stubs.askedGroups.push(...names);
      return Promise.resolve(agentRun({ groups: names.map(adsForGroup) }));
    },
  };
  return stubs;
}

/** `formatGroupsForPrompt` перечисляет группы заголовками `### <имя>`. */
function groupNamesFromPrompt(system: string): string[] {
  const names = system
    .split('\n')
    .filter((line) => line.startsWith('### '))
    .map((line) => line.slice('### '.length).trim());
  if (names.length === 0) {
    throw new Error('в промпте текстов нет ни одной группы: мок не знает, о чём его спросили');
  }
  return names;
}

/** Имя группы уезжает в заголовок: по нему видно, чьё объявление где оказалось. */
function adsForGroup(name: string): AdTextsDraft['groups'][number] {
  return {
    name,
    ads: [
      {
        title: `Английский: ${name}`.slice(0, 33),
        title2: 'Старт сегодня',
        text: `Разговорный курс с практикой. ${name}.`.slice(0, 81),
      },
    ],
  };
}

/** Группы с заданным числом фраз: так проверяется резка пачек по лимиту метода. */
export function structureOf(groups: number, keywordsPerGroup: number): StructureDraft {
  return {
    summary: 'Сквозной прогон создания кампании',
    groups: Array.from({ length: groups }, (_, g) => ({
      name: `Группа ${g + 1}`,
      intent: 'Ищут курс прямо сейчас',
      keywords: Array.from(
        { length: keywordsPerGroup },
        (_, k) => `курсы английского ${g + 1} ${k + 1}`,
      ),
      negativeKeywords: ['бесплатно'],
    })),
    campaignNegativeKeywords: ['скачать'],
  };
}
