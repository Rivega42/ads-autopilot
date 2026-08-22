import { AdStatus, ModerationStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resetDatabase } from './support/database.js';
import { createDirectApiMock, type DirectApiMock } from './support/moderation-direct-mock.js';
import {
  ageAd,
  createBarrier,
  createModelStub,
  seedModerationClient,
  type ModelStub,
  type SeededClient,
} from './support/moderation-seed.js';
import { createTelegramMock, type TelegramMock } from './support/telegram-mock.js';

import { setMessenger } from '@/approval/index.js';
import { bootstrapChannels } from '@/channels/bootstrap.js';
import { buildContext, getAdapter } from '@/channels/registry.js';
import type { ChannelContext } from '@/channels/types.js';
import { resetYandexRuntimeState } from '@/clients/yandex-direct/http.js';
import { prisma } from '@/db/prisma.js';
import {
  MAX_MODERATION_RETRIES,
  repairBackoffKey,
  repairRejectedAd,
  resolveDeps,
  PREVIEW_SCOPE,
  REPAIR_BACKOFF_MINUTES,
  REWRITE_CALLS,
  REWRITING_STALE_MINUTES,
  runModerationCheck,
  type RepairContext,
} from '@/moderation/index.js';

/**
 * Сквозной прогон AI-Модератора на живом Postgres (TZ §13.4).
 *
 * Модуль чинили пятью точечными правками — потерянный внешний id, воскрешение
 * погашенного баннера, тупик на занятом уникальном ключе, строки, пропавшие из
 * кабинета, и вечный `REWRITING`, — и ни разу не прогоняли путь целиком. Здесь
 * проверяется именно связка: отказ площадки → категория → переписывание → отправка
 * → новый вердикт, и что предохранители держатся вместе, а не поодиночке.
 *
 * Канал этого файла — Директ: у него правка текста происходит на месте, и на нём
 * видно поведение счётчика попыток в чистом виде. Замена баннера VK, где `updateAdText`
 * создаёт новый объект, живёт в `moderation-vk.e2e.ts`.
 *
 * Наружу не уходит ничего: HTTP Директа перехвачен msw с `onUnhandledRequest: 'error'`,
 * транспорт Telegram подменён, оба вызова модели заменены детерминированной
 * подстановкой (CLAUDE.md §5). Живая только наша БД — мокать её запрещено.
 *
 * Каждый сценарий — свой клиент со своей кампанией: прогон обходит кабинеты целиком,
 * и общий клиент складывал бы в одну сводку чужие объявления.
 */

const TOKEN = 'moderation-e2e-direct-token';

const IDS = {
  happy: { campaign: 4001, group: 4101, rejected: 5101, ok: 5102 },
  stubborn: { campaign: 4002, group: 4102, rejected: 5201 },
  paused: { campaign: 4003, group: 4103, suspended: 5301, ok: 5302 },
  race: { campaign: 4004, group: 4104, rejected: 5401 },
  stale: { campaign: 4005, group: 4105, stuck: 5501, fresh: 5502 },
  silent: { campaign: 4006, group: 4106, rejected: 5601 },
  unfixable: { campaign: 4007, group: 4107, rejected: 5701 },
  dry: { campaign: 4008, group: 4108, rejected: 5801 },
} as const;

const REJECTION = 'Превосходная степень без подтверждения: «самые лучшие»';

/**
 * Вариант, который не проходит собственную проверку: превосходная степень остаётся
 * на месте. Такой текст в кабинет уходить не имеет права — он не прошёл ровно те же
 * правила, что и новое объявление.
 */
function badVariant(n: number): { title: string; text: string } {
  return { title: `Самые лучшие ворота ${n}`, text: `Самое лучшее предложение ${n}` };
}

/** Тексты в пределах лимитов Директа (33/30/81) и мимо всех лексических детекторов. */
function variant(n: number): { title: string; text: string } {
  return {
    title: `Окна от производителя ${n}`,
    text: `Замер и монтаж за один день. Договор и гарантия два года. Вариант ${n}.`,
  };
}

let direct: DirectApiMock;
let telegram: TelegramMock;
let happy: SeededClient;
let stubborn: SeededClient;
let paused: SeededClient;
let race: SeededClient;
let stale: SeededClient;
let silent: SeededClient;
let unfixable: SeededClient;
let dry: SeededClient;

type AdSeeds = Parameters<typeof seedModerationClient>[0]['groups'][number]['ads'];

function seed(
  tgUserId: bigint,
  name: string,
  ids: { campaign: number; group: number },
  ads: AdSeeds,
): Promise<SeededClient> {
  return seedModerationClient({
    tgUserId,
    name,
    provider: 'YANDEX_DIRECT',
    credentials: { accessToken: TOKEN, refreshToken: 'e2e-refresh' },
    campaignExternalId: String(ids.campaign),
    campaignName: name,
    groups: [{ externalId: String(ids.group), name: 'Основная группа', ads }],
  });
}

/** Отметки предпросмотра этого объявления: ключи отступа лежат в той же таблице. */
function previewKeyCount(adId: string): Promise<number> {
  return prisma.idempotencyKey.count({ where: { entityId: adId, scope: PREVIEW_SCOPE } });
}

function textsSentTo(chatId: string): string[] {
  return telegram.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
}

function stub(over: Partial<Parameters<typeof createModelStub>[0]> = {}): ModelStub {
  return createModelStub({ variant, ...over });
}

describe('AI-Модератор: отказ площадки → переписывание → новый вердикт', () => {
  beforeAll(async () => {
    await resetDatabase();
    resetYandexRuntimeState();
    bootstrapChannels();

    direct = createDirectApiMock({
      token: TOKEN,
      // Страница в одно объявление: пагинация обязана работать, а не помещаться
      // в один ответ. Кабинет с одной страницей молча прятал бы обрыв дочитывания.
      pageCap: 1,
      ads: [
        {
          id: IDS.happy.rejected,
          adGroupId: IDS.happy.group,
          campaignId: IDS.happy.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие окна',
          text: 'Самое лучшее предложение на рынке пластиковых окон',
        },
        {
          id: IDS.happy.ok,
          adGroupId: IDS.happy.group,
          campaignId: IDS.happy.campaign,
          title: 'Окна с монтажом',
          text: 'Замер бесплатно, монтаж за день',
        },
        {
          id: IDS.stubborn.rejected,
          adGroupId: IDS.stubborn.group,
          campaignId: IDS.stubborn.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие двери',
          text: 'Самое лучшее предложение на рынке дверей',
          // Площадка отклоняет каждый переписанный вариант — ради этого сценарий и нужен.
          afterUpdate: 'reject',
        },
        {
          id: IDS.paused.suspended,
          adGroupId: IDS.paused.group,
          campaignId: IDS.paused.campaign,
          // Выключено нами: проигравший вариант A/B или пауза оптимизатора.
          state: 'SUSPENDED',
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие потолки',
          text: 'Самое лучшее предложение на рынке потолков',
        },
        {
          id: IDS.paused.ok,
          adGroupId: IDS.paused.group,
          campaignId: IDS.paused.campaign,
          title: 'Потолки под ключ',
          text: 'Монтаж за один день, договор',
        },
        {
          id: IDS.race.rejected,
          adGroupId: IDS.race.group,
          campaignId: IDS.race.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие полы',
          text: 'Самое лучшее предложение на рынке полов',
        },
        {
          id: IDS.stale.stuck,
          adGroupId: IDS.stale.group,
          campaignId: IDS.stale.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие лестницы',
          text: 'Самое лучшее предложение на рынке лестниц',
        },
        {
          id: IDS.stale.fresh,
          adGroupId: IDS.stale.group,
          campaignId: IDS.stale.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие перила',
          text: 'Самое лучшее предложение на рынке перил',
        },
        {
          id: IDS.silent.rejected,
          adGroupId: IDS.silent.group,
          campaignId: IDS.silent.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие ворота',
          text: 'Самое лучшее предложение на рынке ворот',
        },
        {
          id: IDS.unfixable.rejected,
          adGroupId: IDS.unfixable.group,
          campaignId: IDS.unfixable.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие заборы',
          text: 'Самое лучшее предложение на рынке заборов',
        },
        {
          id: IDS.dry.rejected,
          adGroupId: IDS.dry.group,
          campaignId: IDS.dry.campaign,
          status: 'REJECTED',
          statusClarification: REJECTION,
          title: 'Самые лучшие навесы',
          text: 'Самое лучшее предложение на рынке навесов',
        },
      ],
    });
    // 'error' обязателен: без него незамоканный запрос ушёл бы в настоящий Директ.
    direct.server.listen({ onUnhandledRequest: 'error' });

    telegram = createTelegramMock();
    setMessenger(telegram);

    happy = await seed(770100001n, 'ООО «Окна»', IDS.happy, [
      {
        alias: 'rejected',
        externalId: String(IDS.happy.rejected),
        title: 'Самые лучшие окна',
        body: 'Самое лучшее предложение на рынке пластиковых окон',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
      },
      {
        alias: 'ok',
        externalId: String(IDS.happy.ok),
        title: 'Окна с монтажом',
        body: 'Замер бесплатно, монтаж за день',
      },
    ]);

    stubborn = await seed(770100002n, 'ООО «Двери»', IDS.stubborn, [
      {
        alias: 'rejected',
        externalId: String(IDS.stubborn.rejected),
        title: 'Самые лучшие двери',
        body: 'Самое лучшее предложение на рынке дверей',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
      },
    ]);

    paused = await seed(770100003n, 'ООО «Потолки»', IDS.paused, [
      {
        alias: 'suspended',
        externalId: String(IDS.paused.suspended),
        title: 'Самые лучшие потолки',
        body: 'Самое лучшее предложение на рынке потолков',
        // Мы сами его и выключили — на площадке это тоже видно.
        status: AdStatus.PAUSED,
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
        moderationRetries: 1,
      },
      {
        alias: 'ok',
        externalId: String(IDS.paused.ok),
        title: 'Потолки под ключ',
        body: 'Монтаж за один день, договор',
      },
    ]);

    race = await seed(770100004n, 'ООО «Полы»', IDS.race, [
      {
        alias: 'rejected',
        externalId: String(IDS.race.rejected),
        title: 'Самые лучшие полы',
        body: 'Самое лучшее предложение на рынке полов',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
      },
    ]);

    stale = await seed(770100005n, 'ООО «Лестницы»', IDS.stale, [
      {
        alias: 'stuck',
        externalId: String(IDS.stale.stuck),
        title: 'Самые лучшие лестницы',
        body: 'Самое лучшее предложение на рынке лестниц',
        // Захват, переживший смерть процесса: попытка потрачена, статус остался.
        moderationStatus: ModerationStatus.REWRITING,
        moderationReason: REJECTION,
        moderationRetries: 1,
      },
      {
        alias: 'fresh',
        externalId: String(IDS.stale.fresh),
        title: 'Самые лучшие перила',
        body: 'Самое лучшее предложение на рынке перил',
        // Живой захват соседнего прогона: трогать его нельзя.
        moderationStatus: ModerationStatus.REWRITING,
        moderationReason: REJECTION,
        moderationRetries: 1,
      },
    ]);

    silent = await seed(770100006n, 'ООО «Ворота»', IDS.silent, [
      {
        alias: 'rejected',
        externalId: String(IDS.silent.rejected),
        title: 'Самые лучшие ворота',
        body: 'Самое лучшее предложение на рынке ворот',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
      },
    ]);

    unfixable = await seed(770100007n, 'ООО «Заборы»', IDS.unfixable, [
      {
        alias: 'rejected',
        externalId: String(IDS.unfixable.rejected),
        title: 'Самые лучшие заборы',
        body: 'Самое лучшее предложение на рынке заборов',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
      },
    ]);

    dry = await seed(770100008n, 'ООО «Навесы»', IDS.dry, [
      {
        alias: 'rejected',
        externalId: String(IDS.dry.rejected),
        title: 'Самые лучшие навесы',
        body: 'Самое лучшее предложение на рынке навесов',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: REJECTION,
      },
    ]);
  });

  afterAll(async () => {
    direct?.server.close();
    setMessenger(null);
    await prisma.$disconnect();
  });

  it('счастливый путь: отказ разобран, текст переписан и отправлен, попытка засчитана', async () => {
    const model = stub();

    const summary = await runModerationCheck({
      clientId: happy.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      targets: 1,
      ok: 1,
      adsPolled: 2,
      // Вердикт кабинета совпал с тем, что уже лежит в строках: писать нечего.
      statusUpdated: 0,
      reclaimed: 0,
      missing: 0,
      rejected: 1,
      rewritten: 1,
      planned: 0,
      escalated: 0,
      skipped: 0,
      deferred: 0,
    });
    expect(summary.failures).toEqual([]);
    expect(model.classifyCalls).toBe(1);
    expect(model.rewriteCalls).toBe(1);

    // Текст доехал до площадки, а не остался записью в журнале.
    expect(direct.updated).toEqual([IDS.happy.rejected]);
    const remote = direct.adById(IDS.happy.rejected);
    expect(remote).toMatchObject({ title: variant(1).title, text: variant(1).text });
    // Правка вернула объявление на модерацию — это и есть «отправлено заново».
    expect(remote?.status).toBe('MODERATION');

    const row = await prisma.ad.findUniqueOrThrow({ where: { id: happy.adIds['rejected'] ?? '' } });
    expect(row).toMatchObject({
      title: variant(1).title,
      body: variant(1).text,
      externalId: String(IDS.happy.rejected),
      moderationStatus: ModerationStatus.PENDING,
      moderationReason: null,
      moderationRetries: 1,
    });
    // Отпечаток варианта обязан смениться вместе с текстом: по нему A/B складывает показы.
    expect(row.llmVariant).not.toBeNull();

    const log = await prisma.changeLog.findMany({ where: { entityId: row.id } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      action: 'moderation_rewrite',
      entityType: 'AD',
      campaignId: happy.campaignId,
      actor: 'AI',
      provider: 'YANDEX_DIRECT',
    });
    expect(log[0]?.newValue).toMatchObject({
      title: variant(1).title,
      text: variant(1).text,
      category: 'superlative',
      retries: 1,
    });
    // Директ правит объявление на месте — подмены внешнего id тут быть не должно.
    expect(log[0]?.newValue).not.toHaveProperty('externalIdBefore');
    expect(log[0]?.newValue).not.toHaveProperty('externalIdAfter');

    // Соседнее одобренное объявление не тронуто ничем.
    expect(direct.adById(IDS.happy.ok)?.updates).toBe(0);
    expect(textsSentTo(happy.chatId)).toEqual([]);
  });

  it('следующий опрос видит новый вердикт и обнуляет счётчик только на одобрении', async () => {
    const model = stub();

    // Пока объявление на проверке, вердикта нет — и счётчик обязан остаться прежним.
    const pending = await runModerationCheck({
      clientId: happy.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });
    expect(pending).toMatchObject({ adsPolled: 2, statusUpdated: 0, rejected: 0, rewritten: 0 });
    expect(model.classifyCalls).toBe(0);
    const stillPending = await prisma.ad.findUniqueOrThrow({
      where: { id: happy.adIds['rejected'] ?? '' },
    });
    expect(stillPending.moderationRetries).toBe(1);

    direct.setVerdict(IDS.happy.rejected, 'ACCEPTED', null);

    const accepted = await runModerationCheck({
      clientId: happy.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });
    expect(accepted).toMatchObject({ adsPolled: 2, statusUpdated: 1, rejected: 0, rewritten: 0 });

    const row = await prisma.ad.findUniqueOrThrow({ where: { id: happy.adIds['rejected'] ?? '' } });
    expect(row).toMatchObject({
      moderationStatus: ModerationStatus.APPROVED,
      moderationReason: null,
      // Площадка приняла — прошлые отказы больше не в счёт.
      moderationRetries: 0,
    });
    // Ни одного лишнего обращения к площадке за текстом: чинить нечего.
    expect(direct.updated).toEqual([IDS.happy.rejected]);
    expect(textsSentTo(happy.chatId)).toEqual([]);
  });

  it('три отказа подряд тратят три попытки и ни одной больше', async () => {
    const model = stub();
    const adId = stubborn.adIds['rejected'] ?? '';

    for (const attempt of [1, 2, 3]) {
      const summary = await runModerationCheck({
        clientId: stubborn.clientId,
        runClassify: model.classify,
        runRewrite: model.rewrite,
      });
      expect({ attempt, ...summary }).toMatchObject({
        attempt,
        rejected: 1,
        rewritten: 1,
        escalated: 0,
        skipped: 0,
      });
      const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
      expect(row.moderationRetries).toBe(attempt);
    }

    expect(model.rewriteCalls).toBe(MAX_MODERATION_RETRIES);
    expect(direct.adById(IDS.stubborn.rejected)?.updates).toBe(MAX_MODERATION_RETRIES);
    // Каждый следующий вариант отличается от прошлого: повтор отклонённого текста
    // площадка получить не должна.
    expect(direct.adById(IDS.stubborn.rejected)?.title).toBe(variant(3).title);
    expect(textsSentTo(stubborn.chatId)).toEqual([]);
  });

  it('после трёх отказов письмо уходит человеку ровно один раз', async () => {
    const model = stub();
    const adId = stubborn.adIds['rejected'] ?? '';

    const escalating = await runModerationCheck({
      clientId: stubborn.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });
    expect(escalating).toMatchObject({ rejected: 1, rewritten: 0, escalated: 1, skipped: 0 });
    // Ни классификации, ни генерации: исчерпанные попытки проверяются до вызовов модели.
    expect(model.classifyCalls).toBe(0);
    expect(model.rewriteCalls).toBe(0);

    const letters = textsSentTo(stubborn.chatId);
    expect(letters).toHaveLength(1);
    const letter = letters[0] ?? '';
    expect(letter).toContain('🚫 Модерация: нужен человек');
    expect(letter).toContain(`Клиент: ${stubborn.clientName}`);
    expect(letter).toContain('Канал: YANDEX_DIRECT');
    expect(letter).toContain(`Кампания: ${stubborn.campaignName}`);
    expect(letter).toContain(`Объявление: ${IDS.stubborn.rejected} (внутренний id ${adId})`);
    expect(letter).toContain(`Попыток переписать: ${MAX_MODERATION_RETRIES}`);
    expect(letter).toContain(
      'Почему остановились: три переписанных варианта подряд получили отказ',
    );
    // Дословная причина площадки — без неё человек не поймёт, что чинить.
    expect(letter).toContain('Отказ №3');
    // Последний вариант текста, который увидела площадка.
    expect(letter).toContain(`1: ${variant(3).title}`);
    expect(letter).toContain('переписывали 3 раза, площадка отклонила каждый вариант');
    expect(letter).toContain('Объявление остановлено до решения человека');

    const escalation = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: adId, action: 'moderation_escalated' },
    });
    expect(escalation.newValue).toMatchObject({
      cause: 'retries_exhausted',
      retries: MAX_MODERATION_RETRIES,
      parkedAt: MAX_MODERATION_RETRIES,
    });
  });

  it('отданное человеку объявление не переписывается дальше и не шлёт второе письмо', async () => {
    const model = stub();
    const adId = stubborn.adIds['rejected'] ?? '';
    const updatesBefore = direct.adById(IDS.stubborn.rejected)?.updates;

    for (const cycle of [1, 2]) {
      const summary = await runModerationCheck({
        clientId: stubborn.clientId,
        runClassify: model.classify,
        runRewrite: model.rewrite,
      });
      expect({ cycle, ...summary }).toMatchObject({
        cycle,
        rejected: 1,
        rewritten: 0,
        escalated: 0,
        // Уже отдано человеку: ни модели, ни кабинета, ни второго письма.
        skipped: 1,
      });
    }

    expect(model.classifyCalls).toBe(0);
    expect(model.rewriteCalls).toBe(0);
    expect(direct.adById(IDS.stubborn.rejected)?.updates).toBe(updatesBefore);
    expect(direct.adById(IDS.stubborn.rejected)?.title).toBe(variant(3).title);
    expect(textsSentTo(stubborn.chatId)).toHaveLength(1);
    expect(
      await prisma.changeLog.count({ where: { entityId: adId, action: 'moderation_escalated' } }),
    ).toBe(1);
    expect((await prisma.ad.findUniqueOrThrow({ where: { id: adId } })).moderationRetries).toBe(
      MAX_MODERATION_RETRIES,
    );
  });

  it('объявление, которое выключили мы сами, в переписывание не попадает', async () => {
    const model = stub();

    const summary = await runModerationCheck({
      clientId: paused.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      adsPolled: 2,
      rejected: 0,
      rewritten: 0,
      escalated: 0,
      missing: 0,
      skipped: 0,
    });
    // Ни вызова модели, ни правки в кабинете: выключенное никому не показывается,
    // а починка стоит двух вызовов модели и нового объявления.
    expect(model.classifyCalls).toBe(0);
    expect(direct.adById(IDS.paused.suspended)?.updates).toBe(0);
    expect(textsSentTo(paused.chatId)).toEqual([]);

    const row = await prisma.ad.findUniqueOrThrow({
      where: { id: paused.adIds['suspended'] ?? '' },
    });
    // Вердикт площадки в строку записывается — не записывается только починка.
    expect(row).toMatchObject({
      status: AdStatus.PAUSED,
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: 1,
    });
  });

  it('починка отказывается работать с выключенным объявлением и в обход опроса', async () => {
    // Второй конец той же дыры: между опросом и починкой строку мог выключить синк.
    // Тогда решение уже принято кабинетом, и включать объявление обратно мы не вправе.
    const model = stub();
    const deps = resolveDeps({ runClassify: model.classify, runRewrite: model.rewrite });
    const target = { clientId: paused.clientId, provider: 'YANDEX_DIRECT' as const };
    const rc: RepairContext = {
      deps,
      target,
      ctx: await buildContext(target.clientId, target.provider),
      adapter: getAdapter(target.provider),
      client: { name: paused.clientName, chatId: paused.chatId },
    };
    const callsBefore = direct.calls.length;

    const outcome = await repairRejectedAd(rc, {
      id: paused.adIds['suspended'] ?? '',
      externalId: String(IDS.paused.suspended),
      campaignId: paused.campaignId,
      campaignName: paused.campaignName,
      status: AdStatus.PAUSED,
      retries: 1,
      reason: REJECTION,
      ad: { title: 'Самые лучшие потолки', text: 'Самое лучшее предложение на рынке потолков' },
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'ad is not running' });
    expect(model.classifyCalls).toBe(0);
    expect(direct.calls).toHaveLength(callsBefore);
  });

  it('два наложившихся прогона отправляют один текст, а не два', async () => {
    const adId = race.adIds['rejected'] ?? '';
    // Барьер держит оба прогона на ответе модели: без него быстрый успевает
    // закончиться раньше, чем второй дойдёт до захвата строки, и наложения нет.
    const gate = createBarrier(2);
    const first = stub({ beforeRewrite: gate });
    const second = stub({ beforeRewrite: gate });

    const [a, b] = await Promise.all([
      runModerationCheck({
        clientId: race.clientId,
        runClassify: first.classify,
        runRewrite: first.rewrite,
      }),
      runModerationCheck({
        clientId: race.clientId,
        runClassify: second.classify,
        runRewrite: second.rewrite,
      }),
    ]);

    expect(a.failures).toEqual([]);
    expect(b.failures).toEqual([]);
    // Оба увидели отказ и оба сходили в модель — разошлись они на захвате строки.
    expect(a.rejected + b.rejected).toBe(2);
    expect(first.rewriteCalls + second.rewriteCalls).toBe(2);
    expect(a.rewritten + b.rewritten).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);

    // Главное: в кабинет ушёл ровно один текст.
    expect(direct.updated.filter((id) => id === IDS.race.rejected)).toHaveLength(1);
    expect(direct.adById(IDS.race.rejected)?.updates).toBe(1);
    expect(
      await prisma.changeLog.count({ where: { entityId: adId, action: 'moderation_rewrite' } }),
    ).toBe(1);
    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row).toMatchObject({
      moderationStatus: ModerationStatus.PENDING,
      // Попытка потрачена один раз, а не дважды.
      moderationRetries: 1,
    });
  });

  it('зависший захват снимается, живой — нет', async () => {
    const model = stub();
    const stuckId = stale.adIds['stuck'] ?? '';
    const freshId = stale.adIds['fresh'] ?? '';
    // Процесс, умерший между захватом и отправкой, оставил строку в `REWRITING`
    // старше срока захвата. Без снятия захвата объявление выключено из модерации
    // навсегда: опрос такие строки пропускает безусловно. Возраст — от самого срока:
    // число здесь разъехалось бы с расписанием при первой же его правке, и сценарий
    // либо перестал бы проверять снятие, либо покраснел бы на ровном месте.
    await ageAd(stuckId, REWRITING_STALE_MINUTES + 1);

    const summary = await runModerationCheck({
      clientId: stale.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({
      adsPolled: 2,
      reclaimed: 1,
      rejected: 1,
      rewritten: 1,
      escalated: 0,
    });

    const stuck = await prisma.ad.findUniqueOrThrow({ where: { id: stuckId } });
    expect(stuck).toMatchObject({
      moderationStatus: ModerationStatus.PENDING,
      // Попытка, потраченная умершим прогоном, не возвращается: текст мог уйти
      // в кабинет ровно перед падением.
      moderationRetries: 2,
      title: variant(1).title,
    });

    // Соседний захват свежий — это работа другого прогона, и трогать её нельзя.
    const fresh = await prisma.ad.findUniqueOrThrow({ where: { id: freshId } });
    expect(fresh).toMatchObject({
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: 1,
      title: 'Самые лучшие перила',
    });
    expect(direct.updated.filter((id) => id === IDS.stale.fresh)).toEqual([]);
    expect(direct.updated.filter((id) => id === IDS.stale.stuck)).toHaveLength(1);
  });

  it('не собранный вариант в кабинет не уходит, а объявление паркуется на потолке', async () => {
    const model = stub({ variant: badVariant });
    const adId = unfixable.adIds['rejected'] ?? '';

    const summary = await runModerationCheck({
      clientId: unfixable.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({ rejected: 1, rewritten: 0, escalated: 1, skipped: 0 });
    // Модель звали столько раз, сколько разрешено за один прогон, и ни разу больше.
    expect(model.classifyCalls).toBe(1);
    expect(model.rewriteCalls).toBe(REWRITE_CALLS);
    // Последний черновик не отправляем: он не прошёл те же проверки, что и новое
    // объявление, — площадка отклонила бы его снова, потратив попытку.
    expect(direct.adById(IDS.unfixable.rejected)?.updates).toBe(0);

    const letters = textsSentTo(unfixable.chatId);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toContain(
      'Почему остановились: не удалось собрать вариант, проходящий проверки',
    );
    expect(letters[0]).toContain('Категория: superlative');
    expect(letters[0]).toContain('правило superlative-unproven');

    const escalation = await prisma.changeLog.findFirstOrThrow({
      where: { entityId: adId, action: 'moderation_escalated' },
    });
    expect(escalation.newValue).toMatchObject({
      cause: 'rewrite_failed',
      retries: 0,
      // Парковка — перевод счётчика на потолок. Без неё объявление, которое нельзя
      // переписать, каждые полчаса заново оплачивало бы классификацию и три генерации.
      parkedAt: MAX_MODERATION_RETRIES,
    });

    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row).toMatchObject({
      title: 'Самые лучшие заборы',
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: MAX_MODERATION_RETRIES,
    });
  });

  it('запаркованное объявление больше не платит за модель ни разу', async () => {
    const model = stub({ variant: badVariant });

    for (const cycle of [1, 2]) {
      const summary = await runModerationCheck({
        clientId: unfixable.clientId,
        runClassify: model.classify,
        runRewrite: model.rewrite,
      });
      expect({ cycle, ...summary }).toMatchObject({
        cycle,
        rejected: 1,
        rewritten: 0,
        escalated: 0,
        skipped: 1,
      });
    }

    // Тут и была цена дефекта: 192 вызова модели в сутки на одно застрявшее объявление.
    expect(model.classifyCalls).toBe(0);
    expect(model.rewriteCalls).toBe(0);
    // Письмо «попытки кончились» дублирует уже отправленное «не смогли переписать»:
    // человеку нужно ровно одно из них.
    expect(textsSentTo(unfixable.chatId)).toHaveLength(1);
    expect(direct.adById(IDS.unfixable.rejected)?.updates).toBe(0);
  });

  it('dry-run показывает предпросмотр один раз и не платит за него повторно', async () => {
    /**
     * Было сломано: `repairRejectedAd` проверял `ctx.dryRun` только перед отправкой,
     * то есть классификация и генерация к этому моменту уже оплачены. Записей при
     * этом не оставалось никаких — ни счётчика, ни журнала, ни следа эскалации, —
     * поэтому следующий тик `check-moderation` (каждые полчаса) видел тот же отказ и
     * платил заново: 96 оплаченных вызовов в сутки на одно объявление за один и тот
     * же ответ. `DRY_RUN` по умолчанию `true`, то есть это было поведение «из коробки».
     *
     * Теперь отпечаток входа модели — объявление, причина отказа, номер попытки —
     * резервируется в `IdempotencyKey` до классификации. Счётчик попыток по-прежнему
     * не тратится: предохранитель ничего не меняет ни в кабинете, ни в наших строках.
     */
    const model = stub();
    const adId = dry.adIds['rejected'] ?? '';
    const planning = {
      clientId: dry.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
      // Предохранитель снят на весь процесс (см. `tests/e2e/vitest.config.ts`),
      // поэтому dry-run приходит сюда подменой контекста, а не переменной окружения.
      contextFor: async (clientId: string): Promise<ChannelContext> => ({
        ...(await buildContext(clientId, 'YANDEX_DIRECT')),
        dryRun: true,
      }),
    };

    const first = await runModerationCheck(planning);
    expect(first).toMatchObject({ rejected: 1, planned: 1, rewritten: 0, escalated: 0 });
    // Предохранитель работает: ни правки в кабинете, ни записи в наших строках.
    expect(direct.adById(IDS.dry.rejected)?.updates).toBe(0);
    expect(await prisma.ad.findUniqueOrThrow({ where: { id: adId } })).toMatchObject({
      title: 'Самые лучшие навесы',
      moderationStatus: ModerationStatus.REJECTED,
      moderationRetries: 0,
    });
    expect(await prisma.changeLog.count({ where: { entityId: adId } })).toBe(0);
    expect(model.classifyCalls).toBe(1);
    expect(model.rewriteCalls).toBe(1);

    const second = await runModerationCheck(planning);
    // Тот же вход — тот же ответ, платить второй раз не за что.
    expect(second).toMatchObject({ rejected: 1, planned: 0, unchanged: 1 });
    expect(model.classifyCalls).toBe(1);
    expect(model.rewriteCalls).toBe(1);
    // Счётчик попыток так и не тронут: он тратится только на реальную отправку.
    expect(await prisma.ad.findUniqueOrThrow({ where: { id: adId } })).toMatchObject({
      moderationRetries: 0,
    });

    // Новая причина отказа — новый вход: за него платим, и это правильно.
    direct.setVerdict(IDS.dry.rejected, 'REJECTED', 'Нет документа на рекламируемый товар');

    const third = await runModerationCheck(planning);
    expect(third).toMatchObject({ rejected: 1, planned: 1, unchanged: 0 });
    expect(model.classifyCalls).toBe(2);
    expect(model.rewriteCalls).toBe(2);
  });

  it('упавшая модель не выключает объявление из починки на срок ключа', async () => {
    /**
     * Отметка о предпросмотре живёт 30 дней и резервируется до классификации, то есть
     * до первого платного вызова. Разовый отказ провайдера LLM оставлял её занятой:
     * провайдер поднялся, а прогон отвечает `unchanged` — «показывать нечего» — и так
     * до истечения ключа. Заметить это по сводке нельзя: ненулевой `unchanged` при
     * `DRY_RUN` документирован как норма, а `DRY_RUN` по умолчанию `true`.
     *
     * Отступ после отказа (`REPAIR_BACKOFF_MINUTES`) этого не отменяет: он живёт
     * тиками крона, а не месяцем, виден в сводке (`backedOff`) и кончается сам.
     */
    const adId = dry.adIds['rejected'] ?? '';
    const planning = {
      clientId: dry.clientId,
      contextFor: async (clientId: string): Promise<ChannelContext> => ({
        ...(await buildContext(clientId, 'YANDEX_DIRECT')),
        dryRun: true,
      }),
    };
    // Новый вердикт — новый вход модели, а значит и новая отметка.
    direct.setVerdict(IDS.dry.rejected, 'REJECTED', 'Сравнение с конкурентом без ссылки');
    // Отметки прошлых входов этого объявления никуда не делись — считаем прирост.
    const keysBefore = await previewKeyCount(adId);

    const model = stub();
    const outage = await runModerationCheck({
      ...planning,
      runClassify: (() => Promise.reject(new Error('LLM 503'))) as typeof model.classify,
      runRewrite: model.rewrite,
    });
    expect(outage).toMatchObject({ rejected: 1, planned: 0, unchanged: 0 });
    expect(outage.failures).toHaveLength(1);
    expect(outage.failures[0]).toMatchObject({ stage: `repair:${adId}` });
    // Ключ предпросмотра отпущен: занятым он остался бы только после полученного ответа.
    expect(await previewKeyCount(adId)).toBe(keysBefore);
    // Вместо него стоит отступ: до его конца объявление уступает потолок соседям.
    expect(await prisma.idempotencyKey.count({ where: { key: repairBackoffKey(adId) } })).toBe(1);

    const stillWaiting = await runModerationCheck({
      ...planning,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });
    expect(stillWaiting).toMatchObject({ rejected: 1, planned: 0, backedOff: 1 });
    expect(model.rewriteCalls).toBe(0);

    const later = new Date(Date.now() + (REPAIR_BACKOFF_MINUTES + 1) * 60_000);
    const recovered = await runModerationCheck({
      ...planning,
      runClassify: model.classify,
      runRewrite: model.rewrite,
      now: () => later,
    });
    expect(recovered).toMatchObject({ rejected: 1, planned: 1, unchanged: 0, backedOff: 0 });
    expect(recovered.failures).toEqual([]);
    expect(model.rewriteCalls).toBe(1);
    // А вот показанный предпросмотр отметку оставляет — иначе следующий тик заплатит снова.
    expect(await previewKeyCount(adId)).toBe(keysBefore + 1);
  });

  it('пообъектная ошибка Директа не считается успешной отправкой', async () => {
    /**
     * Было сломано: `updateAdText` возвращал `applied: true` независимо от
     * содержимого `UpdateResults` — пообъектные ошибки складывались в `failed`,
     * но результат их не смотрел. Модерация верила ответу канала и записывала
     * объявление переписанным: у нас новый текст и `PENDING`, в кабинете старый
     * и `REJECTED`. Через три таких цикла человек получал разбор текстов,
     * которых площадка никогда не видела.
     *
     * Теперь полный отказ бросает, отказ виден в сводке прогона, а наша строка
     * остаётся честной — переписывания не было.
     */
    const model = stub();
    const adId = silent.adIds['rejected'] ?? '';
    direct.program({
      service: 'ads',
      method: 'update',
      body: {
        result: {
          UpdateResults: [
            {
              Id: IDS.silent.rejected,
              Errors: [{ Code: 8300, Message: 'Объявление не может быть изменено' }],
            },
          ],
        },
      },
    });

    const summary = await runModerationCheck({
      clientId: silent.clientId,
      runClassify: model.classify,
      runRewrite: model.rewrite,
    });

    expect(summary).toMatchObject({ rejected: 1, rewritten: 0, escalated: 0 });
    // Отказ обязан быть виден: молчаливый успех — то, из-за чего дефект и жил.
    expect(summary.failures).not.toEqual([]);

    // Кабинет не изменился ни на символ.
    const remote = direct.adById(IDS.silent.rejected);
    expect(remote).toMatchObject({ title: 'Самые лучшие ворота', status: 'REJECTED', updates: 0 });

    // И наша строка тоже: объявление не переписано, текст прежний.
    const row = await prisma.ad.findUniqueOrThrow({ where: { id: adId } });
    expect(row.title).toBe('Самые лучшие ворота');
    expect(row.moderationStatus).toBe(ModerationStatus.REJECTED);
    expect(
      await prisma.changeLog.count({ where: { entityId: adId, action: 'moderation_rewrite' } }),
    ).toBe(0);
  });
});
