import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { startIngestionMocks, type IngestionMocks } from './support/ingestion-mocks.js';
import {
  createCabinet,
  IDS,
  METRIKA,
  seedIngestionClient,
  TOKENS,
} from './support/ingestion-seed.js';
import type { Cabinet } from './support/ingestion-yandex-mock.js';

import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { syncEntities } from '@/ingestion/index.js';

/**
 * Импорт дерева сущностей кабинета в базу (ТЗ §15).
 *
 * Живого здесь два: наша БД и настоящий HTTP до мока Директа, который отвечает
 * ровно запрошенными полями и режет выдачу постранично. Смысл именно в этом:
 * юнит-тесты загрузки работают поверх адаптера-заглушки, то есть весь путь
 * «TSV/JSON площадки → DTO адаптера → колонка» до сих пор не проверялся ни разу,
 * а оба найденных в проекте блокера жили ровно на таком стыке.
 */

let clientId: string;
let cabinet: Cabinet;
let mocks: IngestionMocks;

function campaigns() {
  return prisma.campaign.findMany({ orderBy: { externalId: 'asc' } });
}

function ads() {
  return prisma.ad.findMany({ orderBy: { externalId: 'asc' } });
}

function keywords() {
  return prisma.keyword.findMany({ orderBy: { externalId: 'asc' } });
}

describe('загрузка: импорт сущностей кабинета', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    cabinet = createCabinet();
    mocks = startIngestionMocks({
      // Страница в два объекта: пагинация Директа обязана отработать по-настоящему,
      // иначе третья группа и четвёртое объявление просто не доехали бы.
      yandex: { accounts: [{ accessToken: TOKENS.primary, cabinet }], pageSize: 2 },
      metrika: { oauthToken: TOKENS.primary, counterId: METRIKA.counterId, rows: [] },
    });

    clientId = await seedIngestionClient({
      name: 'ООО «Кофемолка»',
      tgUserId: 880_000_101n,
      accessToken: TOKENS.primary,
      metrika: METRIKA,
    });
  });

  afterAll(async () => {
    mocks?.close();
    await prisma.$disconnect();
  });

  it('пустая база: заводит кампании, группы, объявления и фразы с верными статусами', async () => {
    const result = await syncEntities(clientId, 'YANDEX_DIRECT');

    expect(result.campaigns).toEqual({ upserted: 2, archived: 0, orphaned: 0 });
    expect(result.adGroups).toEqual({ upserted: 3, archived: 0, orphaned: 0 });
    expect(result.ads).toEqual({ upserted: 4, archived: 0, orphaned: 0, superseded: 0 });
    expect(result.keywords).toEqual({ upserted: 3, archived: 0, orphaned: 0 });

    const [search, network] = await campaigns();
    expect(search).toMatchObject({
      externalId: String(IDS.search),
      name: 'Поиск — Кофемашины',
      status: 'ACTIVE',
      // Стратегия лежит во вложенном `BiddingStrategy.Search`, и подобъект
      // приезжает только вместе с `TextCampaignFieldNames`.
      strategy: 'WB_MAXIMUM_CONVERSION_RATE',
    });
    expect(Number(search?.dailyBudget)).toBe(5000);
    expect(network).toMatchObject({
      externalId: String(IDS.network),
      status: 'PAUSED',
      strategy: 'AUTOBUDGET',
    });
    // Кабинет не назвал дневной лимит: ноль означает «лимита нет», а не «нет данных».
    expect(Number(network?.dailyBudget)).toBe(0);

    const groups = await prisma.adGroup.findMany({ orderBy: { externalId: 'asc' } });
    expect(groups.map((g) => g.externalId)).toEqual([
      String(IDS.groupCore),
      String(IDS.groupTail),
      String(IDS.groupNetwork),
    ]);
    expect(groups[0]?.targetings).toEqual({ regionIds: [213], type: 'TEXT_AD_GROUP' });

    const [core, rejected, tail, networkAd] = await ads();
    expect(core).toMatchObject({
      title: 'Кофемашины с доставкой',
      body: 'Более 200 моделей в наличии',
      format: 'TEXT',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      moderationReason: null,
    });
    // Модерацию несёт `Status`, показы — `State`: отклонённое объявление ещё и выключено.
    expect(rejected).toMatchObject({
      status: 'PAUSED',
      moderationStatus: 'REJECTED',
      moderationReason: 'Превосходная степень без подтверждения',
    });
    expect(tail).toMatchObject({ status: 'ACTIVE', moderationStatus: 'PENDING' });
    expect(networkAd).toMatchObject({ status: 'PAUSED', moderationStatus: 'APPROVED' });

    const [kwCore, kwPaused, kwTail] = await keywords();
    expect(kwCore).toMatchObject({ phrase: 'кофемашина купить', status: 'ACTIVE' });
    expect(Number(kwCore?.bid)).toBe(45.5);
    // Ставки нет вовсе — это null, а не ноль: ноль означал бы «показов не будет».
    expect(kwPaused).toMatchObject({ phrase: 'ремонт кофемашины', status: 'PAUSED', bid: null });
    expect(Number(kwTail?.bid)).toBe(30);

    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('повторный прогон идемпотентен: ни одной новой строки', async () => {
    const before = {
      campaigns: (await campaigns()).map((c) => c.id),
      groups: (await prisma.adGroup.findMany({ orderBy: { externalId: 'asc' } })).map((g) => g.id),
      ads: (await ads()).map((a) => a.id),
      keywords: (await keywords()).map((k) => k.id),
    };

    const result = await syncEntities(clientId, 'YANDEX_DIRECT');
    expect(result.campaigns.archived + result.adGroups.archived + result.keywords.archived).toBe(0);

    expect((await campaigns()).map((c) => c.id)).toEqual(before.campaigns);
    expect(
      (await prisma.adGroup.findMany({ orderBy: { externalId: 'asc' } })).map((g) => g.id),
    ).toEqual(before.groups);
    expect((await ads()).map((a) => a.id)).toEqual(before.ads);
    expect((await keywords()).map((k) => k.id)).toEqual(before.keywords);
  });

  it('изменение в кабинете доезжает до строк на следующем прогоне', async () => {
    // Человек зашёл в кабинет и: остановил поисковую кампанию, поднял ставку,
    // добавил объявление, удалил фразу и всю РСЯ-кампанию.
    const search = cabinet.campaigns.find((c) => c.id === IDS.search);
    if (!search) throw new Error('кампания не найдена в кабинете');
    search.state = 'OFF';
    search.name = 'Поиск — Кофемашины (осень)';

    const keyword = cabinet.keywords.find((k) => k.id === IDS.keywordCore);
    if (!keyword) throw new Error('фраза не найдена в кабинете');
    keyword.bidRub = 52.75;

    cabinet.ads.push({
      id: 98_761_005,
      campaignId: IDS.search,
      adGroupId: IDS.groupCore,
      state: 'ON',
      status: 'MODERATION',
      title: 'Кофемашины в рассрочку',
      text: '0% на 12 месяцев',
    });

    cabinet.keywords = cabinet.keywords.filter((k) => k.id !== IDS.keywordPaused);
    cabinet.campaigns = cabinet.campaigns.filter((c) => c.id !== IDS.network);

    const result = await syncEntities(clientId, 'YANDEX_DIRECT');

    expect(result.campaigns).toMatchObject({ upserted: 1, archived: 1 });
    // Четыре объявления двух оставшихся групп: объявление РСЯ в листинг уже не попало.
    expect(result.ads.upserted).toBe(4);
    expect(result.keywords).toMatchObject({ upserted: 2, archived: 1 });

    const [searchRow, networkRow] = await campaigns();
    expect(searchRow).toMatchObject({ status: 'PAUSED', name: 'Поиск — Кофемашины (осень)' });
    // Пропавшая кампания не удаляется: вместе со строкой ушла бы вся её статистика.
    expect(networkRow).toMatchObject({ status: 'ARCHIVED' });

    const kwCore = (await keywords()).find((k) => k.externalId === String(IDS.keywordCore));
    expect(Number(kwCore?.bid)).toBe(52.75);
    const kwPaused = (await keywords()).find((k) => k.externalId === String(IDS.keywordPaused));
    expect(kwPaused?.status).toBe('ARCHIVED');

    const fresh = (await ads()).find((a) => a.externalId === '98761005');
    expect(fresh).toMatchObject({ title: 'Кофемашины в рассрочку', moderationStatus: 'PENDING' });
    // Объявление архивированной кампании из листинга ушло вместе с ней, но строка
    // осталась: на неё ссылается статистика.
    expect(await prisma.ad.count()).toBe(5);

    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('чужой токен не видит кабинет: отказ приходит в той же форме, что у площадки', async () => {
    const other = await seedIngestionClient({
      name: 'ООО «Чужой»',
      tgUserId: 880_000_109n,
      accessToken: 'e2e-unknown-token',
    });

    await expect(syncEntities(other, 'YANDEX_DIRECT')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    // Кабинет соседа не пострадал.
    expect(await prisma.campaign.count({ where: { clientId: other } })).toBe(0);
  });
});
