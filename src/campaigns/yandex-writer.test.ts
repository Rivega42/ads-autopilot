import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOutcomeOf } from '@/campaigns/writer.js';
import { YandexCampaignWriter } from '@/campaigns/yandex-writer.js';
import type { ChannelContext } from '@/channels/types.js';
import {
  resetYandexRuntimeState,
  type HttpRequest,
  type HttpResponse,
} from '@/clients/yandex-direct/http.js';
import { MICROS } from '@/clients/yandex-direct/schemas.js';
import { AppError, ChannelError } from '@/lib/errors.js';

/**
 * Транспорт подменён — ни одного сетевого запроса. Проверяем именно то, что
 * уезжает в Директ: единицы измерения денег, обязательные поля и поведение
 * на ошибке уровня операции.
 */

interface FakeTransport {
  (req: HttpRequest): Promise<HttpResponse>;
  calls: HttpRequest[];
}

function transportOf(bodies: unknown[]): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = (req: HttpRequest): Promise<HttpResponse> => {
    const index = calls.length;
    calls.push(req);
    return Promise.resolve({ status: 200, headers: {}, data: bodies[index] ?? bodies.at(-1) });
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

/** Тот же шов, но с HTTP-кодами: ретраи разбираются именно по ним. */
function transportOfSteps(steps: { status?: number; data?: unknown }[]): FakeTransport {
  const calls: HttpRequest[] = [];
  const fn = (req: HttpRequest): Promise<HttpResponse> => {
    const step = steps[calls.length] ?? steps.at(-1);
    calls.push(req);
    return Promise.resolve({
      status: step?.status ?? 200,
      headers: {},
      data: step?.data ?? { result: {} },
    });
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

function writerOf(transport: FakeTransport): YandexCampaignWriter {
  return new YandexCampaignWriter({
    transport,
    ledger: { record: () => Promise.resolve() },
    baseUrl: 'https://api-sandbox.direct.yandex.com/json/v5/',
    unitsReserve: 0,
  });
}

const CTX: ChannelContext = {
  clientId: 'client-1',
  credentials: { accessToken: 't' },
  dryRun: false,
};

function params(req: HttpRequest | undefined): Record<string, unknown> {
  return (req?.body as { params?: Record<string, unknown> })?.params ?? {};
}

function method(req: HttpRequest | undefined): string {
  return (req?.body as { method?: string })?.method ?? '';
}

beforeEach(() => {
  resetYandexRuntimeState();
});

describe('createCampaign', () => {
  it('шлёт Campaigns.add с бюджетом в микроединицах и обеими сторонами стратегии', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 777 }] } }]);
    const created = await writerOf(transport).createCampaign(CTX, {
      name: 'Поиск — Курсы',
      dailyBudgetRub: 3_500,
      strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
      negativeKeywords: ['скачать'],
      startDate: '2026-08-08',
    });

    expect(created).toEqual({ externalId: '777' });
    expect(method(transport.calls[0])).toBe('add');

    const campaign = (params(transport.calls[0])['Campaigns'] as Record<string, unknown>[])[0];
    expect(campaign).toMatchObject({
      Name: 'Поиск — Курсы',
      StartDate: '2026-08-08',
      DailyBudget: { Amount: 3_500 * MICROS, Mode: 'STANDARD' },
      NegativeKeywords: { Items: ['скачать'] },
    });
    expect(campaign?.['TextCampaign']).toEqual({
      BiddingStrategy: {
        Search: { BiddingStrategyType: 'HIGHEST_POSITION' },
        Network: { BiddingStrategyType: 'SERVING_OFF' },
      },
    });
  });

  it('пустой список минус-фраз не отправляется вовсе', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 1 }] } }]);
    await writerOf(transport).createCampaign(CTX, {
      name: 'РСЯ',
      dailyBudgetRub: 300,
      strategy: { search: { type: 'SERVING_OFF' }, network: { type: 'MAXIMUM_COVERAGE' } },
      negativeKeywords: [],
      startDate: '2026-08-08',
    });

    const campaign = (params(transport.calls[0])['Campaigns'] as Record<string, unknown>[])[0];
    expect(campaign).not.toHaveProperty('NegativeKeywords');
  });

  it('ошибку уровня операции превращает в ChannelError, а не в «создано»', async () => {
    const transport = transportOf([
      { result: { AddResults: [{ Errors: [{ Code: 5001, Message: 'Bad budget' }] }] } },
    ]);

    await expect(
      writerOf(transport).createCampaign(CTX, {
        name: 'Поиск',
        dailyBudgetRub: 10,
        strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
        negativeKeywords: [],
        startDate: '2026-08-08',
      }),
    ).rejects.toThrow(ChannelError);
  });
});

describe('ретраи неидемпотентного add', () => {
  const SPEC = {
    name: 'Поиск — Курсы',
    dailyBudgetRub: 3_500,
    strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
    negativeKeywords: [],
    startDate: '2026-08-08',
  };

  it('потерянный ответ (502) не повторяется: одна кампания — один запрос', async () => {
    const transport = transportOfSteps([{ status: 502, data: 'bad gateway' }]);

    const err = await writerOf(transport)
      .createCampaign(CTX, SPEC)
      .catch((e: unknown) => e);

    // Директ мог кампанию создать. Второй POST с тем же телом — вторая кампания
    // с полным дневным бюджетом, и ключа идемпотентности в v5 нет.
    expect(transport.calls).toHaveLength(1);
    expect(createOutcomeOf(err)).toBe('unknown');
  });

  it('внутренняя ошибка Директа (1000) тоже не повторяется', async () => {
    const transport = transportOfSteps([
      { data: { error: { error_code: 1000, error_string: 'Внутренняя ошибка сервера' } } },
    ]);

    const err = await writerOf(transport)
      .createCampaign(CTX, SPEC)
      .catch((e: unknown) => e);

    expect(transport.calls).toHaveLength(1);
    expect(createOutcomeOf(err)).toBe('unknown');
  });

  it('чужая форма ответа не выдаётся за отказ: исход неизвестен', async () => {
    const transport = transportOfSteps([{ data: { result: { AddResults: 'not-an-array' } } }]);

    const err = await writerOf(transport)
      .createCampaign(CTX, SPEC)
      .catch((e: unknown) => e);

    // Запись прошла, разбор ответа — нет. Кампания в кабинете может быть.
    expect(transport.calls).toHaveLength(1);
    expect(createOutcomeOf(err)).toBe('unknown');
  });

  it('доказанный отказ на входе (52) повторяется и доезжает со второй попытки', async () => {
    const transport = transportOfSteps([
      { data: { error: { error_code: 52, error_string: 'Сервер авторизации недоступен' } } },
      { data: { result: { AddResults: [{ Id: 777 }] } } },
    ]);

    vi.useFakeTimers();
    try {
      const pending = writerOf(transport).createCampaign(CTX, SPEC);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ externalId: '777' });
    } finally {
      vi.useRealTimers();
    }
    expect(transport.calls).toHaveLength(2);
  });

  it('отказ уровня операции помечается как «точно не создано»', async () => {
    const transport = transportOfSteps([
      { data: { result: { AddResults: [{ Errors: [{ Code: 5001, Message: 'Bad budget' }] }] } } },
    ]);

    const err = await writerOf(transport)
      .createCampaign(CTX, SPEC)
      .catch((e: unknown) => e);

    expect(createOutcomeOf(err)).toBe('not-created');
  });

  it('дубли фраз не создаются повтором: keywords.add при 503 уходит один раз', async () => {
    const transport = transportOfSteps([{ status: 503 }]);

    await expect(
      writerOf(transport).createKeywords(CTX, [
        { adGroupExternalId: '10', phrase: 'курсы английского', bidRub: 100 },
      ]),
    ).rejects.toThrow(ChannelError);
    expect(transport.calls).toHaveLength(1);
  });
});

describe('createAdGroups / createKeywords / createAds', () => {
  it('группы уезжают с регионами и возвращаются с именами', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 10 }, { Id: 11 }] } }]);
    const groups = await writerOf(transport).createAdGroups(CTX, '777', [
      { name: 'Горячий спрос', regionIds: [213, -239], negativeKeywords: ['бесплатно'] },
      { name: 'Бренд', regionIds: [213], negativeKeywords: [] },
    ]);

    expect(groups).toEqual([
      { externalId: '10', name: 'Горячий спрос' },
      { externalId: '11', name: 'Бренд' },
    ]);

    const sent = params(transport.calls[0])['AdGroups'] as Record<string, unknown>[];
    expect(sent[0]).toMatchObject({
      Name: 'Горячий спрос',
      CampaignId: 777,
      RegionIds: [213, -239],
      NegativeKeywords: { Items: ['бесплатно'] },
    });
    expect(sent[1]).not.toHaveProperty('NegativeKeywords');
  });

  it('ставка фразы уходит в микроединицах', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 20 }] } }]);
    await writerOf(transport).createKeywords(CTX, [
      { adGroupExternalId: '10', phrase: 'курсы английского', bidRub: 100.5 },
    ]);

    const sent = params(transport.calls[0])['Keywords'] as Record<string, unknown>[];
    expect(sent[0]).toEqual({ AdGroupId: 10, Keyword: 'курсы английского', Bid: 100_500_000 });
  });

  it('объявление уходит как TextAd с обязательным Mobile', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 30 }] } }]);
    await writerOf(transport).createAds(CTX, [
      {
        adGroupExternalId: '10',
        title: 'Английский для IT',
        title2: 'Старт сегодня',
        text: 'Разговорный курс.',
        href: 'https://example.com',
      },
    ]);

    const sent = params(transport.calls[0])['Ads'] as Record<string, unknown>[];
    expect(sent[0]).toEqual({
      AdGroupId: 10,
      TextAd: {
        Title: 'Английский для IT',
        Title2: 'Старт сегодня',
        Text: 'Разговорный курс.',
        Mobile: 'NO',
        Href: 'https://example.com',
      },
    });
  });

  it('пустые списки не порождают запросов', async () => {
    const transport = transportOf([{ result: {} }]);
    const writer = writerOf(transport);

    expect(await writer.createAdGroups(CTX, '777', [])).toEqual([]);
    expect(await writer.createKeywords(CTX, [])).toEqual([]);
    expect(await writer.createAds(CTX, [])).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it('нечисловой внешний id — ChannelError до выхода в сеть', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 1 }] } }]);
    await expect(
      writerOf(transport).createKeywords(CTX, [
        { adGroupExternalId: 'not-a-number', phrase: 'фраза', bidRub: 1 },
      ]),
    ).rejects.toThrow(ChannelError);
    expect(transport.calls).toEqual([]);
  });
});

describe('submitForModeration', () => {
  it('шлёт Ads.moderate и не падает на частичном отказе', async () => {
    const transport = transportOf([
      { result: { ModerateResults: [{ Id: 30 }, { Errors: [{ Code: 8000 }] }] } },
    ]);

    await writerOf(transport).submitForModeration(CTX, ['30', '31']);

    expect(method(transport.calls[0])).toBe('moderate');
    expect(params(transport.calls[0])).toEqual({ SelectionCriteria: { Ids: [30, 31] } });
  });
});

describe('инвариант dry-run', () => {
  it('вызов с dryRun-контекстом падает, а не уходит в кабинет', async () => {
    const transport = transportOf([{ result: { AddResults: [{ Id: 1 }] } }]);

    await expect(
      writerOf(transport).createCampaign(
        { ...CTX, dryRun: true },
        {
          name: 'Поиск',
          dailyBudgetRub: 300,
          strategy: { search: { type: 'HIGHEST_POSITION' }, network: { type: 'SERVING_OFF' } },
          negativeKeywords: [],
          startDate: '2026-08-08',
        },
      ),
    ).rejects.toThrow(AppError);
    expect(transport.calls).toEqual([]);
  });
});

// ── Мок, отвечающий как площадка ─────────────────────────────────────────────

/**
 * Транспорт, который ведёт себя как Директ, а не как удобно тесту.
 *
 * Фикстура из верхней части файла отдаёт заготовленный ответ на что угодно —
 * ею нельзя доказать ни одного утверждения о теле запроса. Здесь проверяется
 * ровно то, на чём площадка отказывает (`docs/LESSONS.md` — мок обязан отвечать
 * по протоколу):
 *
 *  • «не более N объектов в одном вызове метода»: 10 кампаний, 1000 групп,
 *    1000 фраз, 1000 объявлений. Перебор — ошибка запроса 9300, ни один объект
 *    не создан;
 *  • `TextAd` без цели показа (ни `Href`, ни `TurboPageId`, ни `VCardId`, ни
 *    `BusinessId`) — ошибка операции 4003;
 *  • `RegionIds`: только минус-регионы, минус-регион, совпадающий с регионом
 *    показа, и минус-регион, не вложенный ни в один из них, — ошибка операции 5120;
 *  • незапланированное обращение роняет тест, а не возвращает пустой ответ.
 *
 * Дерево регионов здесь своё, а не импортированное из `@/campaigns/geo.js`:
 * мок, спрашивающий вложенность у проверяемого кода, доказывал бы сам себя.
 */
const MAX_OBJECTS: Readonly<Record<string, number>> = {
  campaigns: 10,
  adgroups: 1_000,
  keywords: 1_000,
  ads: 1_000,
};

const ITEMS_KEY: Readonly<Record<string, string>> = {
  campaigns: 'Campaigns',
  adgroups: 'AdGroups',
  keywords: 'Keywords',
  ads: 'Ads',
};

/** Кусок настоящего справочника: Москва в Москве и области, обе — в России. */
const PARENT: Readonly<Record<number, number>> = { 213: 1, 1: 225, 2: 10174, 10174: 225 };

function within(ancestor: number, id: number): boolean {
  for (let cur: number | undefined = id; cur !== undefined; cur = PARENT[cur]) {
    if (cur === ancestor) return true;
  }
  return false;
}

interface OperationError {
  Code: number;
  Message: string;
}

function checkRegions(regionIds: unknown): OperationError | null {
  const bad = { Code: 5120, Message: 'Геотаргетинг задан неправильно' };
  if (!Array.isArray(regionIds) || regionIds.length === 0) return bad;
  const ids = regionIds as number[];
  const positive = ids.filter((id) => id > 0);
  const negative = ids.filter((id) => id < 0).map((id) => -id);

  if (positive.length === 0) return bad;
  if (new Set(ids.map(Math.abs)).size !== ids.length) return bad;
  for (const id of negative) {
    if (positive.includes(id)) return bad;
    if (!positive.some((region) => within(region, id))) return bad;
  }
  return null;
}

function checkAd(item: Record<string, unknown>): OperationError | null {
  const ad = item['TextAd'] as Record<string, unknown> | undefined;
  if (!ad || !ad['Title'] || !ad['Text'] || !ad['Mobile']) {
    return { Code: 5000, Message: 'Поле обязательно для заполнения' };
  }
  if (!ad['Href'] && !ad['TurboPageId'] && !ad['VCardId'] && !ad['BusinessId']) {
    return { Code: 4003, Message: 'Не передано ни одного из необходимых параметров' };
  }
  return null;
}

function checkItem(service: string, item: Record<string, unknown>): OperationError | null {
  if (service === 'ads') return checkAd(item);
  if (service === 'adgroups') return checkRegions(item['RegionIds']);
  if (service === 'keywords' && !item['Keyword']) {
    return { Code: 5000, Message: 'Поле обязательно для заполнения' };
  }
  return null;
}

function directTransport(): FakeTransport {
  const calls: HttpRequest[] = [];
  let nextId = 1_000;

  const fn = (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    const service = new URL(req.url).pathname.split('/').pop() ?? '';
    const body = req.body as { method?: string; params?: Record<string, unknown> };
    const method = body.method ?? '';
    const params = body.params ?? {};

    if (method === 'moderate') {
      const ids = (params['SelectionCriteria'] as { Ids?: number[] })?.Ids ?? [];
      return Promise.resolve({
        status: 200,
        headers: {},
        data: { result: { ModerateResults: ids.map((id) => ({ Id: id })) } },
      });
    }

    const key = ITEMS_KEY[service];
    if (method !== 'add' || key === undefined) {
      throw new Error(`мок Директа не знает вызова ${service}.${method}`);
    }

    const items = params[key];
    if (!Array.isArray(items)) throw new Error(`${service}.add без массива ${key}`);

    const limit = MAX_OBJECTS[service] ?? 0;
    if (items.length > limit) {
      return Promise.resolve({
        status: 200,
        headers: {},
        data: {
          error: {
            error_code: 9300,
            error_string: 'Превышено ограничение на количество объектов в одном запросе',
            error_detail: `${service}.add: ${items.length} объектов при пределе ${limit}`,
          },
        },
      });
    }

    const AddResults = (items as Record<string, unknown>[]).map((item) => {
      const error = checkItem(service, item);
      if (error) return { Errors: [error] };
      nextId += 1;
      return { Id: nextId };
    });
    return Promise.resolve({ status: 200, headers: {}, data: { result: { AddResults } } });
  };
  fn.calls = calls;
  return fn as FakeTransport;
}

function sentItems(req: HttpRequest | undefined, key: string): Record<string, unknown>[] {
  return (params(req)[key] ?? []) as Record<string, unknown>[];
}

describe('протокол: что площадка принимает', () => {
  it('мок отвергает то же, что и Директ — иначе им ничего не докажешь', async () => {
    const transport = directTransport();
    const oversize = await transport({
      url: 'https://api-sandbox.direct.yandex.com/json/v5/keywords',
      body: { method: 'add', params: { Keywords: Array.from({ length: 1_001 }, () => ({})) } },
      headers: {},
      responseType: 'json',
    });
    expect(oversize.data).toMatchObject({ error: { error_code: 9300 } });

    const noTarget = await transport({
      url: 'https://api-sandbox.direct.yandex.com/json/v5/ads',
      body: {
        method: 'add',
        params: { Ads: [{ AdGroupId: 1, TextAd: { Title: 'Т', Text: 'Т', Mobile: 'NO' } }] },
      },
      headers: {},
      responseType: 'json',
    });
    expect(noTarget.data).toMatchObject({
      result: { AddResults: [{ Errors: [{ Code: 4003 }] }] },
    });

    const badGeo = await transport({
      url: 'https://api-sandbox.direct.yandex.com/json/v5/adgroups',
      body: {
        method: 'add',
        params: { AdGroups: [{ Name: 'Г', CampaignId: 1, RegionIds: [2, 213, -239] }] },
      },
      headers: {},
      responseType: 'json',
    });
    expect(badGeo.data).toMatchObject({ result: { AddResults: [{ Errors: [{ Code: 5120 }] }] } });
  });

  it('фразы режутся по лимиту Keywords.add, а не по лимиту KeywordBids.set', async () => {
    const transport = directTransport();
    const keywords = Array.from({ length: 1_500 }, (_, i) => ({
      adGroupExternalId: '10',
      phrase: `фраза ${i}`,
      bidRub: 100,
    }));

    const created = await writerOf(transport).createKeywords(CTX, keywords);

    expect(created).toHaveLength(1_500);
    expect(transport.calls.map((call) => sentItems(call, 'Keywords').length)).toEqual([1_000, 500]);
  });

  it('объявление без ссылки не уходит в сеть вовсе', async () => {
    const transport = directTransport();

    const err = await writerOf(transport)
      .createAds(CTX, [
        {
          adGroupExternalId: '10',
          title: 'Английский для IT',
          text: 'Разговорный курс.',
          href: '',
        },
      ])
      .catch((e: unknown) => e);

    // Площадка ответила бы 4003 и списала 20 баллов квоты за отказ операции.
    expect(err).toBeInstanceOf(ChannelError);
    expect(createOutcomeOf(err)).toBe('not-created');
    expect(transport.calls).toEqual([]);
  });

  it('одно объявление без ссылки не даёт уехать и остальным', async () => {
    const transport = directTransport();
    const ads = Array.from({ length: 1_200 }, (_, i) => ({
      adGroupExternalId: '10',
      title: `Заголовок ${i}`,
      text: 'Разговорный курс.',
      href: i === 1_100 ? '' : 'https://example.com',
    }));

    await expect(writerOf(transport).createAds(CTX, ads)).rejects.toThrow(ChannelError);
    // Первая тысяча не должна оказаться в кабинете при заведомо провальной второй.
    expect(transport.calls).toEqual([]);
  });

  it('группа, фразы и объявления доезжают целиком и в правильном виде', async () => {
    const transport = directTransport();
    const writer = writerOf(transport);

    const groups = await writer.createAdGroups(CTX, '777', [
      { name: 'Горячий спрос', regionIds: [225, -213], negativeKeywords: [] },
    ]);
    const ads = await writer.createAds(CTX, [
      {
        adGroupExternalId: groups[0]?.externalId ?? '0',
        title: 'Английский для IT',
        text: 'Разговорный курс.',
        href: 'https://example.com/course',
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(ads).toHaveLength(1);
    expect(sentItems(transport.calls[0], 'AdGroups')[0]).toMatchObject({ RegionIds: [225, -213] });
    expect(sentItems(transport.calls[1], 'Ads')[0]?.['TextAd']).toMatchObject({
      Href: 'https://example.com/course',
      Mobile: 'NO',
    });
  });
});
