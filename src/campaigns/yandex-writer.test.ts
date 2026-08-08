import { beforeEach, describe, expect, it } from 'vitest';

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
