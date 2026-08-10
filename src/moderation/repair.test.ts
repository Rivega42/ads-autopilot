import { ModerationStatus, Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import type { ChannelContext } from '@/channels/types.js';
import { VkAdsAdapter } from '@/clients/vk-ads/adapter.js';
import { VK_PATHS } from '@/clients/vk-ads/entities.js';
import { RateLimitGovernor, type VkTransport } from '@/clients/vk-ads/http.js';
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
    expect(ad.llmVariant).toBe('superlative:1');
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

  it('наложившийся прогон не отправляет второй текст', async () => {
    const h = harness();
    // Первый прогон уже захватил объявление: статус REWRITING, счётчик сдвинут.
    db.adOf('ad1').moderationStatus = ModerationStatus.REWRITING;
    db.adOf('ad1').moderationRetries = 1;

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toEqual({ status: 'skipped', reason: 'claimed by another run' });
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
function vkHarness(): { adapter: VkAdsAdapter; calls: { method: string; url: string }[] } {
  const calls: { method: string; url: string }[] = [];
  const transport: VkTransport = async (config) => {
    const method = config.method ?? 'GET';
    calls.push({ method, url: config.url ?? '' });
    const data =
      method === 'GET'
        ? {
            count: 1,
            items: [
              {
                id: 9,
                ad_group_id: 4,
                status: 'rejected',
                textblocks: { title_25: { text: 'Лучший ремонт' } },
                url: 'https://example.ru',
              },
            ],
          }
        : { id: 10, ad_group_id: 4 };
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

describe('repairRejectedAd в VK', () => {
  it('идёт настоящим путём адаптера: создать замену, удалить отклонённый баннер', async () => {
    const vk = vkHarness();
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS });

    const outcome = await repairRejectedAd(h.rc, rejected());

    expect(outcome).toMatchObject({ status: 'rewritten' });
    expect(vk.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${VK_PATHS.banners}.json`,
      `POST ${VK_PATHS.banners}.json`,
      `DELETE ${VK_PATHS.banners}/9.json`,
    ]);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.PENDING);
  });

  it('при dryRun не отправляет ни одной записи и ничего не пишет в БД', async () => {
    const vk = vkHarness();
    const h = harness({ adapter: vk.adapter, channel: Provider.VK_ADS, ctx: channelContext(true) });

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
