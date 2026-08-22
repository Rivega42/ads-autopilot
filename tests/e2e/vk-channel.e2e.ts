import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';
import { createVkApiMock, type VkApiMock } from './support/vk-api-mock.js';
import {
  collectEscalations,
  createVkCabinet,
  seedVkAccount,
  stubModel,
  VK_APP,
  VK_IDS,
  VK_RANGE,
  VK_TARGET_CPA_RUB,
  vkRunAt,
  type EscalationCollector,
  type VkFixture,
} from './support/vk-seed.js';

import { applyApproval, createApproval, setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { buildContext } from '@/channels/registry.js';
import { vkAdsAdapter } from '@/clients/vk-ads/adapter.js';
import { clearVkTokenCache } from '@/clients/vk-ads/auth.js';
import { prisma } from '@/db/prisma.js';
import { runIngestion } from '@/ingestion/index.js';
import { runModerationCheck } from '@/moderation/run.js';
import { runScheduledOptimization } from '@/optimizer/index.js';
import { createPlatformWriter } from '@/optimizer/runtime.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

/**
 * Сквозной прогон канала VK на живом Postgres.
 *
 * Отличие от сценария Директа не в списке шагов, а в моке: он ведёт себя как
 * протокол. Токен обязателен на каждом запросе, фильтры `_id__in` / `_status__in`
 * реально применяются, отсутствующий обязательный параметр — это 400, а не пустой
 * ответ. Ровно на такой строгости у Директа нашлась несостыковка между тем, что
 * адаптер просит, и тем, что схема разбирает; здесь проверяется то же самое для VK,
 * где 23 места клиента помечены `@needs-live-token`.
 *
 * Наружу не уходит ничего: весь HTTP площадки перехвачен msw с
 * `onUnhandledRequest: 'error'`, транспорт Telegram подменён, модель заглушена.
 *
 * Кабинет — источник истины: строки в БД заводит загрузка, а не фикстура. Поэтому
 * «оптимизатор поставил паузу» проверяется по состоянию кабинета, а не по нашей же
 * записи о том, что мы её поставили.
 */

/** Сущностей в кабинете: 1 план + 2 группы + 5 баннеров. */
const ENTITIES_IN_CABINET = 8;
/** Строк статистики: 7 (план) + 14 (группы) + 30 (баннеры). */
const STAT_ROWS = 51;

let fx: VkFixture;
let vk: VkApiMock;
let telegram: TelegramMock;
let escalations: EscalationCollector;

const model = stubModel({
  title: 'Мамонты с доставкой',
  text: 'Привезём мамонта за сутки. Гарантия два года, установка входит в цену.',
});

function ingest(): ReturnType<typeof runIngestion> {
  return runIngestion({ range: VK_RANGE, now: () => vkRunAt(0) });
}

function vkContext(): ReturnType<typeof buildContext> {
  return buildContext(fx.clientId, 'VK_ADS');
}

describe('канал VK: кабинет → база → решения → кабинет', () => {
  beforeAll(async () => {
    await resetDatabase();
    clearVkTokenCache();
    bootstrapChannels();

    vk = createVkApiMock({ app: VK_APP, cabinet: createVkCabinet() });
    // 'error' обязателен: без него незамоканный запрос ушёл бы в настоящий ads.vk.ru,
    // а промах мимо описанного протокола выглядел бы как тишина.
    vk.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);
    escalations = collectEscalations();

    fx = await seedVkAccount();
  });

  afterAll(async () => {
    vk?.server.close();
    setMessenger(null);
    clearVkTokenCache();
    await prisma.$disconnect();
  });

  it('загрузка заводит кампанию, группы и объявления по данным кабинета', async () => {
    const summary = await ingest();

    expect(summary).toMatchObject({
      targets: 1,
      ok: 1,
      entitiesUpserted: ENTITIES_IN_CABINET,
      entitiesArchived: 0,
      statsWritten: STAT_ROWS,
      // Метрика знает только про клики Директа — для VK шага нет вовсе.
      conversionsWritten: 0,
    });
    expect(summary.failures).toEqual([]);

    // Токен выпущен один раз на все запросы прогона и сохранён в кабинет клиента.
    expect(vk.minted).toBe(1);
    expect(vk.callsTo('oauth2/token.json')).toHaveLength(1);
    const stored = (await new CredentialRepository().getPayload(fx.clientId, 'VK_ADS')) as Record<
      string,
      unknown
    >;
    expect(stored['accessToken']).toBe('vk-token-1');
    expect(typeof stored['expiresAt']).toBe('string');

    // Ни одного запроса к API без Bearer: 401 в сценарии быть не должно.
    const api = vk.calls.filter((c) => !c.path.startsWith('oauth2/'));
    expect(api.every((c) => c.token === 'vk-token-1')).toBe(true);
    expect(api.some((c) => c.status === 401)).toBe(false);

    const campaign = await prisma.campaign.findFirstOrThrow({ where: { provider: 'VK_ADS' } });
    expect(campaign).toMatchObject({
      externalId: String(VK_IDS.plan),
      name: 'Мамонты — сайт',
      status: 'ACTIVE',
      /**
       * Было сломано: адаптер кладёт в `RemoteCampaign.strategy` ключи
       * `autobiddingMode` / `maxPrice` / `budgetLimit`, а `strategyName`
       * (`src/ingestion/mapping.ts`) искал только `BiddingStrategyType` / `type` /
       * `name` — и не находил ни одного. У всех кампаний VK колонка `strategy`
       * оставалась null, хотя кабинет прислал `max_goals`.
       */
      strategy: 'max_goals',
    });
    expect(Number(campaign.dailyBudget)).toBe(5000);

    const groups = await prisma.adGroup.findMany({ orderBy: { externalId: 'asc' } });
    expect(groups.map((g) => g.externalId)).toEqual([
      String(VK_IDS.groupMoscow),
      String(VK_IDS.groupRegions),
    ]);
    expect(groups[0]?.targetings).toEqual({ geo: [1], interests: ['pets'] });

    // Ставка приехала с уровня группы — у VK она живёт там, а не на фразе.
    // До колонки `AdGroup.bid` цену кабинета класть было некуда вовсе.
    expect(groups.map((g) => Number(g.bid))).toEqual([120, 90]);

    // Тексты приехали из `textblocks`, а не из имени баннера.
    const ads = await prisma.ad.findMany({ orderBy: { externalId: 'asc' } });
    expect(ads).toHaveLength(5);
    expect(ads[0]).toMatchObject({
      externalId: String(VK_IDS.bannerLoser),
      title: 'Мамонты оптом',
      body: 'Отгрузим мамонта со склада',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
    });
    const rejected = ads.find((a) => a.externalId === String(VK_IDS.bannerRejected));
    expect(rejected).toMatchObject({
      moderationStatus: 'REJECTED',
      moderationReason: 'Превосходная степень без подтверждения: «самые лучшие»',
    });

    // Ключевых слов у VK нет вовсе — ни одной строки и ни одного запроса.
    expect(await prisma.keyword.count()).toBe(0);
    expect(vk.calls.some((c) => c.path.includes('keyword'))).toBe(false);

    // Деньги площадка отдала строкой ("90.00") — в базе они обязаны стать числом.
    const loserStats = await prisma.campaignStat.findMany({
      where: { entityType: 'AD', entityId: (ads[0] as { id: string }).id },
    });
    expect(loserStats).toHaveLength(7);
    expect(Number(loserStats[0]?.spend)).toBe(90);
    expect(loserStats[0]?.impressions).toBe(120);
  });

  it('повторная загрузка идемпотентна: те же строки, а не вторые', async () => {
    const before = vk.calls.length;
    const summary = await ingest();

    expect(summary).toMatchObject({
      entitiesUpserted: ENTITIES_IN_CABINET,
      entitiesArchived: 0,
      statsWritten: STAT_ROWS,
    });
    expect(summary.failures).toEqual([]);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.adGroup.count()).toBe(2);
    expect(await prisma.ad.count()).toBe(5);
    expect(await prisma.campaignStat.count()).toBe(STAT_ROWS);

    // Токен взят из кеша процесса: второй минт съел бы слот из пяти доступных.
    expect(vk.minted).toBe(1);
    expect(vk.calls.length).toBeGreaterThan(before);
  });

  it('dry-run считает решения, но в кабинет не пишет', async () => {
    const writesBefore = vk.calls.filter((c) => c.method !== 'GET').length;

    const summary = await runScheduledOptimization({ dryRun: true, now: vkRunAt(0) });

    expect(summary).toMatchObject({
      campaigns: 1,
      autoApply: 0,
      // Пауза проигравшего баннера и подъём ставки группы: с появлением правил на
      // уровне группы у VK стало чем управлять, и решений теперь два, а не одно.
      plannedOnly: 2,
      noop: 0,
      applyFailed: 0,
      // Кампания заведена загрузкой, режим по умолчанию FULL — человека не зовём.
      approvals: 0,
      // Тот же диагноз, но история двое суток: предохранитель MIN_OBSERVATIONS.
      // Второй отказ — вторая группа упирается в потолок доли изменённых сущностей.
      rejected: 2,
      clamped: 0,
      // Цель по CPA доехала из брифа: своей у импортированной кампании нет.
      noTargetCpa: 0,
      failed: 0,
    });
    expect(summary.skipped).toEqual({});

    expect(vk.calls.filter((c) => c.method !== 'GET')).toHaveLength(writesBefore);
    expect(await prisma.changeLog.count()).toBe(0);
    expect(vk.bannerById(VK_IDS.bannerLoser)?.status).toBe('active');
  });

  it('боевой цикл ставит объявление на паузу в самом кабинете', async () => {
    const summary = await runScheduledOptimization({ dryRun: false, now: vkRunAt(0) });

    expect(summary).toMatchObject({
      campaigns: 1,
      // Пауза баннера и подъём ставки группы — оба доезжают до кабинета.
      autoApply: 2,
      plannedOnly: 0,
      noop: 0,
      applyFailed: 0,
      rejected: 2,
      failed: 0,
    });

    const loser = await prisma.ad.findFirstOrThrow({
      where: { externalId: String(VK_IDS.bannerLoser) },
    });
    const change = await prisma.changeLog.findFirstOrThrow({ where: { entityId: loser.id } });
    expect(change).toMatchObject({ action: 'PAUSE', entityType: 'AD', actor: 'AI' });
    expect(change.newValue).toEqual({ kind: 'status', status: 'PAUSED' });

    // Главное: пауза доехала до площадки, а не осталась записью в журнале.
    const write = vk.callsTo('banners/mass_action.json').at(-1);
    expect(write?.body).toEqual([{ id: VK_IDS.bannerLoser, status: 'blocked' }]);
    expect(vk.bannerById(VK_IDS.bannerLoser)?.status).toBe('blocked');

    // Соседние баннеры не тронуты — в том числе тот, что отклонён предохранителем.
    expect(vk.bannerById(VK_IDS.bannerOk)?.status).toBe('active');
    expect(vk.bannerById(VK_IDS.bannerFresh)?.status).toBe('active');
    expect(await prisma.errorLog.count()).toBe(0);
  });

  it('повтор в те же сутки не пишет в кабинет второй раз', async () => {
    const pausesBefore = vk.callsTo('banners/mass_action.json').length;

    const summary = await runScheduledOptimization({ dryRun: false, now: vkRunAt(0) });

    // Повторённое решение отсекается ключом идемпотентности, но прогон не пустой:
    // баннер уже погашен и на паузу больше не предлагается, поэтому потолок доли
    // изменённых сущностей освобождается — и вторая группа доезжает со своим
    // подъёмом ставки. Это не двойная запись: сущность другая, ключ другой.
    expect(summary).toMatchObject({ autoApply: 1, plannedOnly: 0, noop: 0, applyFailed: 0 });
    // Суть теста цела: повторённое решение в кабинет не уходит. Проверяем это по
    // тому каналу, которым оно уходило бы, — а не по общему счётчику записей,
    // который теперь двигает решение по другой сущности.
    expect(vk.callsTo('banners/mass_action.json')).toHaveLength(pausesBefore);
    expect(await prisma.changeLog.count()).toBe(3);
  });

  it('минус-слов у VK нет: решение не уходит в сеть, а честно помечается пропущенным', async () => {
    // Проверка по коду, а не по аналогии с Директом: показы покупаются аудиториями,
    // отчёта по поисковым запросам у площадки нет, поэтому и минус-слов нет.
    expect(vkAdsAdapter.addNegativeKeywords).toBeUndefined();
    expect(vkAdsAdapter.getSearchQueries).toBeUndefined();

    const group = await prisma.adGroup.findFirstOrThrow({
      where: { externalId: String(VK_IDS.groupMoscow) },
    });
    const callsBefore = vk.calls.length;

    const result = await createPlatformWriter()({
      entityType: 'ADGROUP',
      entityId: group.id,
      action: 'ADD_NEGATIVE_KEYWORD',
      prevValue: { kind: 'status', status: 'ACTIVE' },
      nextValue: { kind: 'negativeKeyword', phrase: 'мамонт бесплатно' },
      idempotencyKey: 'e2e-negative',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'канал не поддерживает минус-слова' });
    expect(vk.calls).toHaveLength(callsBefore);
  });

  it('одобренная карточка ставит на паузу группу — уровень, до которого правила не доходят', async () => {
    const approval = await createApproval({
      kind: 'pause_entities',
      clientId: fx.clientId,
      channel: 'VK_ADS',
      reason: 'Группа перестала окупаться',
      level: 'adgroup',
      externalIds: [String(VK_IDS.groupRegions)],
    });
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { decision: 'APPROVED', decidedAt: new Date(), respondedBy: 'roman' },
    });

    const outcome = await applyApproval(approval.id, 'roman');

    expect(outcome).toEqual({ status: 'APPLIED', dryRun: false });
    expect(vk.callsTo('ad_groups/mass_action.json').at(-1)?.body).toEqual([
      { id: VK_IDS.groupRegions, status: 'blocked' },
    ]);
    expect(vk.adGroupById(VK_IDS.groupRegions)?.status).toBe('blocked');
    expect(vk.adGroupById(VK_IDS.groupMoscow)?.status).toBe('active');
  });

  it('одобренная карточка меняет ставку — у VK это max_price группы', async () => {
    const approval = await createApproval({
      kind: 'bid_change',
      clientId: fx.clientId,
      channel: 'VK_ADS',
      reason: 'CPA ниже цели, добираем объём',
      // У VK нет ключевых слов: адаптер трактует `keywordExternalId` как id группы.
      changes: [{ keywordExternalId: String(VK_IDS.groupMoscow), bid: 149.999, bidBefore: 120 }],
    });
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { decision: 'APPROVED', decidedAt: new Date(), respondedBy: 'roman' },
    });

    const regionsBidBefore = Number(
      (
        await prisma.adGroup.findFirstOrThrow({
          where: { externalId: String(VK_IDS.groupRegions) },
        })
      ).bid,
    );

    const outcome = await applyApproval(approval.id, 'roman');

    /**
     * Было сломано: ставку VK класть было некуда. `syncLocalEntities`
     * (`src/approval/local-state.ts`) умел писать её только в `Keyword.bid`, а фраз у
     * VK ноль — `updateMany` находил ноль строк, и на каждой ставке приходило
     * «обновлено частично (0 из 1)»: не сигнал о поломке, а постоянный фон.
     * Теперь ставка живёт в `AdGroup.bid`, и примечания быть не должно вовсе.
     */
    expect(outcome).toEqual({ status: 'APPLIED', dryRun: false });
    // Квантование до копеек — иначе в кабинете висело бы 149.99900000000002.
    expect(vk.callsTo('ad_groups/mass_action.json').at(-1)?.body).toEqual([
      { id: VK_IDS.groupMoscow, max_price: 150 },
    ]);
    expect(vk.adGroupById(VK_IDS.groupMoscow)?.max_price).toBe('150.00');
    expect(vk.adGroupById(VK_IDS.groupMoscow)?.status).toBe('active');

    // Главное: наша строка обновлена сразу, а не ждёт ближайшего синка. Пока она
    // отстаёт, следующий прогон считает от прежней цены и предлагает то же самое.
    const moscow = await prisma.adGroup.findFirstOrThrow({
      where: { externalId: String(VK_IDS.groupMoscow) },
    });
    expect(Number(moscow.bid)).toBe(150);

    // Соседняя группа не тронута: id уникален в кабинете, но не в нашей таблице.
    // Сверяем со снимком до применения, а не с числом: ставку этой группы двигает
    // оптимизатор в тестах выше, и зашитая константа проверяла бы не то, что
    // обещает подпись, — она зеленела бы по постороннему поводу.
    const regions = await prisma.adGroup.findFirstOrThrow({
      where: { externalId: String(VK_IDS.groupRegions) },
    });
    expect(Number(regions.bid)).toBe(regionsBidBefore);
  });

  it('одобренная карточка меняет дневной бюджет, сверив его с живым значением', async () => {
    const approval = await createApproval({
      kind: 'budget_change',
      clientId: fx.clientId,
      channel: 'VK_ADS',
      reason: 'Бюджет выбирается полностью',
      campaignExternalId: String(VK_IDS.plan),
      campaignName: 'Мамонты — сайт',
      before: 5000,
      after: 5500,
    });
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { decision: 'APPROVED', decidedAt: new Date(), respondedBy: 'roman' },
    });

    const outcome = await applyApproval(approval.id, 'roman');

    expect(outcome).toEqual({ status: 'APPLIED', dryRun: false });
    // Предусловие читает бюджет из кабинета: без `budget_limit_day` в ответе оно
    // молча пропустилось бы, и карточка применилась бы поверх чужой правки.
    expect(vk.callsTo('ad_plans.json').at(-1)?.status).toBe(200);
    expect(vk.adPlanById(VK_IDS.plan)?.budget_limit_day).toBe('5500.00');
  });

  it('переписывание текста: новый баннер создан, старый удалён, строка переехала', async () => {
    const before = await prisma.ad.findFirstOrThrow({
      where: { externalId: String(VK_IDS.bannerRejected) },
    });
    vk.reset();

    const summary = await runModerationCheck({
      runClassify: model.classify,
      runRewrite: model.rewrite,
      escalate: escalations.sink,
      now: () => vkRunAt(0),
    });

    expect(summary).toMatchObject({
      targets: 1,
      ok: 1,
      rejected: 1,
      rewritten: 1,
      escalated: 0,
      missing: 0,
      planned: 0,
    });
    expect(summary.failures).toEqual([]);
    expect(escalations.sent).toEqual([]);

    // Порядок обязателен: сначала читаем баннер, потом создаём замену и только
    // потом удаляем старый. Обратный порядок оставил бы группу без объявления.
    const bannerCalls = vk.calls.filter((c) => c.path.startsWith('banners'));
    expect(bannerCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      // опрос модерации: листинг по группам
      'GET banners.json',
      // адаптер перечитывает баннер, который собирается пересоздать
      'GET banners.json',
      'POST banners.json',
      `DELETE banners/${VK_IDS.bannerRejected}.json`,
    ]);
    expect(bannerCalls[1]?.query['_id__in']).toBe(String(VK_IDS.bannerRejected));

    const created = vk.cabinet.banners.find((b) => b.id > VK_IDS.bannerNeutral);
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      ad_group_id: VK_IDS.groupRegions,
      status: 'active',
      // Медиа и ссылки переносятся: пересоздание меняет только тексты.
      urls: { primary: { url: 'https://mamont.example' } },
      content: { image_1080x607: { id: 555 } },
    });
    expect(created?.textblocks).toEqual({
      title_25: { text: 'Мамонты с доставкой' },
      text_90: {
        text: 'Привезём мамонта за сутки. Гарантия два года, установка входит в цену.',
      },
    });

    // Старый баннер именно удалён, а не выключен.
    expect(vk.bannerById(VK_IDS.bannerRejected)?.status).toBe('deleted');

    // Строка обязана переехать на новый id: со старым она выпадет из статистики,
    // из опроса модерации и из любой будущей паузы.
    const after = await prisma.ad.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.externalId).toBe(String(created?.id));
    expect(after).toMatchObject({
      title: 'Мамонты с доставкой',
      moderationStatus: 'PENDING',
      moderationReason: null,
      moderationRetries: 1,
    });

    const rewrite = await prisma.changeLog.findFirstOrThrow({
      where: { action: 'moderation_rewrite', entityId: before.id },
    });
    expect(rewrite.newValue).toMatchObject({
      externalIdBefore: String(VK_IDS.bannerRejected),
      externalIdAfter: String(created?.id),
    });
  });

  it('следующая загрузка видит замену и не заводит двойника', async () => {
    const summary = await ingest();

    expect(summary.failures).toEqual([]);
    // Удалённый баннер выпал из листинга (`_status__in` не включает deleted),
    // поэтому объявлений по-прежнему пять, а не шесть.
    expect(await prisma.ad.count()).toBe(5);
    expect(await prisma.ad.count({ where: { externalId: String(VK_IDS.bannerRejected) } })).toBe(0);

    const replaced = await prisma.ad.findFirstOrThrow({ where: { title: 'Мамонты с доставкой' } });
    // Новый баннер уехал на модерацию — кабинет так и сказал.
    expect(replaced.moderationStatus).toBe('PENDING');
    expect(replaced.status).toBe('ACTIVE');

    // Пауза, поставленная оптимизатором, доехала обратно в базу.
    const loser = await prisma.ad.findFirstOrThrow({
      where: { externalId: String(VK_IDS.bannerLoser) },
    });
    expect(loser.status).toBe('PAUSED');

    // Группа, выключенная человеком, тоже.
    const group = await prisma.adGroup.findFirstOrThrow({
      where: { externalId: String(VK_IDS.groupRegions) },
    });
    expect(group.status).toBe('PAUSED');

    // Ставка, применённая карточкой, читается обратно тем же числом. Проверка не
    // про идемпотентность: она ловит расхождение поля записи и поля чтения — если
    // загрузка берёт цену не из того же `max_price`, куда пишет `setBids`, здесь
    // вернулись бы прежние 120 при живых 150 в кабинете.
    const moscow = await prisma.adGroup.findFirstOrThrow({
      where: { externalId: String(VK_IDS.groupMoscow) },
    });
    expect(Number(moscow.bid)).toBe(150);
    expect(vk.adGroupById(VK_IDS.groupMoscow)?.max_price).toBe('150.00');
  });

  it('целевой CPA брифа — единственный источник цели для кампании из кабинета', async () => {
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { provider: 'VK_ADS' } });
    expect(campaign.targetCpa).toBeNull();
    const brief = await prisma.clientBrief.findUniqueOrThrow({ where: { clientId: fx.clientId } });
    expect(brief.data).toMatchObject({ targetCpaRub: VK_TARGET_CPA_RUB });

    // Контекст канала собирается из зашифрованных кредов — проверяем, что кабинет
    // доступен именно через них, а не через переменные окружения.
    const ctx = await vkContext();
    expect(ctx.dryRun).toBe(false);
    await expect(vkAdsAdapter.verifyAccess(ctx)).resolves.toMatchObject({ ok: true });
  });
});
