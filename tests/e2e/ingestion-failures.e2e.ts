import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { startIngestionMocks, type IngestionMocks } from './support/ingestion-mocks.js';
import {
  createCabinet,
  createSecondaryCabinet,
  IDS,
  METRIKA,
  SECONDARY_IDS,
  seedIngestionClient,
  TOKENS,
} from './support/ingestion-seed.js';

import { bootstrapChannels } from '@/channels/bootstrap.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import { runIngestion, runSearchQueryIngestion } from '@/ingestion/index.js';

/**
 * Отказ кабинета на середине прогона.
 *
 * Проверяется не «упало», а что именно осталось после падения: клиенты обходятся
 * независимо, поэтому протухший токен одного кабинета не имеет права лишить
 * данных все остальные, а половина уже загруженного дерева обязана остаться в
 * базе — иначе следующий прогон начинал бы с нуля каждый раз.
 *
 * Каждый случай получает чистую базу: объяснять провал одного теста настройками
 * другого — верный способ сделать сценарий бесполезным.
 */

let clientId: string;
let plainClientId: string;
let mocks: IngestionMocks;

const FATAL_ERROR = { error_code: 8000, error_string: 'Отсутствует обязательный параметр' };
const TOKEN_REVOKED = { error_code: 53, error_string: 'Ошибка авторизации' };

async function seedBoth(): Promise<void> {
  clientId = await seedIngestionClient({
    name: 'ООО «Кофемолка»',
    tgUserId: 880_000_105n,
    accessToken: TOKENS.primary,
    metrika: METRIKA,
  });
  plainClientId = await seedIngestionClient({
    name: 'ООО «Чайники»',
    tgUserId: 880_000_106n,
    accessToken: TOKENS.secondary,
  });
}

function errorsOf(clientId: string) {
  return prisma.errorLog.findMany({ where: { clientId }, orderBy: { id: 'asc' } });
}

/** Строк статистики уровня кампании у конкретного клиента. */
async function campaignStatCount(clientId: string): Promise<number> {
  const ids = (await prisma.campaign.findMany({ where: { clientId }, select: { id: true } })).map(
    (c) => c.id,
  );
  if (ids.length === 0) return 0;
  return prisma.campaignStat.count({ where: { entityType: 'CAMPAIGN', entityId: { in: ids } } });
}

describe('загрузка: отказ кабинета на середине', () => {
  beforeAll(() => {
    resetYandexRuntimeState();
    bootstrapChannels();
  });

  beforeEach(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    mocks = startIngestionMocks({
      yandex: {
        accounts: [
          { accessToken: TOKENS.primary, cabinet: createCabinet() },
          { accessToken: TOKENS.secondary, cabinet: createSecondaryCabinet() },
        ],
        pageSize: 2,
      },
      metrika: { oauthToken: TOKENS.primary, counterId: METRIKA.counterId, rows: [] },
    });
    await seedBoth();
  });

  afterEach(async () => {
    mocks?.close();
  });

  it('падение на объявлениях: кампании и группы остаются, отказ виден в журнале', async () => {
    // Кабинет отдал кампании и группы, а на объявлениях ответил отказом.
    mocks.yandex.fail({
      service: 'ads',
      method: 'get',
      accessToken: TOKENS.primary,
      error: FATAL_ERROR,
    });

    const summary = await runIngestion();

    expect(summary.targets).toBe(2);
    // Второй клиент прошёл целиком: отказ соседа не стоил ему данных.
    expect(summary.ok).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      clientId,
      provider: 'YANDEX_DIRECT',
      stage: 'entities',
      code: 'YANDEX_API_ERROR',
    });

    // Уже загруженное — в базе: следующий прогон продолжит, а не начнёт заново.
    expect(await prisma.campaign.count({ where: { clientId } })).toBe(2);
    expect(await prisma.adGroup.count({ where: { campaign: { clientId } } })).toBe(3);
    expect(await prisma.ad.count({ where: { adGroup: { campaign: { clientId } } } })).toBe(0);
    expect(await prisma.keyword.count({ where: { adGroup: { campaign: { clientId } } } })).toBe(0);

    const errors = await errorsOf(clientId);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      scope: 'ingestion:entities',
      code: 'YANDEX_API_ERROR',
      context: { stage: 'entities' },
    });
    expect(errors[0]?.message).toContain('8000');

    // Отказ не смертельный: статистика по уже известным кампаниям и группам
    // всё равно загружена, а уровней ad/keyword просто нет — привязывать не к чему.
    expect(await campaignStatCount(clientId)).toBeGreaterThan(0);
    const adStats = await prisma.campaignStat.findMany({
      where: { entityType: 'AD' },
      select: { entityId: true },
    });
    const foreignAds = await prisma.ad.findMany({
      where: { id: { in: adStats.map((s) => s.entityId) } },
      select: { adGroup: { select: { campaign: { select: { clientId: true } } } } },
    });
    expect(foreignAds.every((a) => a.adGroup.campaign.clientId === plainClientId)).toBe(true);

    // Соседний кабинет загружен целиком.
    expect(await prisma.campaign.count({ where: { clientId: plainClientId } })).toBe(1);
    expect(await errorsOf(plainClientId)).toHaveLength(0);
  });

  it('протухший токен обрывает все шаги кабинета, а не только упавший', async () => {
    mocks.yandex.fail({ service: 'campaigns', accessToken: TOKENS.primary, error: TOKEN_REVOKED });

    const summary = await runIngestion();

    expect(summary.ok).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ stage: 'entities', code: 'AUTH_FAILED' });

    // Ровно одна запись в журнале: нерабочий токен не починится к следующему шагу,
    // и остальные этапы залили бы `ErrorLog` копиями той же ошибки.
    expect(await errorsOf(clientId)).toHaveLength(1);
    // Отчёты за этот кабинет не заказывались вовсе — баллы и слоты не потрачены.
    const reportsForBroken = mocks.yandex.reportRequests.filter(
      (r) => r.headers['authorization'] === `Bearer ${TOKENS.primary}`,
    );
    expect(reportsForBroken).toHaveLength(0);
    // И до Метрики дело не дошло: у клиента счётчик настроен, то есть запрос
    // ушёл бы обязательно, продолжись прогон после отказа авторизации.
    expect(mocks.metrika.requests).toHaveLength(0);
    expect(await prisma.campaign.count({ where: { clientId } })).toBe(0);

    // Второй кабинет доехал и до сущностей, и до статистики.
    expect(await prisma.campaign.count({ where: { clientId: plainClientId } })).toBe(1);
    expect(await campaignStatCount(plainClientId)).toBeGreaterThan(0);
  });

  it('отказ сервиса отчётов оставляет сущности и не мешает конверсиям', async () => {
    mocks.yandex.fail({
      service: 'reports',
      method: 'AD_PERFORMANCE_REPORT',
      accessToken: TOKENS.primary,
      error: { error_code: 8000, error_string: 'Неверный набор полей отчёта' },
    });

    const summary = await runIngestion({ clientId });

    expect(summary.targets).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ stage: 'stats' });

    // Дерево сущностей загружено целиком — отказ отчёта его не отменяет.
    expect(await prisma.campaign.count({ where: { clientId } })).toBe(2);
    expect(await prisma.keyword.count({ where: { adGroup: { campaign: { clientId } } } })).toBe(3);
    // Первый отчёт (по кампаниям) успел записаться до отказа на уровне групп.
    expect(await campaignStatCount(clientId)).toBeGreaterThan(0);
    expect(await prisma.campaignStat.count({ where: { entityType: 'ADGROUP' } })).toBe(0);

    const errors = await errorsOf(clientId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.scope).toBe('ingestion:stats');
  });

  it('отказ отчёта по запросам не трогает уже помеченные минус-фразы', async () => {
    await runIngestion({ clientId });
    await runSearchQueryIngestion({ clientId });

    const core = await prisma.adGroup.findFirstOrThrow({
      where: { externalId: String(IDS.groupCore) },
    });
    const junk = 'кофемашина обои на рабочий стол';
    const marked = await prisma.searchQueryStat.updateMany({
      where: { adGroupId: core.id, query: junk },
      data: { negated: true },
    });
    expect(marked.count).toBeGreaterThan(0);

    mocks.yandex.fail({
      service: 'reports',
      method: 'SEARCH_QUERY_PERFORMANCE_REPORT',
      accessToken: TOKENS.primary,
      error: { error_code: 1000, error_string: 'Внутренняя ошибка сервера' },
    });

    const summary = await runSearchQueryIngestion();

    // Второй кабинет отчёт по запросам не имеет вовсе — для него это не отказ.
    expect(summary.targets).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failures[0]).toMatchObject({ clientId, stage: 'search-queries' });

    const rows = await prisma.searchQueryStat.findMany({
      where: { adGroupId: core.id, query: junk },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.negated)).toBe(true);
  });

  it('кабинет второго клиента загружается целиком, даже когда первый молчит', async () => {
    mocks.yandex.fail({ service: 'campaigns', accessToken: TOKENS.primary, error: TOKEN_REVOKED });

    await runIngestion();

    const campaign = await prisma.campaign.findFirstOrThrow({
      where: { externalId: String(SECONDARY_IDS.campaign) },
    });
    expect(campaign.clientId).toBe(plainClientId);
    expect(await prisma.campaignStat.count({ where: { entityId: campaign.id } })).toBeGreaterThan(
      0,
    );
  });
});
