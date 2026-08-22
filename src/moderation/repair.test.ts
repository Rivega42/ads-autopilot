import { AdStatus, ModerationStatus, Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import type { ChannelContext } from '@/channels/types.js';
import { VkAdsAdapter } from '@/clients/vk-ads/adapter.js';
import { VK_PATHS } from '@/clients/vk-ads/entities.js';
import { RateLimitGovernor, type VkTransport } from '@/clients/vk-ads/http.js';
import { textVariantId } from '@/creatives/types.js';
import { FakeDb } from '@/moderation/__tests__/fake-db.js';
import { channelContext, fakeAdapter, queueRunner } from '@/moderation/__tests__/fakes.js';
import { resolveDeps, type ModerationDeps } from '@/moderation/deps.js';
import type { ModerationEscalation } from '@/moderation/escalate.js';
import type { RejectedAd } from '@/moderation/poll.js';
import {
  repairRejectedAd,
  ESCALATION_ACTION,
  REWRITE_ACTION,
  type RepairContext,
} from '@/moderation/repair.js';
import type { AdRewriteDraft } from '@/moderation/schema.js';
import type { RejectionClassificationDraft } from '@/moderation/schema.js';

const CLASSIFICATION: RejectionClassificationDraft = {
  category: 'superlative',
  confidence: 0.9,
  explanation: 'Превосходная степень «лучший» без подтверждения.',
  fragments: ['Лучший'],
};

const REWRITE: AdRewriteDraft = {
  title: 'Ремонт стиральных машин',
  title2: 'Выезд в день заявки',
  text: 'Мастер приедет с деталями. Диагностика перед ремонтом, договор и чек.',
  changes: 'Убрал превосходную степень.',
};

const ORIGINAL = {
  title: 'Лучший ремонт стиральных машин',
  text: 'Починим сегодня, недорого и с гарантией на работу мастера.',
};

function rejected(over: Partial<RejectedAd> = {}): RejectedAd {
  return {
    id: 'ad1',
    externalId: '9',
    campaignId: 'c1',
    campaignName: 'Поиск — ремонт',
    status: AdStatus.ACTIVE,
    retries: 0,
    reason: 'Превосходная степень без подтверждения',
    ad: ORIGINAL,
    ...over,
  };
}

let db: FakeDb;
let escalations: ModerationEscalation[];

beforeEach(() => {
  db = new FakeDb();
  escalations = [];
  db.seedClient({ id: 'cl1', name: 'Ромашка', tgUserId: 555n });
  db.seedCampaign({ id: 'c1', clientId: 'cl1', provider: Provider.YANDEX_DIRECT, name: 'Поиск' });
  db.seedAdGroup({ id: 'g1', campaignId: 'c1', externalId: '4' });
  db.seedAd({
    id: 'ad1',
    adGroupId: 'g1',
    externalId: '9',
    title: ORIGINAL.title,
    body: ORIGINAL.text,
    moderationStatus: ModerationStatus.REJECTED,
    moderationReason: 'Превосходная степень без подтверждения',
  });
});

interface Harness {
  rc: RepairContext;
  classifyCalls: unknown[];
  rewriteCalls: unknown[];
}

function harness(
  over: {
    ctx?: ChannelContext;
    adapter?: RepairContext['adapter'];
    rewrites?: readonly (AdRewriteDraft | Error)[];
    channel?: Provider;
  } = {},
): Harness {
  const classify = queueRunner<RejectionClassificationDraft>([CLASSIFICATION]);
  const rewrite = queueRunner<AdRewriteDraft>(over.rewrites ?? [REWRITE]);
  const deps: ModerationDeps = resolveDeps({
    db: db.asDb(),
    runClassify: classify.run,
    runRewrite: rewrite.run,
    escalate: async (payload) => {
      escalations.push(payload);
    },
  });

  const adapter =
    over.adapter ??
    fakeAdapter({
      channel: over.channel ?? Provider.YANDEX_DIRECT,
      updateAdText: (ctx) => ({ applied: !ctx.dryRun, plan: { action: 'Ads.update' } }),
    });

  return {
    rc: {
      deps,
      target: { clientId: 'cl1', provider: over.channel ?? Provider.YANDEX_DIRECT },
      ctx: over.ctx ?? channelContext(false),
      adapter,
      client: { name: 'Ромашка', chatId: '555' },
    },
    classifyCalls: classify.calls,
    rewriteCalls: rewrite.calls,
  };
}

describe('repairRejectedAd: штатное переписывание', () => {
  it('классифицирует, переписывает и отправляет новый текст в кабинет', async () => {
    const h = harness();

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toMatchObject({ status: 'rewritten', retries: 1 });
    expect(h.classifyCalls).toHaveLength(1);
    expect(h.rewriteCalls).toHaveLength(1);

    const sent = (h.rc.adapter as ReturnType<typeof fakeAdapter>).updates;
    expect(sent).toEqual([
      {
        adExternalId: '9',
        text: { title: REWRITE.title, title2: REWRITE.title2, text: REWRITE.text },
        dryRun: false,
      },
    ]);

    const ad = db.adOf('ad1');
    expect(ad.title).toBe(REWRITE.title);
    expect(ad.body).toBe(REWRITE.text);
    expect(ad.moderationStatus).toBe(ModerationStatus.PENDING);
    expect(ad.moderationReason).toBeNull();
    expect(ad.moderationRetries).toBe(1);
    // Отпечаток нового текста, а не метка категории: по этому полю A/B-отчёт
    // складывает показы и клики, и два разных текста не должны слиться в один вариант.
    expect(ad.llmVariant).toBe(
      textVariantId({ title: REWRITE.title, title2: REWRITE.title2, text: REWRITE.text }),
    );
    expect(ad.llmVariant).not.toBe(
      textVariantId({ title: 'Другой заголовок', text: 'Совсем другой текст объявления.' }),
    );
  });

  it('не трогает внешний id там, где площадка правит объявление на месте', async () => {
    const h = harness();

    await repairRejectedAd(h.rc, rejected());

    // Директ отвечает на Ads.update без нового id — подменять `Ad.externalId` нечем.
    expect(db.adOf('ad1').externalId).toBe('9');
  });

  it('пишет в ChangeLog, чем и по каким правилам заменён текст', async () => {
    await repairRejectedAd(harness().rc, rejected());

    const entry = db.changeLogs.find((row) => row.action === REWRITE_ACTION);
    expect(entry).toBeDefined();
    expect(entry?.entityId).toBe('ad1');
    expect(entry?.actor).toBe('AI');
    expect(entry?.reason).toBe(REWRITE.changes);
    expect(entry?.newValue).toMatchObject({
      category: 'superlative',
      ruleIds: expect.arrayContaining(['superlative-unproven']),
      retries: 1,
    });
    expect(entry?.prevValue).toMatchObject({ title: ORIGINAL.title });
  });

  it('не тратит вызовы модели на объявление, которое не крутится', async () => {
    const h = harness();

    const outcome = await repairRejectedAd(h.rc, rejected({ status: AdStatus.PAUSED }));

    expect(outcome).toEqual({ status: 'skipped', reason: 'ad is not running' });
    expect(h.classifyCalls).toHaveLength(0);
    expect(h.rewriteCalls).toHaveLength(0);
    expect((h.rc.adapter as ReturnType<typeof fakeAdapter>).updates).toEqual([]);
  });

  it('не отправляет текст объявлению, выключенному между опросом и отправкой', async () => {
    const h = harness();
    // Между `pollAdModeration` и отправкой прошёл синк сущностей: объявление выключено
    // (например, проигравший вариант A/B). Захват обязан этого не пропустить.
    db.adOf('ad1').status = AdStatus.PAUSED;

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toMatchObject({ status: 'skipped' });
    expect((h.rc.adapter as ReturnType<typeof fakeAdapter>).updates).toEqual([]);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REJECTED);
  });

  it('наложившийся прогон не отправляет второй текст', async () => {
    const h = harness();
    // Первый прогон уже захватил объявление: статус REWRITING, счётчик сдвинут.
    db.adOf('ad1').moderationStatus = ModerationStatus.REWRITING;
    db.adOf('ad1').moderationRetries = 1;

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'claimed by another run or no longer active',
    });
    expect((h.rc.adapter as ReturnType<typeof fakeAdapter>).updates).toEqual([]);
  });

  it('возвращает статус REJECTED, если отправка упала', async () => {
    const boom = new Error('VK 500');
    const h = harness({
      adapter: fakeAdapter({
        channel: Provider.YANDEX_DIRECT,
        updateAdText: () => {
          throw boom;
        },
      }),
    });

    await expect(repairRejectedAd(h.rc, rejected())).rejects.toThrow('VK 500');

    const ad = db.adOf('ad1');
    expect(ad.moderationStatus).toBe(ModerationStatus.REJECTED);
    // Счётчик остаётся сдвинутым: у VK замена могла уже создаться.
    expect(ad.moderationRetries).toBe(1);
    expect(ad.title).toBe(ORIGINAL.title);
  });
});

describe('repairRejectedAd: эскалация', () => {
  it('после трёх отказов зовёт человека и не тратит вызовы модели', async () => {
    const h = harness();

    const outcome = await repairRejectedAd(h.rc, rejected({ retries: 3 }));

    expect(outcome).toEqual({ status: 'escalated', cause: 'retries_exhausted' });
    expect(h.classifyCalls).toHaveLength(0);
    expect(h.rewriteCalls).toHaveLength(0);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ adId: 'ad1', chatId: '555', retries: 3 });
    expect(db.changeLogs.some((row) => row.action === ESCALATION_ACTION)).toBe(true);
    // Объявление не тронуто: решение за человеком.
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REJECTED);
  });

  it('не шлёт второе письмо по той же попытке', async () => {
    const h = harness();
    await repairRejectedAd(h.rc, rejected({ retries: 3 }));
    const outcome = await repairRejectedAd(h.rc, rejected({ retries: 3 }));

    expect(outcome).toEqual({ status: 'skipped', reason: 'already escalated' });
    expect(escalations).toHaveLength(1);
  });

  it('эскалирует, когда модель так и не собрала проходящий вариант', async () => {
    const tooLong: AdRewriteDraft = {
      ...REWRITE,
      text: 'Мастер приедет с деталями в день обращения, проведёт диагностику, оформит договор и даст чек на работы.',
    };
    const h = harness({ rewrites: [tooLong] });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toEqual({ status: 'escalated', cause: 'rewrite_failed' });
    expect(escalations[0]?.problems.join(' ')).toContain('поле text');
    // Забракованный черновик в кабинет не ушёл.
    expect((h.rc.adapter as ReturnType<typeof fakeAdapter>).updates).toEqual([]);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REJECTED);
  });

  it('второй прогон по тому же объявлению не стоит ни одного вызова модели', async () => {
    const tooLong: AdRewriteDraft = {
      ...REWRITE,
      text: 'Мастер приедет с деталями в день обращения, проведёт диагностику, оформит договор и даст чек на работы.',
    };
    const h = harness({ rewrites: [tooLong] });

    // Крон ходит каждые полчаса; между прогонами объявление читается из БД заново,
    // поэтому счётчик попыток берётся оттуда — ровно как это делает pollAdModeration.
    const outcomes = [];
    for (let tick = 0; tick < 3; tick += 1) {
      outcomes.push(
        await repairRejectedAd(h.rc, rejected({ retries: db.adOf('ad1').moderationRetries })),
      );
    }

    expect(outcomes).toEqual([
      { status: 'escalated', cause: 'rewrite_failed' },
      { status: 'skipped', reason: 'already escalated' },
      { status: 'skipped', reason: 'already escalated' },
    ]);
    // Платит только первый прогон: классификация и три переписывания.
    expect(h.classifyCalls).toHaveLength(1);
    expect(h.rewriteCalls).toHaveLength(3);
    // Человек получает одно письмо, а не по письму каждые полчаса.
    expect(escalations).toHaveLength(1);
    // Объявление запарковано на потолке — именно это и делает следующие прогоны бесплатными.
    expect(db.adOf('ad1').moderationRetries).toBe(3);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REJECTED);
  });

  it('зовёт человека, когда отправка в кабинет упала на полпути', async () => {
    const h = harness({
      adapter: fakeAdapter({
        channel: Provider.YANDEX_DIRECT,
        updateAdText: () => {
          throw new Error('VK 500');
        },
      }),
    });

    await expect(repairRejectedAd(h.rc, rejected())).rejects.toThrow('VK 500');

    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ adId: 'ad1', cause: 'apply_failed' });
    expect(escalations[0]?.problems.join(' ')).toContain('VK 500');
    // Попытка потрачена, но остаток попыток сохранён: отказ мог быть сетевым.
    expect(db.adOf('ad1').moderationRetries).toBe(1);
  });

  it('эскалирует канал, который не умеет обновлять текст, до вызова модели', async () => {
    const h = harness({
      adapter: fakeAdapter({ channel: Provider.TIKTOK_ADS }),
      channel: Provider.TIKTOK_ADS,
    });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toEqual({ status: 'escalated', cause: 'channel_unsupported' });
    expect(h.classifyCalls).toHaveLength(0);
  });
});

/** Стенд VK: подменяется только транспорт, адаптер настоящий. */
function vkHarness(over: { deleteFails?: boolean } = {}): {
  adapter: VkAdsAdapter;
  calls: { method: string; url: string }[];
} {
  const calls: { method: string; url: string }[] = [];
  const transport: VkTransport = async (config) => {
    const method = config.method ?? 'GET';
    const url = config.url ?? '';
    calls.push({ method, url });
    if (method === 'GET') {
      return {
        status: 200,
        data: {
          count: 1,
          items: [
            {
              id: 9,
              ad_group_id: 4,
              // Показы и модерация — разные поля: отклонённый баннер продолжает
              // числиться работающим, пока его не выключили руками.
              status: 'active',
              moderation_status: 'rejected',
              textblocks: { title_25: { text: 'Лучший ремонт' } },
              url: 'https://example.ru',
            },
          ],
        },
        headers: {},
      };
    }
    if (method === 'DELETE' && over.deleteFails) {
      return { status: 500, data: { error: { message: 'banner is locked' } }, headers: {} };
    }
    // mass_action — это гашение осиротевшего баннера внутри адаптера, не создание.
    const data = url.includes('mass_action') ? [{ id: 9 }] : { id: 10, ad_group_id: 4 };
    return { status: 200, data, headers: {} };
  };
  const adapter = new VkAdsAdapter({
    http: {
      transport,
      getAccessToken: async () => 'token',
      attempts: 1,
      governor: new RateLimitGovernor(
        () => Date.now(),
        async () => undefined,
      ),
    },
  });
  return { adapter, calls };
}

/**
 * Ответ модели, годный для VK: заголовок в 25 символов и без второго заголовка,
 * которого у площадки нет.
 */
const VK_REWRITE: AdRewriteDraft = {
  title: 'Ремонт стиральных машин',
  text: 'Мастер приедет с деталями. Диагностика перед ремонтом, договор и чек.',
  changes: 'Убрал превосходную степень.',
};

describe('repairRejectedAd в VK', () => {
  it('идёт настоящим путём адаптера: создать замену, удалить отклонённый баннер', async () => {
    const vk = vkHarness();
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toMatchObject({ status: 'rewritten' });
    expect(vk.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${VK_PATHS.banners}.json`,
      `POST ${VK_PATHS.banners}.json`,
      `DELETE ${VK_PATHS.banners}/9.json`,
    ]);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.PENDING);
  });

  it('переводит Ad.externalId на созданный баннер', async () => {
    const vk = vkHarness();
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    await repairRejectedAd(h.rc, rejected());

    // Старый баннер удалён: строка со старым id не сопоставилась бы ни со статистикой
    // (`ingestion/stats.ts` индексирует по externalId), ни с опросом модерации.
    expect(db.adOf('ad1').externalId).toBe('10');
    // Тот же ответ, что раньше собирала загрузка перебором журнала: под старым id
    // в кабинете может остаться баннер, и заводить под него работающую строку нельзя.
    expect(db.adOf('ad1').supersededExternalIds).toEqual(['9']);
    expect(db.changeLogs.find((row) => row.action === REWRITE_ACTION)?.newValue).toMatchObject({
      externalIdBefore: '9',
      externalIdAfter: '10',
    });
  });

  it('дописывает заменённый баннер к прежним, а не затирает их', async () => {
    // Строку переписывают до трёх раз подряд, и каждая неудавшаяся уборка оставляет в
    // кабинете ещё один погашенный баннер. Одно значение на строку помнило бы только
    // последний, а предыдущему первый же синк вернул бы «работает».
    db.adOf('ad1').supersededExternalIds = ['7'];
    const vk = vkHarness();
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    await repairRejectedAd(h.rc, rejected());

    expect(db.adOf('ad1').supersededExternalIds).toEqual(['7', '9']);
  });

  it('при частичном отказе сохраняет id уже созданного баннера', async () => {
    const vk = vkHarness({ deleteFails: true });
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    await expect(repairRejectedAd(h.rc, rejected())).rejects.toThrow(/replaced by 10/);

    const ad = db.adOf('ad1');
    // Замена уже показывается и тратит бюджет — потеряв её id, мы потеряли бы
    // единственное живое объявление группы.
    expect(ad.externalId).toBe('10');
    // Ровно тот случай, ради которого связь и хранится: баннер 9 остался в кабинете
    // погашенным, и загрузка узнаёт его по этому списку, а не перебором журнала.
    expect(ad.supersededExternalIds).toEqual(['9']);
    expect(ad.moderationStatus).toBe(ModerationStatus.REJECTED);
    expect(ad.moderationRetries).toBe(1);
    // Человеку нужен id того баннера, который сейчас крутится, а не удаляемого.
    expect(escalations[0]).toMatchObject({ cause: 'apply_failed', adExternalId: '10' });
    expect(escalations[0]?.problems.join(' ')).toContain('10');
  });

  it('переводит строку на живой баннер и снимает захват одной записью', async () => {
    const vk = vkHarness({ deleteFails: true });
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    await expect(repairRejectedAd(h.rc, rejected())).rejects.toThrow(/replaced by 10/);

    // Между «захватил» и «отпустил» промежуточных состояний быть не должно: падение
    // после первой из двух записей оставляло бы строку с мёртвым id и потраченной
    // попыткой, а поднять её нечем — старого баннера в листинге уже нет.
    const released = db.adWrites.filter(
      (write) => write.data.moderationStatus === ModerationStatus.REJECTED,
    );
    expect(released).toHaveLength(1);
    expect(released[0]?.data).toMatchObject({
      externalId: '10',
      moderationStatus: ModerationStatus.REJECTED,
    });
  });

  it('после спасённого id строка описывает новый баннер, а не прошлый вариант', async () => {
    const vk = vkHarness({ deleteFails: true });
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    await expect(repairRejectedAd(h.rc, rejected())).rejects.toThrow(/replaced by 10/);

    // В баннере 10 лежит переписанный текст. Оставить строке отпечаток старого
    // варианта — значит подшить его показы к чужой строке A/B-отчёта.
    const ad = db.adOf('ad1');
    expect(ad.title).toBe(VK_REWRITE.title);
    expect(ad.llmVariant).toBe(textVariantId({ title: VK_REWRITE.title, text: VK_REWRITE.text }));
    // На эту запись опирается исключение переписанных объявлений из A/B
    // (`TEXT_REWRITE_ACTIONS` в `creatives/ab/experiment.ts`).
    const entry = db.changeLogs.find((row) => row.action === REWRITE_ACTION);
    expect(entry?.newValue).toMatchObject({ externalIdBefore: '9', externalIdAfter: '10' });
  });

  it('зовёт человека, когда новый id уже занят другой строкой', async () => {
    db.seedAd({ id: 'ad2', adGroupId: 'g1', externalId: '10' });
    const vk = vkHarness();
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, rewrites: [VK_REWRITE] });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toEqual({ status: 'escalated', cause: 'external_id_taken' });
    const ad = db.adOf('ad1');
    // Слить две строки автоматика не вправе, поэтому id остаётся старым, но тексты
    // и статус сохраняются: иначе объявление зависло бы в REWRITING.
    expect(ad.externalId).toBe('9');
    // Переезда не было — строка осталась на своём баннере, и записывать нечего:
    // пометка означает «этот id больше не наш», а он всё ещё наш.
    expect(ad.supersededExternalIds).toEqual([]);
    expect(ad.title).toBe(VK_REWRITE.title);
    expect(ad.moderationStatus).toBe(ModerationStatus.PENDING);
    // Баннер 9 удалён при замене. Оставить строку работающей значит вечно предлагать
    // паузу несуществующему объявлению и держать его в A/B.
    expect(ad.status).toBe(AdStatus.ARCHIVED);
    // Одиночное расхождение не набирает порога `error_burst` в `reporter/alerts.ts`,
    // поэтому строки в ErrorLog мало — человеку нужно письмо.
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ adId: 'ad1', cause: 'external_id_taken' });
    expect(escalations[0]?.problems.join(' ')).toContain('10');
    expect(db.errorLogs).toHaveLength(1);
    expect(db.errorLogs[0]?.scope).toBe('moderation:external-id:ad1');
    expect(db.errorLogs[0]?.message).toContain('10');
  });

  it('при dryRun не отправляет ни одной записи и ничего не пишет в БД', async () => {
    const vk = vkHarness();
    const h = harness({
      adapter: vk.adapter,
      channel: Provider.VK_ADS,
      ctx: channelContext(true),
      rewrites: [VK_REWRITE],
    });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toMatchObject({ status: 'planned' });
    // Единственный запрос — чтение баннера, чтобы собрать план замены.
    expect(vk.calls.map((call) => call.method)).toEqual(['GET']);

    const ad = db.adOf('ad1');
    expect(ad.moderationStatus).toBe(ModerationStatus.REJECTED);
    expect(ad.moderationRetries).toBe(0);
    expect(ad.title).toBe(ORIGINAL.title);
    expect(db.changeLogs).toEqual([]);
  });
});

describe('repairRejectedAd: dry-run не платит за один и тот же ответ дважды', () => {
  const DRY = () => channelContext(true);

  it('второй прогон по тому же объявлению модель не зовёт', async () => {
    // Крон модерации ходит каждые полчаса, а dry-run намеренно ничего не пишет в
    // БД — значит, следующий прогон видит ровно ту же отклонённую строку. Раньше
    // это означало две оплаченные модели на объявление 48 раз в сутки за один и
    // тот же ответ.
    const first = harness({ ctx: DRY() });
    const before = await repairRejectedAd(first.rc, rejected());
    expect(before).toMatchObject({ status: 'planned' });
    expect(first.classifyCalls).toHaveLength(1);
    expect(first.rewriteCalls).toHaveLength(1);

    const second = harness({ ctx: DRY() });
    const after = await repairRejectedAd(second.rc, rejected());

    expect(after).toMatchObject({ status: 'unchanged' });
    expect(second.classifyCalls).toEqual([]);
    expect(second.rewriteCalls).toEqual([]);
  });

  it('изменившийся текст объявления снова стоит вызова модели', async () => {
    const first = harness({ ctx: DRY() });
    await repairRejectedAd(first.rc, rejected());

    const second = harness({ ctx: DRY() });
    const outcome = await repairRejectedAd(
      second.rc,
      rejected({ ad: { title: 'Ремонт стиральных машин', text: 'Другой текст объявления.' } }),
    );

    expect(outcome).toMatchObject({ status: 'planned' });
    expect(second.rewriteCalls).toHaveLength(1);
  });

  it('новая причина отказа снова стоит вызова модели', async () => {
    const first = harness({ ctx: DRY() });
    await repairRejectedAd(first.rc, rejected());

    const second = harness({ ctx: DRY() });
    const outcome = await repairRejectedAd(
      second.rc,
      rejected({ reason: 'Нет ссылки на документ о рекламируемом товаре' }),
    );

    expect(outcome).toMatchObject({ status: 'planned' });
    expect(second.rewriteCalls).toHaveLength(1);
  });

  it('упавшая модель не оставляет отметку занятой', async () => {
    // Отметка живёт 30 дней и означает «ответ по этому входу уже получен и показан».
    // Разовый отказ провайдера её не подтверждает: оставь ключ занятым — и объявление
    // выпадает из починки до истечения срока, причём молча, потому что ненулевой
    // `unchanged` в сводке при DRY_RUN — норма (см. `ModerationRunSummary`).
    const failing = harness({ ctx: DRY(), rewrites: [new Error('LLM 503')] });

    await expect(repairRejectedAd(failing.rc, rejected())).rejects.toThrow('LLM 503');

    expect(db.idempotencyKeys).toEqual([]);

    const next = harness({ ctx: DRY() });
    const outcome = await repairRejectedAd(next.rc, rejected());
    expect(outcome).toMatchObject({ status: 'planned' });
    expect(next.rewriteCalls).toHaveLength(1);
  });

  it('отметка остаётся занятой, когда модель ответила, а вариант не прошёл проверки', async () => {
    // Здесь ответ получен и оплачен, а человеку уже ушло письмо: платить за тот же
    // ответ каждые полчаса не за что. Отпускается ключ только на отказе, а не на
    // любом исходе, отличном от плана.
    const h = harness({
      ctx: DRY(),
      rewrites: [{ ...REWRITE, title: 'Лучший ремонт стиральных машин' }],
    });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toMatchObject({ status: 'escalated' });
    expect(db.idempotencyKeys).toHaveLength(1);
  });

  it('упавший кабинет тоже не съедает отметку: предпросмотр так и не показан', async () => {
    const h = harness({
      ctx: DRY(),
      adapter: fakeAdapter({
        channel: Provider.YANDEX_DIRECT,
        updateAdText: () => {
          throw new Error('Директ недоступен');
        },
      }),
    });

    await expect(repairRejectedAd(h.rc, rejected())).rejects.toThrow('Директ недоступен');

    expect(db.idempotencyKeys).toEqual([]);
  });

  it('вне dry-run ключ не резервируется: там от повтора держит захват строки', async () => {
    const h = harness({ ctx: channelContext(false) });

    await repairRejectedAd(h.rc, rejected());

    expect(db.idempotencyKeys).toEqual([]);
  });
});
