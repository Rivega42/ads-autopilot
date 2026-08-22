import { AdStatus, ModerationStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import {
  createModelStub,
  emptyVkStats,
  seedAd,
  seedModerationClient,
  vkBanner,
  vkGroup,
  vkPlan,
  type SeededClient,
} from './support/moderation-seed.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';
import { createVkApiMock, type VkApiMock } from './support/vk-api-mock.js';

import { setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { clearVkTokenCache } from '@/clients/vk-ads/auth.js';
import { prisma } from '@/db/prisma.js';
import { MAX_MISSING_ADS_PER_TARGET, runModerationCheck } from '@/moderation/index.js';

/**
 * Сквозной прогон AI-Модератора в канале VK.
 *
 * У VK правка текста — это создание нового баннера и удаление старого, и именно
 * отсюда вышли четыре из пяти прошлых дефектов модуля: потерянный внешний id,
 * воскрешение погашенного баннера, тупик на занятой паре `(группа, внешний id)` и
 * строки, пропавшие из листинга. Проверяются они здесь вместе, одним путём.
 *
 * Мок ведёт себя как протокол (`support/vk-api-mock.ts`): токен обязателен, фильтры
 * применяются, удаление меняет статус объекта, а созданный баннер уезжает на
 * модерацию заново. Наружу не уходит ничего — `onUnhandledRequest: 'error'`.
 *
 * Каждый сценарий — свой клиент со своим планом: прогон обходит кабинет целиком.
 */

const VK_APP = { clientId: 'vk-moderation-e2e', clientSecret: 'vk-moderation-secret' } as const;

const IDS = {
  replace: { plan: 8000, group: 8100, rejected: 8201, ok: 8202 },
  paused: { plan: 8001, group: 8101, blockedNoVerdict: 8203, blockedRejected: 8204 },
  missing: { plan: 8002, group: 8102, present: 8205, emptyGroup: 8103 },
  taken: { plan: 8003, group: 8104, rejected: 8206 },
} as const;

const REJECTION = 'Превосходная степень без подтверждения: «самые лучшие»';
/** Внешние id, которых в кабинете нет вовсе: строка указывает в пустоту. */
const GONE = ['8801', '8802', '8803', '8804', '8805', '8806'] as const;

/** Тексты в пределах лимитов VK (25/90) и мимо всех лексических детекторов. */
function variant(n: number): { title: string; text: string } {
  return {
    title: `Окна от завода ${n}`,
    text: `Замер и монтаж за один день. Договор и гарантия два года. Вариант ${n}.`,
  };
}

let vk: VkApiMock;
let telegram: TelegramMock;
let replace: SeededClient;
let paused: SeededClient;
let missing: SeededClient;
let taken: SeededClient;

function seed(
  tgUserId: bigint,
  name: string,
  ids: { plan: number },
  groups: Parameters<typeof seedModerationClient>[0]['groups'],
): Promise<SeededClient> {
  return seedModerationClient({
    tgUserId,
    name,
    provider: 'VK_ADS',
    credentials: { clientId: VK_APP.clientId, clientSecret: VK_APP.clientSecret },
    campaignExternalId: String(ids.plan),
    campaignName: name,
    groups,
  });
}

function textsSentTo(chatId: string): string[] {
  return telegram.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
}

/**
 * Id, который кабинет присвоит следующему созданному баннеру.
 *
 * Мок раздаёт их подряд начиная с 9001, а фикстуры живут в диапазоне 8xxx —
 * значит максимум среди «созданных» плюс один. Нужен ровно одному сценарию:
 * занять пару `(группа, внешний id)` до того, как её займёт замена.
 */
function nextCreatedBannerId(): number {
  const created = vk.cabinet.banners.map((b) => b.id).filter((id) => id > 9000);
  return (created.length === 0 ? 9000 : Math.max(...created)) + 1;
}

describe('AI-Модератор в VK: замена баннера и её края', () => {
  beforeAll(async () => {
    await resetDatabase();
    clearVkTokenCache();
    bootstrapChannels();

    vk = createVkApiMock({
      app: VK_APP,
      // Клиентов в сценарии четыре, а токен минтится на каждого: потолок по умолчанию
      // (5) сработал бы как настоящий и уронил бы последний сценарий на 403.
      maxTokens: 20,
      cabinet: {
        adPlans: [
          vkPlan(IDS.replace.plan, 'Окна — сайт'),
          vkPlan(IDS.paused.plan, 'Потолки — сайт'),
          vkPlan(IDS.missing.plan, 'Двери — сайт'),
          vkPlan(IDS.taken.plan, 'Полы — сайт'),
        ],
        adGroups: [
          vkGroup(IDS.replace.group, IDS.replace.plan, 'Окна — интересы'),
          vkGroup(IDS.paused.group, IDS.paused.plan, 'Потолки — интересы'),
          vkGroup(IDS.missing.group, IDS.missing.plan, 'Двери — интересы'),
          // Группа есть, а баннеров в ней кабинет не отдаёт: по ней нельзя судить
          // о пропажах — «до неё не доехало» неотличимо от «объявлений там нет».
          vkGroup(IDS.missing.emptyGroup, IDS.missing.plan, 'Двери — пустая'),
          vkGroup(IDS.taken.group, IDS.taken.plan, 'Полы — интересы'),
        ],
        banners: [
          vkBanner({
            id: IDS.replace.rejected,
            groupId: IDS.replace.group,
            title: 'Самые лучшие окна',
            text: 'Самое лучшее предложение на рынке',
            moderationStatus: 'rejected',
            moderationReason: REJECTION,
          }),
          vkBanner({
            id: IDS.replace.ok,
            groupId: IDS.replace.group,
            title: 'Окна с монтажом',
            text: 'Замер бесплатно, монтаж за день',
          }),
          vkBanner({
            id: IDS.paused.blockedNoVerdict,
            groupId: IDS.paused.group,
            title: 'Потолки под ключ',
            text: 'Монтаж за один день, договор',
            // Пауза, которую поставили мы сами. Поля модерации у баннера нет вовсе —
            // именно на таком объекте `banner.status` раньше читался как вердикт.
            status: 'blocked',
            moderationStatus: null,
          }),
          vkBanner({
            id: IDS.paused.blockedRejected,
            groupId: IDS.paused.group,
            title: 'Самые лучшие потолки',
            text: 'Самое лучшее предложение на рынке',
            status: 'blocked',
            moderationStatus: 'rejected',
            moderationReason: REJECTION,
          }),
          vkBanner({
            id: IDS.missing.present,
            groupId: IDS.missing.group,
            title: 'Двери с установкой',
            text: 'Замер бесплатно, установка за день',
          }),
          vkBanner({
            id: IDS.taken.rejected,
            groupId: IDS.taken.group,
            title: 'Самые лучшие полы',
            text: 'Самое лучшее предложение на рынке',
            moderationStatus: 'rejected',
            moderationReason: REJECTION,
          }),
        ],
        stats: emptyVkStats(),
      },
    });
    // 'error' обязателен: без него незамоканный запрос ушёл бы в настоящий ads.vk.ru.
    vk.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);

    replace = await seed(770200001n, 'ООО «Окна VK»', IDS.replace, [
      {
        externalId: String(IDS.replace.group),
        name: 'Окна — интересы',
        ads: [
          {
            alias: 'rejected',
            externalId: String(IDS.replace.rejected),
            title: 'Самые лучшие окна',
            body: 'Самое лучшее предложение на рынке',
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
          },
          {
            alias: 'ok',
            externalId: String(IDS.replace.ok),
            title: 'Окна с монтажом',
            body: 'Замер бесплатно, монтаж за день',
          },
        ],
      },
    ]);

    paused = await seed(770200002n, 'ООО «Потолки VK»', IDS.paused, [
      {
        externalId: String(IDS.paused.group),
        name: 'Потолки — интересы',
        ads: [
          {
            alias: 'blockedNoVerdict',
            externalId: String(IDS.paused.blockedNoVerdict),
            title: 'Потолки под ключ',
            body: 'Монтаж за один день, договор',
            // Синк ещё не доехал: строка числится работающей, а в кабинете пауза.
            status: AdStatus.ACTIVE,
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: 'прошлый отказ, уже неактуальный',
            moderationRetries: 1,
          },
          {
            alias: 'blockedRejected',
            externalId: String(IDS.paused.blockedRejected),
            title: 'Самые лучшие потолки',
            body: 'Самое лучшее предложение на рынке',
            status: AdStatus.PAUSED,
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
            moderationRetries: 1,
          },
        ],
      },
    ]);

    missing = await seed(770200003n, 'ООО «Двери VK»', IDS.missing, [
      {
        externalId: String(IDS.missing.group),
        name: 'Двери — интересы',
        ads: [
          {
            alias: 'present',
            externalId: String(IDS.missing.present),
            title: 'Двери с установкой',
            body: 'Замер бесплатно, установка за день',
          },
          {
            // След нашей же замены: переписывали, а нового id записать не успели.
            alias: 'gone',
            externalId: GONE[0],
            title: 'Двери без превосходной степени',
            body: 'Замер и монтаж за один день',
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
            moderationRetries: 1,
          },
          {
            // Мы это объявление не трогали: пропало по воле клиента — не наш случай.
            alias: 'never-touched',
            externalId: GONE[1],
            title: 'Двери оптом',
            body: 'Отгрузим со склада',
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
            moderationRetries: 0,
          },
          {
            // Выключенная строка ничего не показывает и денег не тратит.
            alias: 'gone-but-off',
            externalId: GONE[2],
            title: 'Двери со скидкой',
            body: 'Скидка на первую дверь',
            status: AdStatus.PAUSED,
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
            moderationRetries: 2,
          },
        ],
      },
      {
        externalId: String(IDS.missing.emptyGroup),
        name: 'Двери — пустая',
        ads: [
          {
            alias: 'gone-in-silent-group',
            externalId: GONE[3],
            title: 'Двери межкомнатные',
            body: 'Установка за один день',
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
            moderationRetries: 1,
          },
        ],
      },
    ]);

    taken = await seed(770200004n, 'ООО «Полы VK»', IDS.taken, [
      {
        externalId: String(IDS.taken.group),
        name: 'Полы — интересы',
        ads: [
          {
            alias: 'rejected',
            externalId: String(IDS.taken.rejected),
            title: 'Самые лучшие полы',
            body: 'Самое лучшее предложение на рынке',
            moderationStatus: ModerationStatus.REJECTED,
            moderationReason: REJECTION,
          },
        ],
      },
    ]);
  });

  afterAll(async () => {
    vk?.server.close();
    setMessenger(null);
    clearVkTokenCache();
    await prisma.$disconnect();
  });

  it('замена баннера: новый создан, старый удалён, строка переехала на живой id', async () => {
    const model = createModelStub({ variant });
    const adId = replace.adIds['rejected'] ?? '';
    vk.reset();

    const summary = await runModerationCheck({
      clientId: replace.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      targets: 1,
      ok: 1,
      adsPolled: 2,
      statusUpdated: 0,
      reclaimed: 0,
      missing: 0,
      rejected: 1,
      rewritten: 1,
      escalated: 0,
      skipped: 0,
    });
    expect(summary.failures).toEqual([]);

    // Порядок обязателен: сначала читаем баннер, потом создаём замену и только потом
    // удаляем старый. Обратный порядок оставил бы группу без объявления.
    const bannerCalls = vk.calls.filter((c) => c.path.startsWith('banners'));
    expect(bannerCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET banners.json',
      'GET banners.json',
      'POST banners.json',
      `DELETE banners/${IDS.replace.rejected}.json`,
    ]);

    const created = vk.cabinet.banners.find((b) => b.id > 9000);
    expect(created).toMatchObject({
      ad_group_id: IDS.replace.group,
      // Замена наследует статус исходного баннера, а не заводится работающей.
      status: 'active',
      moderation_status: 'pending',
      textblocks: {
        title_25: { text: variant(1).title },
        text_90: { text: variant(1).text },
      },
    });
    // Старый именно удалён, а не выключен.
    expect(vk.bannerById(IDS.replace.rejected)?.status).toBe('deleted');

    // Главное: строка обязана переехать. Со старым id она выпадает из статистики,
    // из опроса модерации и из любой будущей паузы.
    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row).toMatchObject({
      externalId: String(created?.id),
      title: variant(1).title,
      body: variant(1).text,
      moderationStatus: ModerationStatus.PENDING,
      moderationReason: null,
      moderationRetries: 1,
      status: AdStatus.ACTIVE,
    });

    const log = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: adId, action: 'moderation_rewrite' },
    });
    expect(log.newValue).toMatchObject({
      externalIdBefore: String(IDS.replace.rejected),
      externalIdAfter: String(created?.id),
      retries: 1,
    });
    expect(textsSentTo(replace.chatId)).toEqual([]);
  });

  it('следующий опрос находит объявление по новому id и видит новый вердикт', async () => {
    const model = createModelStub({ variant });
    const adId = replace.adIds['rejected'] ?? '';
    const created = vk.cabinet.banners.find((b) => b.id > 9000);
    expect(created).toBeDefined();

    // Кабинет закончил проверку и принял замену.
    const banner = vk.bannerById(created?.id ?? 0);
    if (banner) banner.moderation_status = 'allowed';

    const summary = await runModerationCheck({
      clientId: replace.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    // Удалённый баннер выпал из листинга, поэтому объявлений двое, а не трое.
    expect(summary).toMatchObject({ adsPolled: 2, statusUpdated: 1, rejected: 0, rewritten: 0 });
    // Пропажей строка не считается: она переехала на живой id.
    expect(summary.missing).toBe(0);
    expect(model.classifyCalls).toBe(0);

    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row).toMatchObject({
      moderationStatus: ModerationStatus.APPROVED,
      moderationRetries: 0,
    });
  });

  it('баннер, который выключили мы сами, не читается как отказ модерации', async () => {
    const model = createModelStub({ variant });
    vk.reset();

    const summary = await runModerationCheck({
      clientId: paused.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      adsPolled: 2,
      // Только у баннера без вердикта: у второго и статус, и причина уже совпадают.
      statusUpdated: 1,
      rejected: 0,
      rewritten: 0,
      escalated: 0,
      missing: 0,
    });
    // Ни одного создания баннера: воскрешать погашенное нечем.
    expect(vk.calls.filter((c) => c.method === 'POST' && c.path === 'banners.json')).toEqual([]);
    expect(model.classifyCalls).toBe(0);
    expect(textsSentTo(paused.chatId)).toEqual([]);

    // Отсутствие данных о модерации — это «ещё не проверено», а не «отклонено».
    const silent = await prisma.ad.findUniqueOrThrow({
      where: { id: paused.adIds['blockedNoVerdict'] ?? '' },
    });
    expect(silent).toMatchObject({
      moderationStatus: ModerationStatus.PENDING,
      moderationReason: null,
      // Счётчик попыток не обнуляется: объявление никто не принимал.
      moderationRetries: 1,
    });

    // Настоящий отказ на выключенном объявлении в строку пишется, а в починку — нет.
    const rejectedOff = await prisma.ad.findUniqueOrThrow({
      where: { id: paused.adIds['blockedRejected'] ?? '' },
    });
    expect(rejectedOff).toMatchObject({
      status: AdStatus.PAUSED,
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: 1,
    });
  });

  it('строка, пропавшая из листинга, зовёт человека — и только она одна', async () => {
    const model = createModelStub({ variant });
    const goneId = missing.adIds['gone'] ?? '';

    const summary = await runModerationCheck({
      clientId: missing.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      adsPolled: 1,
      missing: 1,
      escalated: 1,
      rejected: 0,
      rewritten: 0,
    });
    expect(summary.failures).toEqual([]);

    const letters = textsSentTo(missing.chatId);
    expect(letters).toHaveLength(1);
    const letter = letters[0] ?? '';
    expect(letter).toContain('Почему остановились: объявления с таким id в кабинете больше нет');
    expect(letter).toContain(`Объявление: ${GONE[0]} (внутренний id ${goneId})`);
    expect(letter).toContain(`объявления ${GONE[0]} нет в листинге кабинета VK_ADS`);
    expect(letter).toContain('новый id записать не успели');

    const log = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: goneId, action: 'moderation_missing' },
    });
    expect(log.newValue).toMatchObject({ externalId: GONE[0], retries: 1, cause: 'ad_missing' });

    // Пометка «не работает» и дедуплицирует письма, и убирает строку из решений
    // оптимизатора: паузу несуществующему баннеру он предлагал бы вечно.
    const row = await prisma.ad.findUniqueOrThrow({ where: { id: goneId } });
    expect(row.status).toBe(AdStatus.ARCHIVED);

    // Ни одна из соседних пропаж письмом не стала: у одной нет следа нашей попытки,
    // вторая выключена, третья лежит в группе, из которой кабинет не отдал ничего.
    const others = Object.fromEntries(
      await Promise.all(
        ['never-touched', 'gone-but-off', 'gone-in-silent-group'].map(async (alias) => {
          const row = await prisma.ad.findUniqueOrThrow({
            where: { id: missing.adIds[alias] ?? '' },
          });
          return [alias, row.status] as const;
        }),
      ),
    );
    expect(others).toEqual({
      'never-touched': AdStatus.ACTIVE,
      'gone-but-off': AdStatus.PAUSED,
      'gone-in-silent-group': AdStatus.ACTIVE,
    });
    expect(await prisma.changeLog.count({ where: { action: 'moderation_missing' } })).toBe(1);
  });

  it('повторный прогон второго письма про ту же пропажу не шлёт', async () => {
    const model = createModelStub({ variant });

    const summary = await runModerationCheck({
      clientId: missing.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({ missing: 0, escalated: 0 });
    expect(textsSentTo(missing.chatId)).toHaveLength(1);
    expect(await prisma.changeLog.count({ where: { action: 'moderation_missing' } })).toBe(1);
  });

  it('пачка пропаж означает неполный листинг и обязана молчать', async () => {
    const model = createModelStub({ variant });
    const aliases = ['gone-2', 'gone-3', 'gone-4', 'gone-5'];
    for (const [index, alias] of aliases.entries()) {
      await seedAd(missing, String(IDS.missing.group), {
        alias,
        externalId: `${GONE[4]}${index}`,
        title: `Двери вариант ${index}`,
        body: 'Замер и монтаж за один день',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
        moderationRetries: 1,
      });
    }
    expect(aliases).toHaveLength(MAX_MISSING_ADS_PER_TARGET + 1);

    const summary = await runModerationCheck({
      clientId: missing.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    // Веер писем по оборванной пагинации приучил бы человека их не читать.
    expect(summary).toMatchObject({ missing: 0, escalated: 0 });
    expect(textsSentTo(missing.chatId)).toHaveLength(1);
    expect(await prisma.changeLog.count({ where: { action: 'moderation_missing' } })).toBe(1);
    for (const alias of aliases) {
      const row = await prisma.ad.findUniqueOrThrow({ where: { id: missing.adIds[alias] ?? '' } });
      expect(row.status).toBe(AdStatus.ACTIVE);
    }
  });

  it('на границе в три пропажи письма снова уходят', async () => {
    const model = createModelStub({ variant });
    await prisma.ad.delete({ where: { id: missing.adIds['gone-5'] ?? '' } });

    const summary = await runModerationCheck({
      clientId: missing.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({ missing: MAX_MISSING_ADS_PER_TARGET, escalated: 3 });
    expect(textsSentTo(missing.chatId)).toHaveLength(1 + MAX_MISSING_ADS_PER_TARGET);
    expect(await prisma.changeLog.count({ where: { action: 'moderation_missing' } })).toBe(
      1 + MAX_MISSING_ADS_PER_TARGET,
    );
  });

  it('занятая пара (группа, внешний id) не тупик: строка гасится, человека зовут', async () => {
    const model = createModelStub({ variant });
    const adId = taken.adIds['rejected'] ?? '';
    // Пару, на которую переедет замена, уже завела почасовая загрузка: она делает
    // upsert по тем же `(adGroupId, externalId)`. Слить две строки автоматика не вправе.
    const collision = String(nextCreatedBannerId());
    const decoyId = await seedAd(taken, String(IDS.taken.group), {
      alias: 'decoy',
      externalId: collision,
      title: 'Полы уже заведённые',
      body: 'Строку по этому id завела загрузка',
    });

    const summary = await runModerationCheck({
      clientId: taken.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({ rejected: 1, rewritten: 0, escalated: 1, skipped: 0 });
    expect(summary.failures).toEqual([]);

    // Замена в кабинете создана и получила ровно тот id, который был занят.
    expect(vk.cabinet.banners.some((b) => String(b.id) === collision)).toBe(true);
    expect(vk.bannerById(IDS.taken.rejected)?.status).toBe('deleted');

    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row).toMatchObject({
      // Внешний id остался старым — выдуманный был бы хуже устаревшего…
      externalId: String(IDS.taken.rejected),
      // …но строка помечена нерабочей: баннера по этому id в кабинете больше нет.
      status: AdStatus.ARCHIVED,
      title: variant(1).title,
      moderationStatus: ModerationStatus.PENDING,
      moderationRetries: 1,
    });

    // Расхождение записано для разбора, но зовёт человека именно эскалация: одиночная
    // строка в ErrorLog до порога алерта (10 за 5 минут) не доходит по определению.
    const errors = await prisma.errorLog.findMany({ where: { clientId: taken.clientId } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.scope).toBe(`moderation:external-id:${adId}`);

    const letters = textsSentTo(taken.chatId);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toContain(
      'Почему остановились: внешний id нового объявления занят другой строкой в нашей БД',
    );
    expect(letters[0]).toContain(`в кабинете это уже другое объявление ${collision}`);
    expect(letters[0]).toContain('помечена как не работающая');

    const escalation = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: adId, action: 'moderation_escalated' },
    });
    expect(escalation.newValue).toMatchObject({ cause: 'external_id_taken', parkedAt: 1 });

    // Соседняя строка, занявшая пару, не тронута ничем.
    const decoy = await prisma.ad.findUniqueOrThrow({ where: { id: decoyId } });
    expect(decoy).toMatchObject({ externalId: collision, status: AdStatus.ACTIVE });
  });

  it('после занятого id прогон не зацикливается: погашенная строка молчит', async () => {
    const model = createModelStub({ variant });
    const bannersBefore = vk.cabinet.banners.length;

    const summary = await runModerationCheck({
      clientId: taken.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({ rejected: 0, rewritten: 0, escalated: 0, missing: 0 });
    expect(model.rewriteCalls).toBe(0);
    // Ни одного нового баннера: без пометки нерабочей строка создавала бы их вечно.
    expect(vk.cabinet.banners).toHaveLength(bannersBefore);
    expect(textsSentTo(taken.chatId)).toHaveLength(1);
  });
});
