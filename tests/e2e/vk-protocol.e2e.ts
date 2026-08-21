import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { createVkApiMock, type VkApiMock, type VkApiMockOptions } from './support/vk-api-mock.js';
import { createVkCabinet, seedVkAccount, VK_APP, VK_IDS, VK_RANGE } from './support/vk-seed.js';

import { bootstrapChannels } from '@/channels/bootstrap.js';
import { buildContext } from '@/channels/registry.js';
import type { ChannelContext } from '@/channels/types.js';
import { VkAdsAdapter } from '@/clients/vk-ads/adapter.js';
import { clearVkTokenCache } from '@/clients/vk-ads/auth.js';
import { prisma } from '@/db/prisma.js';
import { CredentialRepository } from '@/repos/CredentialRepository.js';

/**
 * Поведение канала VK на краях протокола.
 *
 * Отдельный файл от `vk-channel.e2e.ts`, потому что каждый случай требует своего
 * кабинета: пятый занятый токен, протухший Bearer, 429 с `Retry-After`, страница
 * меньше запрошенной, урезанный набор полей, id строкой. Строить их поверх общего
 * состояния — значит объяснять провал одного теста настройками другого.
 *
 * Часть проверок фиксирует не желаемое, а то, что есть: это места, где наши
 * предположения о ads.vk.ru расходятся между собой (23 пометки `@needs-live-token`
 * в клиенте VK). Такие тесты помечены словом ДЕФЕКТ — если предположение поправят,
 * тест обязан покраснеть и обновиться вместе с починкой.
 */

let clientId: string;
let vk: VkApiMock;
/**
 * Свой адаптер на каждый случай.
 *
 * Не общий экземпляр из реестра: он кеширует HTTP-клиента вместе с контекстом
 * первого вызова (см. отдельный тест ниже), и соседний кабинет получал бы чужой
 * токен — провал одного теста пришлось бы объяснять настройками другого.
 */
let adapter: VkAdsAdapter;

/** Креды кабинета без access-токена: каждый прогон обязан сходить за ним сам. */
async function resetCredentials(extra: Record<string, unknown> = {}): Promise<void> {
  await new CredentialRepository().save(clientId, 'VK_ADS', {
    clientId: VK_APP.clientId,
    clientSecret: VK_APP.clientSecret,
    ...extra,
  });
}

function startMock(options: Partial<VkApiMockOptions> = {}): VkApiMock {
  vk = createVkApiMock({ app: VK_APP, cabinet: createVkCabinet(), ...options });
  vk.server.listen({ onUnhandledRequest: 'error' });
  return vk;
}

function ctx(): Promise<ChannelContext> {
  return buildContext(clientId, 'VK_ADS');
}

const groupIds = [String(VK_IDS.groupMoscow), String(VK_IDS.groupRegions)];

describe('VK: края протокола', () => {
  beforeAll(async () => {
    await resetDatabase();
    bootstrapChannels();
    ({ clientId } = await seedVkAccount());
  });

  beforeEach(async () => {
    clearVkTokenCache();
    adapter = new VkAdsAdapter();
    await resetCredentials();
  });

  afterEach(() => {
    vk?.server.close();
  });

  it('исчерпанный лимит из пяти токенов: освобождаем слоты и минтим заново', async () => {
    // Пять токенов уже заняты — прошлыми деплоями, ботом, соседним воркером.
    startMock({ preexistingTokens: 5 });

    const campaigns = await adapter.listCampaigns(await ctx());

    expect(campaigns).toHaveLength(1);
    // Порядок обязателен: 403 про потолок → снос всех токенов пользователя → повтор.
    expect(
      vk.calls.filter((c) => c.path.startsWith('oauth2/')).map((c) => `${c.path} ${c.status}`),
    ).toEqual(['oauth2/token.json 403', 'oauth2/token/delete.json 200', 'oauth2/token.json 200']);
    expect(vk.minted).toBe(1);
    expect([...vk.liveTokens]).toEqual(['vk-token-1']);
  });

  it('протухший токен из базы: один 401, один минт, один повтор', async () => {
    startMock();
    // Токен в кредах ещё «свежий» по нашим часам, но кабинет его уже не знает.
    await resetCredentials({
      accessToken: 'vk-token-stale',
      expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    });

    const campaigns = await adapter.listCampaigns(await ctx());

    expect(campaigns).toHaveLength(1);
    expect(vk.calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toEqual([
      'GET ad_plans.json 401',
      // Старый токен гасим до выпуска нового: шестой не выдаётся вовсе.
      'POST oauth2/token/delete.json 200',
      'POST oauth2/token.json 200',
      'GET ad_plans.json 200',
    ]);
    expect(vk.calls[0]?.token).toBe('vk-token-stale');
    expect(vk.calls.at(-1)?.token).toBe('vk-token-1');
    // Второго 401 быть не должно: повторный forceRefresh снёс бы только что выпущенный токен.
    expect(vk.calls.filter((c) => c.status === 401)).toHaveLength(1);
  });

  it('ДЕФЕКТ: адаптер держит контекст первого вызова и игнорирует новые креды', async () => {
    /**
     * `createVkHttpClient(ctx, ...)` замыкает `getAccessToken` на тот `ChannelContext`,
     * с которым клиента создали, а `VkAdsAdapter` кеширует клиента по кабинету
     * (`cabinetKey` = клиент + реквизиты приложения). Токен в ключ не входит, поэтому
     * заменённые в БД креды тем же приложением до площадки не доедут: живущий сутками
     * воркер продолжит слать старый токен.
     *
     * Само по себе это чинится 401 → forceRefresh, но ценой лишнего минта — а их
     * одновременно всего пять на пару (client_id, user). Если токен заменили именно
     * потому, что старый отозвали, лишний минт съест слот на ровном месте.
     */
    startMock();
    await adapter.listCampaigns(await ctx());
    expect(vk.calls.at(-1)?.token).toBe('vk-token-1');

    // Другой процесс (или человек) положил в кабинет клиента другой рабочий токен.
    vk.liveTokens.add('vk-token-external');
    await resetCredentials({
      accessToken: 'vk-token-external',
      expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
    });
    clearVkTokenCache();

    await adapter.listCampaigns(await ctx());

    // Запрос ушёл со старым токеном: свежий контекст кешированный клиент не увидел.
    expect(vk.calls.at(-1)?.token).toBe('vk-token-1');
    expect(vk.calls.some((c) => c.token === 'vk-token-external')).toBe(false);
  });

  it('429 с Retry-After: ждём столько, сколько сказала площадка, и повторяем', async () => {
    startMock();
    vk.program({
      path: 'ad_plans.json',
      method: 'GET',
      status: 429,
      body: { error: { code: 'rate_limit', message: 'Too many requests' } },
      headers: { 'retry-after': '1' },
    });

    const started = Date.now();
    const campaigns = await adapter.listCampaigns(await ctx());

    expect(campaigns).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(vk.callsTo('ad_plans.json').map((c) => c.status)).toEqual([429, 200]);
  });

  it('страница меньше запрошенной: пагинация доходит до конца и не дублирует', async () => {
    // Площадка вправе отдать меньше, чем просили в `limit`; наш обход обязан
    // считать смещение по фактически полученным объектам, а не по запрошенным.
    startMock({ pageCap: 2 });

    const ads = await adapter.listAds(await ctx(), []);

    expect(ads.map((a) => a.externalId).sort()).toEqual(['920', '921', '922', '923', '924'].sort());
    const pages = vk.callsTo('banners.json');
    expect(pages.map((p) => p.query['offset'])).toEqual(['0', '2', '4']);
    expect(pages.every((p) => p.query['limit'] === '200')).toBe(true);
  });

  it('статистика уходит батчем и с обязательными параметрами', async () => {
    startMock();

    const rows = await adapter.getStats(await ctx(), 'adgroup', VK_RANGE);

    expect(rows).toHaveLength(14);
    const stats = vk.callsTo('statistics/');
    expect(stats).toHaveLength(1);
    /**
     * @needs-live-token: ТЗ §2.2 документирует поштучный путь
     * `/statistics/{object_type}/{id}/{granularity}.json`, а мы шлём батчевый
     * `/statistics/{object_type}/{granularity}.json?id=1,2`. Мок принимает оба, живой
     * кабинет — неизвестно; на моках это предположение неподтверждаемо в принципе.
     */
    expect(stats[0]?.path).toBe('statistics/ad_groups/day.json');
    expect(stats[0]?.query).toMatchObject({
      id: `${VK_IDS.groupMoscow},${VK_IDS.groupRegions}`,
      date_from: VK_RANGE.from,
      date_to: VK_RANGE.to,
      metrics: 'base',
    });
    // Деньги пришли строкой, метрики — числами: маппер обязан свести всё к числу.
    expect(rows[0]).toMatchObject({ spend: 400, impressions: 3000, conversions: 1 });
  });

  it('ДЕФЕКТ: баннер в статусе rejected не виден ни листингу, ни пересозданию', async () => {
    /**
     * ТЗ §2.2: «Статусы баннеров: active, deleted, blocked, pending_moderation,
     * rejected». `VK_DEFAULT_STATUSES` (`src/clients/vk-ads/entities.ts`) — это
     * `active,blocked`, и фильтр `_status__in` отправляется на каждом чтении, включая
     * чтение по конкретному id внутри `updateAdText`.
     *
     * Последствия, если словарь ТЗ верен:
     *  • отклонённое объявление не приезжает в `listAds` — модерация о нём не узнает
     *    вовсе, а `pollAdModeration` посчитает нашу строку пропавшей и позовёт человека;
     *  • даже с известным id пересоздать баннер нельзя: адаптер не находит его и
     *    падает с VK_BANNER_NOT_FOUND, то есть переписывание текста не работает совсем.
     *
     * Чинится не догадкой, а живым токеном: либо словарь статусов дополняется, либо
     * фильтр меняется на исключающий (`_status__ne=deleted`), либо чтение по `ids`
     * перестаёт фильтровать по статусу вовсе — id и так адресует ровно один объект.
     */
    const cabinet = createVkCabinet();
    const rejectedBanner = cabinet.banners.find((b) => b.id === VK_IDS.bannerRejected);
    if (!rejectedBanner) throw new Error('фикстура потеряла отклонённый баннер');
    rejectedBanner.status = 'rejected';
    startMock({ cabinet });

    const ads = await adapter.listAds(await ctx(), groupIds);
    expect(ads.map((a) => a.externalId)).not.toContain(String(VK_IDS.bannerRejected));
    expect(vk.callsTo('banners.json')[0]?.query['_status__in']).toBe('active,blocked');

    await expect(
      adapter.updateAdText(await ctx(), String(VK_IDS.bannerRejected), {
        title: 'Мамонты с доставкой',
        text: 'Привезём мамонта за сутки',
      }),
    ).rejects.toMatchObject({ code: 'VK_BANNER_NOT_FOUND' });

    // Ни создания, ни удаления: половину замены сделать хуже, чем не делать ничего.
    expect(
      vk.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('oauth2/')),
    ).toHaveLength(0);
  });

  it('ДЕФЕКТ: id созданного баннера строкой оставляет в группе ничей баннер', async () => {
    /**
     * `readCreatedId` в адаптере разбирает ответ через `vkBannerSchema.partial()`, где
     * `id: z.number()`. Соседние создания того же клиента (`remarketing.ts`) читают id
     * через `vkCreatedSchema`, у которого `vkId` принимает и строку — а сам
     * `src/clients/vk-ads/schemas.ts` прямо пишет, что VK местами отдаёт id строкой.
     *
     * Цена расхождения: замена уже создана и уже тратит деньги, но её id мы «не
     * увидели», старый баннер оставили жить, а в контексте ошибки нет
     * `createdBannerExternalId` — то есть `moderation/repair.ts` не сможет подобрать
     * осиротевший баннер, как он это делает для VK_BANNER_REPLACE_ORPHAN.
     */
    startMock({ createdIdAsString: true });
    const before = vk.cabinet.banners.length;

    await expect(
      adapter.updateAdText(await ctx(), String(VK_IDS.bannerRejected), {
        title: 'Мамонты с доставкой',
        text: 'Привезём мамонта за сутки',
      }),
    ).rejects.toMatchObject({ code: 'VK_BANNER_CREATE_NO_ID' });

    // Баннер в кабинете есть, старый жив, а связи между ними не знает никто.
    expect(vk.cabinet.banners).toHaveLength(before + 1);
    expect(vk.bannerById(VK_IDS.bannerRejected)?.status).toBe('active');
    expect(vk.callsTo(`banners/${VK_IDS.bannerRejected}.json`)).toHaveLength(0);
  });

  it('ДЕФЕКТ: без явного fields кампания заведётся без имени и без бюджета', async () => {
    /**
     * `VkListOptions.fields` заведён с комментарием «VK по умолчанию отдаёт урезанный
     * набор», но ни один вызов адаптера его не передаёт. Если комментарий верен, весь
     * разбор ответов идёт по полям, которых в ответе нет: имя пустое, дневной бюджет
     * null (а null у VK означает «лимита нет»), тексты баннеров пустые.
     *
     * Проверить это без живого токена нельзя, поэтому мок по умолчанию щедрый, а здесь
     * включён строгий режим — чтобы цена ошибки была видна в цифрах, а не в комментарии.
     */
    startMock({ trimUnrequestedFields: true });

    const [campaign] = await adapter.listCampaigns(await ctx());
    expect(campaign).toMatchObject({
      externalId: String(VK_IDS.plan),
      name: '',
      dailyBudget: null,
    });

    const ads = await adapter.listAds(await ctx(), groupIds);
    expect(ads.every((ad) => ad.title === '' && ad.text === '')).toBe(true);

    // Ни один запрос листинга поля не перечислил — в этом и суть.
    expect(
      vk.calls.filter((c) => c.method === 'GET').every((c) => c.query['fields'] === undefined),
    ).toBe(true);
  });

  it('часть объектов отклонена: пишем ровно то, что площадка приняла', async () => {
    startMock({ massActionAck: 'items' });
    const context = await ctx();
    // Удалённый объект — самая частая причина поштучного отказа внутри 200.
    await adapter.updateAdText(context, String(VK_IDS.bannerOk), {
      title: 'Мамонты в наличии',
      text: 'Сертифицированные мамонты, доставка по России за сутки',
    });
    expect(vk.bannerById(VK_IDS.bannerOk)?.status).toBe('deleted');

    const result = await adapter.pauseEntities(context, 'ad', [
      String(VK_IDS.bannerLoser),
      String(VK_IDS.bannerOk),
    ]);

    expect(result.applied).toBe(true);
    expect(result.result).toEqual({
      requested: 2,
      updated: 1,
      failed: [{ id: String(VK_IDS.bannerOk), message: `object ${VK_IDS.bannerOk} not found` }],
    });
    expect(vk.bannerById(VK_IDS.bannerLoser)?.status).toBe('blocked');
  });

  it('площадка отклонила всё: это ошибка, а не «применено»', async () => {
    startMock();
    const context = await ctx();

    await expect(adapter.pauseEntities(context, 'ad', ['77777'])).rejects.toMatchObject({
      code: 'VK_MASS_UPDATE_REJECTED',
    });
    // Строка ChangeLog про несуществующее изменение не появится: ошибка ушла наверх.
    expect(await prisma.changeLog.count()).toBe(0);
  });

  it('деньги, которые нельзя записать, не доезжают до сети', async () => {
    startMock();
    const context = await ctx();

    // Ноль у VK означает «лимита нет», то есть снятый предохранитель, а не «ставка 0».
    await expect(
      adapter.setBudgets(context, [{ campaignExternalId: String(VK_IDS.plan), dailyBudget: 0 }]),
    ).rejects.toMatchObject({ code: 'VK_INVALID_MONEY' });
    expect(
      vk.calls.filter((c) => c.method === 'POST' && !c.path.startsWith('oauth2/')),
    ).toHaveLength(0);
    expect(vk.adPlanById(VK_IDS.plan)?.budget_limit_day).toBe('5000.00');
  });
});
