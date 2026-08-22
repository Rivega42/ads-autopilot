import { AdStatus, ModerationStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import {
  createModelStub,
  emptyVkStats,
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
import { runIngestion } from '@/ingestion/index.js';
import { runModerationCheck } from '@/moderation/index.js';

/**
 * Половина применённой замены: баннер создан, старый удалить не вышло.
 *
 * Самый дорогой край всего модуля. Замена уже показывается и тратит бюджет, id
 * живого баннера сохранился ровно в одном месте — в контексте ошибки, а старый
 * баннер остался в кабинете погашенным и из листинга не исчезнет. Проверяется, что
 * id живого не теряется, что человек узнаёт об этом письмом, и что погашенный
 * баннер не превращается во второе объявление со своей жизнью — то есть что
 * загрузка заводит под него архивную строку, а не работающую.
 *
 * Отдельный файл, а не сценарий в `moderation-vk-replace.e2e.ts`, потому что здесь
 * гоняется `runIngestion`: она обходит кабинет целиком, и в общем моке чужие планы
 * уехали бы в кампании этого клиента.
 */

const VK_APP = { clientId: 'vk-orphan-e2e', clientSecret: 'vk-orphan-secret' } as const;

const IDS = { plan: 8500, group: 8510, rejected: 8601, ok: 8602 } as const;

const REJECTION = 'Превосходная степень без подтверждения: «самые лучшие»';

function variant(n: number): { title: string; text: string } {
  return {
    title: `Двери от завода ${n}`,
    text: `Замер и монтаж за один день. Договор и гарантия два года. Вариант ${n}.`,
  };
}

let vk: VkApiMock;
let telegram: TelegramMock;
let fx: SeededClient;
let liveBannerId: number;

function letters(): string[] {
  return telegram.sent.filter((m) => m.chatId === fx.chatId).map((m) => m.text);
}

describe('AI-Модератор в VK: замена применилась наполовину', () => {
  beforeAll(async () => {
    await resetDatabase();
    clearVkTokenCache();
    bootstrapChannels();

    vk = createVkApiMock({
      app: VK_APP,
      cabinet: {
        adPlans: [vkPlan(IDS.plan, 'Двери — сайт')],
        adGroups: [vkGroup(IDS.group, IDS.plan, 'Двери — интересы')],
        banners: [
          vkBanner({
            id: IDS.rejected,
            groupId: IDS.group,
            title: 'Самые лучшие двери',
            text: 'Самое лучшее предложение на рынке',
            moderationStatus: 'rejected',
            moderationReason: REJECTION,
          }),
          vkBanner({
            id: IDS.ok,
            groupId: IDS.group,
            title: 'Двери с установкой',
            text: 'Замер бесплатно, установка за день',
          }),
        ],
        stats: emptyVkStats(),
      },
    });
    vk.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);

    fx = await seedModerationClient({
      tgUserId: 770300001n,
      name: 'ООО «Двери VK»',
      provider: 'VK_ADS',
      credentials: { clientId: VK_APP.clientId, clientSecret: VK_APP.clientSecret },
      campaignExternalId: String(IDS.plan),
      campaignName: 'Двери — сайт',
      groups: [
        {
          externalId: String(IDS.group),
          name: 'Двери — интересы',
          ads: [
            {
              alias: 'rejected',
              externalId: String(IDS.rejected),
              title: 'Самые лучшие двери',
              body: 'Самое лучшее предложение на рынке',
              moderationStatus: ModerationStatus.REJECTED,
              moderationReason: REJECTION,
            },
            {
              alias: 'ok',
              externalId: String(IDS.ok),
              title: 'Двери с установкой',
              body: 'Замер бесплатно, установка за день',
            },
          ],
        },
      ],
    });
  });

  afterAll(async () => {
    vk?.server.close();
    setMessenger(null);
    clearVkTokenCache();
    await prisma.$disconnect();
  });

  it('id живого баннера не теряется, а отказ доходит до ErrorLog и до человека', async () => {
    const model = createModelStub({ variant });
    const adId = fx.adIds['rejected'] ?? '';
    // Удаление старого баннера не проходит. Замена к этому моменту уже создана и уже
    // показывается — именно та ситуация, в которой раньше терялся внешний id.
    vk.program({
      path: 'banners/',
      method: 'DELETE',
      status: 500,
      body: { error: 'server error' },
    });

    const summary = await runModerationCheck({
      clientId: fx.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    // Прогон не падает целиком: отказ по одному объявлению — это запись в журнал.
    expect(summary).toMatchObject({ targets: 1, ok: 0, rejected: 1, rewritten: 0, escalated: 0 });
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      clientId: fx.clientId,
      provider: 'VK_ADS',
      stage: `repair:${adId}`,
      code: 'VK_BANNER_REPLACE_ORPHAN',
    });

    const errors = await prisma.errorLog.findMany({ where: { clientId: fx.clientId } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ scope: `moderation:repair:${adId}`, provider: 'VK_ADS' });

    const created = vk.cabinet.banners.find((b) => b.id > 9000);
    expect(created).toBeDefined();
    liveBannerId = created?.id ?? 0;
    // Замена крутится, старый баннер погашен адаптером и остался в кабинете.
    expect(created?.status).toBe('active');
    expect(vk.bannerById(IDS.rejected)?.status).toBe('blocked');

    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row).toMatchObject({
      // Единственное место, где сохранился id живого баннера, — контекст ошибки.
      externalId: String(liveBannerId),
      title: variant(1).title,
      body: variant(1).text,
      // Захват снят, а попытка потрачена: текст в кабинет уже уехал.
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: 1,
      status: AdStatus.ACTIVE,
    });

    // Смена текста обязана попасть в журнал и на этой ветке — иначе A/B подошьёт
    // показы нового текста к отпечатку старого варианта.
    const rewrite = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: adId, action: 'moderation_rewrite' },
    });
    expect(rewrite.newValue).toMatchObject({
      externalIdBefore: String(IDS.rejected),
      externalIdAfter: String(liveBannerId),
    });
    // А вот брошенный id — на самой строке: журнал отвечает на вопрос «что было»,
    // и восстанавливать по нему текущее состояние загрузка больше не обязана.
    expect(row.supersededExternalIds).toEqual([String(IDS.rejected)]);

    const sent = letters();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(
      'Почему остановились: отправка переписанного текста в кабинет не удалась',
    );
    expect(sent[0]).toContain(`Объявление: ${liveBannerId} (внутренний id ${adId})`);
    expect(sent[0]).toContain('отправка в кабинет VK_ADS не удалась');
    expect(sent[0]).toContain(
      `в кабинете уже показывается новое объявление ${liveBannerId}, старое ${IDS.rejected} осталось и остановлено`,
    );

    const escalation = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: adId, action: 'moderation_escalated' },
    });
    // Парковки нет: потрачена одна попытка, следующий прогон вправе попробовать ещё.
    expect(escalation.newValue).toMatchObject({ cause: 'apply_failed', parkedAt: 1 });
  });

  it('загрузка заводит под погашенный баннер архивную строку, а не второе объявление', async () => {
    const summary = await runIngestion({ clientId: fx.clientId });

    expect(summary.failures).toEqual([]);
    // Три строки: одобренная соседка, живая замена и погашенный оригинал.
    const rows = await prisma.ad.findMany({ orderBy: { externalId: 'asc' } });
    expect(rows).toHaveLength(3);

    const superseded = rows.find((r) => r.externalId === String(IDS.rejected));
    expect(superseded).toBeDefined();
    // Статуса кабинета здесь мало: попытка погасить баннер могла и не пройти, и тогда
    // «работает» вернуло бы объявление-двойник и в A/B, и в выборки оптимизатора.
    expect(superseded?.status).toBe(AdStatus.ARCHIVED);

    const live = rows.find((r) => r.externalId === String(liveBannerId));
    expect(live).toMatchObject({
      id: fx.adIds['rejected'] ?? '',
      status: AdStatus.ACTIVE,
      moderationStatus: ModerationStatus.PENDING,
      // Загрузка не трогает счётчик попыток: он наш, а не кабинета.
      moderationRetries: 1,
    });
  });

  it('повторная загрузка переутверждает пометку, а не забывает её', async () => {
    // Пометка переутверждается на каждом прогоне по `supersededExternalIds` живой
    // строки и в строке самого баннера не запоминается: иначе первый же синк,
    // увидевший его работающим, вернул бы ему «работает».
    await prisma.ad.updateMany({
      where: { externalId: String(IDS.rejected) },
      data: { status: AdStatus.ACTIVE },
    });

    const summary = await runIngestion({ clientId: fx.clientId });

    expect(summary.failures).toEqual([]);
    const superseded = await prisma.ad.findFirstOrThrow({
      where: { externalId: String(IDS.rejected) },
    });
    expect(superseded.status).toBe(AdStatus.ARCHIVED);
  });

  it('погашенный баннер не оплачивает себе ещё одно переписывание', async () => {
    const model = createModelStub({ variant });
    const bannersBefore = vk.cabinet.banners.length;

    const summary = await runModerationCheck({
      clientId: fx.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      // Кабинет отдаёт три баннера: соседку, замену и погашенный оригинал.
      adsPolled: 3,
      rejected: 0,
      rewritten: 0,
      escalated: 0,
      missing: 0,
    });
    expect(summary.failures).toEqual([]);
    expect(model.rewriteCalls).toBe(0);
    expect(vk.cabinet.banners).toHaveLength(bannersBefore);
    expect(letters()).toHaveLength(1);
  });
});
