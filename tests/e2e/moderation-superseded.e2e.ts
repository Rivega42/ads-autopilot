import { AdStatus, ModerationStatus, type Prisma, type PrismaClient } from '@prisma/client';
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
import { syncEntities } from '@/ingestion/entities.js';
import { runIngestion } from '@/ingestion/index.js';
import { runModerationCheck } from '@/moderation/index.js';

/**
 * Цепочка замен в VK и след, который она обязана оставить.
 *
 * Одно объявление отклоняется дважды подряд, и оба раза удаление старого баннера не
 * проходит: в кабинете остаются два погашенных баннера, оба когда-то принадлежали одной
 * нашей строке. Проверяется, что загрузка гасит их обоих, а не только последний, и что
 * ответ на вопрос «этот баннер мы сами заменили?» она берёт со строки, а не перебором
 * журнала изменений: журнал — про историю, и растёт он вместе со всем проектом.
 *
 * Отдельный файл, а не сценарий в `moderation-vk-orphan.e2e.ts`: там ровно одна замена,
 * а здесь важна именно вторая — на ней видно, что связь «строка → заменённый баннер»
 * не помещается в одно значение.
 */

const VK_APP = { clientId: 'vk-superseded-e2e', clientSecret: 'vk-superseded-secret' } as const;

const IDS = { plan: 8700, group: 8710, rejected: 8701, ok: 8702 } as const;

const REJECTION = 'Превосходная степень без подтверждения: «самые лучшие»';

/** Сколько записей журнала изображают накопленную историю проекта. */
const JOURNAL_NOISE = 300;

function variant(n: number): { title: string; text: string } {
  return {
    title: `Полы от завода ${n}`,
    text: `Замер и укладка за один день. Договор и гарантия два года. Вариант ${n}.`,
  };
}

let vk: VkApiMock;
let telegram: TelegramMock;
let fx: SeededClient;
/** Внешние id, через которые прошла строка: исходный, первая замена, вторая. */
const chain: number[] = [IDS.rejected];

function adId(): string {
  return fx.adIds['rejected'] ?? '';
}

function rowByExternalId(externalId: number): Promise<{ id: string; status: AdStatus }> {
  return prisma.ad.findFirstOrThrow({
    where: { externalId: String(externalId) },
    select: { id: true, status: true },
  });
}

interface JournalReads {
  calls: Prisma.ChangeLogFindManyArgs[];
  rows: number;
}

/**
 * Клиент, считающий обращения загрузки к журналу изменений.
 *
 * Не `$extends` и не Proxy над всем клиентом: подменяются ровно те пять моделей, с
 * которыми работает `syncEntities`. Появись там шестая — тест упадёт на `undefined`,
 * и это правильно: молча пропустить незамеченное обращение он не должен.
 */
function watchJournal(db: PrismaClient, reads: JournalReads): PrismaClient {
  const changeLog = {
    ...db.changeLog,
    findMany: async (args: Prisma.ChangeLogFindManyArgs): Promise<unknown[]> => {
      reads.calls.push(args);
      const rows = await db.changeLog.findMany(args);
      reads.rows += rows.length;
      return rows;
    },
  };
  return {
    campaign: db.campaign,
    adGroup: db.adGroup,
    ad: db.ad,
    keyword: db.keyword,
    changeLog,
  } as unknown as PrismaClient;
}

/** Гасит строку обратно в ACTIVE: без этого «переутвердила» неотличимо от «не тронула». */
async function unarchive(externalIds: readonly number[]): Promise<void> {
  await prisma.ad.updateMany({
    where: { externalId: { in: externalIds.map(String) } },
    data: { status: AdStatus.ACTIVE },
  });
}

describe('AI-Модератор в VK: две замены подряд', () => {
  beforeAll(async () => {
    await resetDatabase();
    clearVkTokenCache();
    bootstrapChannels();

    vk = createVkApiMock({
      app: VK_APP,
      cabinet: {
        adPlans: [vkPlan(IDS.plan, 'Полы — сайт')],
        adGroups: [vkGroup(IDS.group, IDS.plan, 'Полы — интересы')],
        banners: [
          vkBanner({
            id: IDS.rejected,
            groupId: IDS.group,
            title: 'Самые лучшие полы',
            text: 'Самое лучшее предложение на рынке',
            moderationStatus: 'rejected',
            moderationReason: REJECTION,
          }),
          vkBanner({
            id: IDS.ok,
            groupId: IDS.group,
            title: 'Полы с укладкой',
            text: 'Замер бесплатно, укладка за день',
          }),
        ],
        stats: emptyVkStats(),
      },
    });
    vk.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);

    fx = await seedModerationClient({
      tgUserId: 770400001n,
      name: 'ООО «Полы VK»',
      provider: 'VK_ADS',
      credentials: { clientId: VK_APP.clientId, clientSecret: VK_APP.clientSecret },
      campaignExternalId: String(IDS.plan),
      campaignName: 'Полы — сайт',
      groups: [
        {
          externalId: String(IDS.group),
          name: 'Полы — интересы',
          ads: [
            {
              alias: 'rejected',
              externalId: String(IDS.rejected),
              title: 'Самые лучшие полы',
              body: 'Самое лучшее предложение на рынке',
              moderationStatus: ModerationStatus.REJECTED,
              moderationReason: REJECTION,
            },
            {
              alias: 'ok',
              externalId: String(IDS.ok),
              title: 'Полы с укладкой',
              body: 'Замер бесплатно, укладка за день',
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

  it.each([1, 2])(
    'замена %i переводит строку на новый баннер, старый остаётся',
    async (attempt) => {
      const previous = chain[chain.length - 1] ?? 0;
      // Кабинет отклоняет и замену тоже: второй круг — это тот же путь, но строка
      // приходит в него уже с чужим (созданным нами же) внешним id.
      const banner = vk.bannerById(previous);
      if (banner) {
        banner.moderation_status = 'rejected';
        banner.moderation_reason = REJECTION;
      }
      // Удаление старого баннера не проходит — он остаётся в листинге погашенным.
      vk.program({
        path: 'banners/',
        method: 'DELETE',
        status: 500,
        body: { error: 'server error' },
      });

      const model = createModelStub({ variant });
      const summary = await runModerationCheck({
        clientId: fx.clientId,
        runClassify: model.classify,
        runRewrite: model.rewrite,
      });
      expect(summary).toMatchObject({ rejected: 1, rewritten: 0 });

      const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId() } });
      const live = Number(row.externalId);
      expect(live).toBeGreaterThan(9000);
      expect(live).not.toBe(previous);
      expect(row.moderationRetries).toBe(attempt);
      expect(vk.bannerById(previous)?.status).toBe('blocked');
      chain.push(live);
    },
  );

  it('загрузка гасит оба заменённых баннера, а не только последний', async () => {
    const [first, second, live] = chain;
    const summary = await runIngestion({ clientId: fx.clientId });
    expect(summary.failures).toEqual([]);

    // Четыре строки: соседка, живая замена и два погашенных баннера, которые мы
    // оставили в кабинете сами.
    expect(await prisma.ad.count()).toBe(4);
    expect((await rowByExternalId(first ?? 0)).status).toBe(AdStatus.ARCHIVED);
    expect((await rowByExternalId(second ?? 0)).status).toBe(AdStatus.ARCHIVED);
    expect(await rowByExternalId(live ?? 0)).toMatchObject({
      id: adId(),
      status: AdStatus.ACTIVE,
    });
    expect((await rowByExternalId(IDS.ok)).status).toBe(AdStatus.ACTIVE);
  });

  it('ответ на «этот баннер заменили мы?» не стоит перебора журнала', async () => {
    // История проекта: записи того же вида, что читает загрузка. Ни одна из них
    // ничего не меняет в ответе — но выборка без потолка и без окна прочтёт их все.
    await prisma.changeLog.createMany({
      data: Array.from({ length: JOURNAL_NOISE }, (_, i) => ({
        campaignId: fx.campaignId,
        entityType: 'AD',
        entityId: adId(),
        action: 'moderation_rewrite',
        newValue: { retries: i },
        actor: 'AI' as const,
      })),
    });
    await unarchive([chain[0] ?? 0, chain[1] ?? 0]);

    const reads: JournalReads = { calls: [], rows: 0 };
    await syncEntities(fx.clientId, 'VK_ADS', { db: watchJournal(prisma, reads) });

    expect((await rowByExternalId(chain[0] ?? 0)).status).toBe(AdStatus.ARCHIVED);
    expect((await rowByExternalId(chain[1] ?? 0)).status).toBe(AdStatus.ARCHIVED);
    expect(reads.calls).toEqual([]);
    expect(reads.rows).toBe(0);
  });

  it('связь переживает чистку журнала', async () => {
    // Журнал — не хранилище текущего состояния: его чистят, архивируют и режут по
    // сроку. Пометка обязана пережить это, потому что баннер в кабинете переживает.
    await prisma.changeLog.deleteMany({ where: { entityType: 'AD' } });
    await unarchive([chain[0] ?? 0, chain[1] ?? 0]);

    const summary = await runIngestion({ clientId: fx.clientId });

    expect(summary.failures).toEqual([]);
    expect((await rowByExternalId(chain[0] ?? 0)).status).toBe(AdStatus.ARCHIVED);
    expect((await rowByExternalId(chain[1] ?? 0)).status).toBe(AdStatus.ARCHIVED);
  });
});
