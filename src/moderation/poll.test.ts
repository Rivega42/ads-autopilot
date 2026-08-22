import { AdStatus, ModerationStatus, Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import { FakeDb } from '@/moderation/__tests__/fake-db.js';
import { channelContext, fakeAdapter, remoteAd } from '@/moderation/__tests__/fakes.js';
import {
  MAX_MISSING_ADS_PER_TARGET,
  pollAdModeration,
  REWRITING_APPLY_BUDGET_MINUTES,
  REWRITING_STALE_MINUTES,
  REWRITING_STALE_MS,
} from '@/moderation/poll.js';
import { MODERATION_TICK_MINUTES } from '@/moderation/tick.js';
import { CRON_SCHEDULE, cronIntervalMinutes, QUEUE_NAMES } from '@/scheduler/schedule.js';

const TARGET = { clientId: 'cl1', provider: Provider.YANDEX_DIRECT };

let db: FakeDb;

beforeEach(() => {
  db = new FakeDb();
  db.seedClient({ id: 'cl1' });
  db.seedCampaign({ id: 'c1', clientId: 'cl1', provider: Provider.YANDEX_DIRECT, name: 'Поиск' });
  db.seedAdGroup({ id: 'g1', campaignId: 'c1', externalId: 'ext-1' });
});

/** Захват, чей срок заведомо вышел. Отсчёт от самого срока: числу здесь взяться неоткуда. */
function staleAt(): Date {
  return new Date(Date.now() - REWRITING_STALE_MS - 60_000);
}

function poll(ads: Parameters<typeof fakeAdapter>[0]['ads']) {
  const adapter = fakeAdapter({ channel: Provider.YANDEX_DIRECT, ads });
  return pollAdModeration(db.asDb(), TARGET, channelContext(false), adapter);
}

describe('pollAdModeration', () => {
  it('без групп в кабинет не ходит', async () => {
    const empty = new FakeDb();
    empty.seedClient({ id: 'cl1' });
    const adapter = fakeAdapter({
      channel: Provider.YANDEX_DIRECT,
      listAds: async () => {
        throw new Error('listAds не должен вызываться без групп');
      },
    });

    const result = await pollAdModeration(empty.asDb(), TARGET, channelContext(false), adapter);
    expect(result).toEqual({
      polled: 0,
      updated: 0,
      orphaned: 0,
      reclaimed: 0,
      rejected: [],
      missing: [],
    });
  });

  it('считает чужие объявления сиротами, а не своими', async () => {
    db.seedAd({ id: 'ad1', adGroupId: 'g1', externalId: 'a1' });
    // Кабинет вернул больше, чем спрашивали: так бывает при рассинхроне групп.
    const adapter = fakeAdapter({
      channel: Provider.YANDEX_DIRECT,
      listAds: async () => [
        remoteAd({ externalId: 'a1', adGroupExternalId: 'ext-1' }),
        // Группы нет в нашей БД — её заведёт ingestion.
        remoteAd({ externalId: 'a9', adGroupExternalId: 'ext-unknown' }),
        // Группа есть, а объявления в нашей БД нет.
        remoteAd({ externalId: 'a8', adGroupExternalId: 'ext-1' }),
      ],
    });

    const result = await pollAdModeration(db.asDb(), TARGET, channelContext(false), adapter);

    expect(result.polled).toBe(1);
    expect(result.orphaned).toBe(2);
  });

  it('изменившаяся причина отказа обновляет строку', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.REJECTED,
      moderationReason: 'Старая причина',
    });

    const result = await poll([
      remoteAd({
        externalId: 'a1',
        adGroupExternalId: 'ext-1',
        moderationReason: 'Новая причина',
      }),
    ]);

    expect(result.updated).toBe(1);
    expect(db.adOf('ad1').moderationReason).toBe('Новая причина');
    expect(result.rejected[0]).toMatchObject({
      id: 'ad1',
      campaignName: 'Поиск',
      reason: 'Новая причина',
    });
  });

  it('совпавший статус не порождает записи', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.APPROVED,
      moderationReason: null,
    });

    const result = await poll([
      remoteAd({
        externalId: 'a1',
        adGroupExternalId: 'ext-1',
        moderationStatus: 'ACCEPTED',
        moderationReason: undefined,
      }),
    ]);

    expect(result).toMatchObject({ polled: 1, updated: 0, rejected: [] });
  });

  it('свежий REWRITING не трогает: там работает соседний прогон', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: 1,
    });

    const result = await poll([remoteAd({ externalId: 'a1', adGroupExternalId: 'ext-1' })]);

    expect(result).toMatchObject({ polled: 1, reclaimed: 0, updated: 0, rejected: [] });
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REWRITING);
  });

  it('зависший REWRITING возвращает в работу: иначе объявление выключено навсегда', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: 1,
      // Процесс убит между захватом строки и отправкой текста, срок захвата вышел.
      updatedAt: staleAt(),
    });

    const result = await poll([remoteAd({ externalId: 'a1', adGroupExternalId: 'ext-1' })]);

    expect(result.reclaimed).toBe(1);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REJECTED);
    // Попытка остаётся потраченной: текст мог уйти в кабинет прямо перед падением.
    expect(db.adOf('ad1').moderationRetries).toBe(1);
    expect(result.rejected).toHaveLength(1);
  });

  it('зависший REWRITING на принятом объявлении просто выравнивается по кабинету', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: 1,
      updatedAt: staleAt(),
    });

    const result = await poll([
      remoteAd({ externalId: 'a1', adGroupExternalId: 'ext-1', moderationStatus: 'ACCEPTED' }),
    ]);

    expect(result.reclaimed).toBe(1);
    expect(result.rejected).toEqual([]);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.APPROVED);
    expect(db.adOf('ad1').moderationRetries).toBe(0);
  });

  it('снимает зависший REWRITING с объявления, которого нет в листинге', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'снесён-при-замене',
      moderationStatus: ModerationStatus.REWRITING,
      moderationRetries: 1,
      updatedAt: staleAt(),
    });

    // Кабинет этот баннер уже не отдаёт: у VK правка текста удаляет старый баннер, и
    // процесс умер до записи нового id. Внутри цикла по объявлениям кабинета такую
    // строку не поднять вообще ничем — она навсегда выключена из модерации.
    const result = await poll([]);

    expect(result.reclaimed).toBe(1);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REJECTED);
    expect(db.adOf('ad1').moderationRetries).toBe(1);
  });

  it('не отдаёт в переписывание объявление, которое не крутится', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      status: AdStatus.PAUSED,
      moderationStatus: ModerationStatus.REJECTED,
      moderationReason: 'Превосходная степень без подтверждения',
    });

    const result = await poll([remoteAd({ externalId: 'a1', adGroupExternalId: 'ext-1' })]);

    // Статус модерации сверить полезно, а вот чинить нечего: показов нет, зато
    // переписывание стоит двух вызовов модели и заводит в кабинете новый баннер.
    expect(result.polled).toBe(1);
    expect(result.rejected).toEqual([]);
  });

  /**
   * Строка, у которой потерялся внешний id: процесс умер между успешной отправкой
   * замены и записью нового id. Опрос ходит от объявлений кабинета, поэтому изнутри
   * цикла такую строку не увидеть никогда.
   */
  function seedLostAd(id: string, patch: Record<string, unknown> = {}): void {
    db.seedAd({
      id,
      adGroupId: 'g1',
      externalId: `снесён-${id}`,
      title: 'Ремонт стиральных машин',
      body: 'Мастер приедет сегодня.',
      moderationStatus: ModerationStatus.REJECTED,
      moderationReason: 'Превосходная степень без подтверждения',
      moderationRetries: 1,
      ...patch,
    });
  }

  describe('строки, которых нет в листинге', () => {
    it('находит строку с потерянным id, когда группа ответила', async () => {
      seedLostAd('ad1');
      // Живое объявление той же группы: значит ответ по группе доехал целиком.
      db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: 'a2' });

      const result = await poll([
        remoteAd({ externalId: 'a2', adGroupExternalId: 'ext-1', moderationStatus: 'ACCEPTED' }),
      ]);

      expect(result.missing).toHaveLength(1);
      expect(result.missing[0]).toMatchObject({
        id: 'ad1',
        externalId: 'снесён-ad1',
        campaignId: 'c1',
        campaignName: 'Поиск',
        retries: 1,
        reason: 'Превосходная степень без подтверждения',
        ad: { title: 'Ремонт стиральных машин', text: 'Мастер приедет сегодня.' },
      });
    });

    it('молчит про группу, из которой не приехало ни одного объявления', async () => {
      seedLostAd('ad1');

      // Пустой ответ по группе — это «до неё не доехало», а не «объявлений нет».
      const result = await poll([]);

      expect(result.missing).toEqual([]);
    });

    it('не считает пропажей строку, которую мы ни разу не переписывали', async () => {
      // Внешний id теряет только наша собственная замена текста. Если объявления нет
      // в кабинете, а попыток не было, — его удалил клиент, и это не повод звать человека.
      seedLostAd('ad1', { moderationRetries: 0, moderationStatus: ModerationStatus.APPROVED });
      db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: 'a2' });

      const result = await poll([
        remoteAd({ externalId: 'a2', adGroupExternalId: 'ext-1', moderationStatus: 'ACCEPTED' }),
      ]);

      expect(result.missing).toEqual([]);
    });

    it('не считает пропажей выключенное объявление', async () => {
      seedLostAd('ad1', { status: AdStatus.ARCHIVED });
      db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: 'a2' });

      const result = await poll([
        remoteAd({ externalId: 'a2', adGroupExternalId: 'ext-1', moderationStatus: 'ACCEPTED' }),
      ]);

      expect(result.missing).toEqual([]);
    });

    it('не считает пропажей свежий захват: замена прямо сейчас в полёте', async () => {
      seedLostAd('ad1', { moderationStatus: ModerationStatus.REWRITING });
      db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: 'a2' });

      const result = await poll([
        remoteAd({ externalId: 'a2', adGroupExternalId: 'ext-1', moderationStatus: 'ACCEPTED' }),
      ]);

      expect(result.missing).toEqual([]);
    });

    it('при слишком многих пропажах молчит: так листинг врёт, а не мы потеряли строки', async () => {
      for (let i = 0; i <= MAX_MISSING_ADS_PER_TARGET; i++) seedLostAd(`ad${i}`);
      db.seedAd({ id: 'alive', adGroupId: 'g1', externalId: 'a2' });

      const result = await poll([
        remoteAd({ externalId: 'a2', adGroupExternalId: 'ext-1', moderationStatus: 'ACCEPTED' }),
      ]);

      expect(result.missing).toEqual([]);
    });
  });

  it('берёт тексты с площадки, а не из нашей БД', async () => {
    db.seedAd({
      id: 'ad1',
      adGroupId: 'g1',
      externalId: 'a1',
      title: 'Устаревший заголовок',
      body: 'Устаревший текст',
      moderationStatus: ModerationStatus.REJECTED,
    });

    const result = await poll([
      remoteAd({
        externalId: 'a1',
        adGroupExternalId: 'ext-1',
        title: 'Актуальный заголовок',
        title2: 'Второй',
        text: 'Актуальный текст',
      }),
    ]);

    expect(result.rejected[0]?.ad).toEqual({
      title: 'Актуальный заголовок',
      title2: 'Второй',
      text: 'Актуальный текст',
    });
  });
});

describe('срок зависшего захвата', () => {
  it('следует за расписанием крона, а не записан числом рядом', () => {
    // Захват снимает сам крон `check-moderation`, и другого снимающего нет: срок,
    // не выведенный из его периода, разъезжается с расписанием молча — либо строки
    // расчищаются раньше, чем прогон успел их отработать (и два прогона берутся за
    // одно объявление), либо объявление висит выключенным из модерации дольше нужного.
    //
    // Формула повторена здесь намеренно: это спецификация срока, а не пересказ кода.
    // Сравнение с самой константой из `poll.ts` не поймало бы ровно ту регрессию, ради
    // которой тест писан, — возврат к числу, совпавшему с текущим расписанием.
    expect(REWRITING_STALE_MINUTES).toBe(
      Math.max(
        cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.checkModeration]),
        REWRITING_APPLY_BUDGET_MINUTES,
      ),
    );
    expect(MODERATION_TICK_MINUTES).toBe(
      cronIntervalMinutes(CRON_SCHEDULE[QUEUE_NAMES.checkModeration]),
    );
  });

  it('не короче периода крона: снимать захваты чаще всё равно некому', () => {
    expect(REWRITING_STALE_MINUTES).toBeGreaterThanOrEqual(MODERATION_TICK_MINUTES);
  });

  it('не короче самой долгой живой отправки — иначе два прогона возьмутся за одно объявление', () => {
    // Единственная защита от второго текста поверх первого — захват строки. Срок
    // короче отправки снимает захват с живого прогона, и защиты не остаётся.
    expect(REWRITING_STALE_MINUTES).toBeGreaterThanOrEqual(REWRITING_APPLY_BUDGET_MINUTES);
  });
});
