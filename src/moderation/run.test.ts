import { AdStatus, ClientStatus, ModerationStatus, Provider } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/prisma.js', () => ({ prisma: {} }));

import type { ChannelContext } from '@/channels/types.js';
import { AuthError } from '@/lib/errors.js';
import { FakeDb } from '@/moderation/__tests__/fake-db.js';
import { fakeAdapter, queueRunner, remoteAd } from '@/moderation/__tests__/fakes.js';
import type { ModerationEscalation } from '@/moderation/escalate.js';
import { MISSING_ACTION } from '@/moderation/repair.js';
import { listModerationTargets, runModerationCheck } from '@/moderation/run.js';
import type { AdRewriteDraft, RejectionClassificationDraft } from '@/moderation/schema.js';

const CHANNELS = (): Provider[] => [Provider.YANDEX_DIRECT];

const CLASSIFICATION: RejectionClassificationDraft = {
  category: 'superlative',
  confidence: 0.9,
  explanation: 'Превосходная степень без подтверждения.',
  fragments: ['Лучший'],
};

const REWRITE: AdRewriteDraft = {
  title: 'Ремонт стиральных машин',
  text: 'Мастер приедет с деталями. Диагностика перед ремонтом, договор и чек.',
  changes: 'Убрал превосходную степень.',
};

let db: FakeDb;
let escalations: ModerationEscalation[];

/** Два кабинета: у первого объявление отклонено, у второго — принято. */
beforeEach(() => {
  db = new FakeDb();
  escalations = [];

  for (const [id, name] of [
    ['cl1', 'Ромашка'],
    ['cl2', 'Василёк'],
  ] as const) {
    db.seedClient({ id, name, tgUserId: id === 'cl1' ? 111n : 222n });
    db.seedCredential({ clientId: id, provider: Provider.YANDEX_DIRECT });
    db.seedCampaign({ id: `c-${id}`, clientId: id, provider: Provider.YANDEX_DIRECT });
    db.seedAdGroup({ id: `g-${id}`, campaignId: `c-${id}`, externalId: `ext-${id}` });
  }

  db.seedClient({ id: 'cl3', name: 'Спящий', tgUserId: 333n, status: ClientStatus.PAUSED });
  db.seedCredential({ clientId: 'cl3', provider: Provider.YANDEX_DIRECT });

  db.seedAd({
    id: 'ad1',
    adGroupId: 'g-cl1',
    externalId: 'a1',
    title: 'Лучший ремонт стиральных машин',
    body: 'Починим сегодня, недорого и с гарантией на работу мастера.',
    moderationStatus: ModerationStatus.PENDING,
  });
  db.seedAd({
    id: 'ad2',
    adGroupId: 'g-cl2',
    externalId: 'a2',
    moderationStatus: ModerationStatus.REJECTED,
    moderationReason: 'Старая причина',
    moderationRetries: 2,
  });
});

const REJECTED_REMOTE = remoteAd({
  externalId: 'a1',
  adGroupExternalId: 'ext-cl1',
  title: 'Лучший ремонт стиральных машин',
  text: 'Починим сегодня, недорого и с гарантией на работу мастера.',
  moderationStatus: 'REJECTED',
  moderationReason: 'Превосходная степень без подтверждения',
});

const APPROVED_REMOTE = remoteAd({
  externalId: 'a2',
  adGroupExternalId: 'ext-cl2',
  moderationStatus: 'ACCEPTED',
  moderationReason: undefined,
});

function options(
  over: {
    contextFor?: (clientId: string, provider: Provider) => Promise<ChannelContext>;
    updateAdText?: ReturnType<typeof fakeAdapter>['updateAdText'];
    maxRepairs?: number;
  } = {},
) {
  const adapter = fakeAdapter({
    channel: Provider.YANDEX_DIRECT,
    ads: [REJECTED_REMOTE, APPROVED_REMOTE],
    updateAdText: () => ({ applied: true, plan: {} }),
  });
  if (over.updateAdText) adapter.updateAdText = over.updateAdText;

  return {
    adapter,
    opts: {
      db: db.asDb(),
      channels: CHANNELS,
      adapterFor: () => adapter,
      contextFor:
        over.contextFor ??
        (async (clientId: string): Promise<ChannelContext> => ({
          clientId,
          credentials: {},
          dryRun: false,
        })),
      runClassify: queueRunner<RejectionClassificationDraft>([CLASSIFICATION]).run,
      runRewrite: queueRunner<AdRewriteDraft>([REWRITE]).run,
      escalate: async (payload: ModerationEscalation): Promise<void> => {
        escalations.push(payload);
      },
      ...(over.maxRepairs === undefined ? {} : { maxRepairs: over.maxRepairs }),
    },
  };
}

describe('listModerationTargets', () => {
  it('берёт только активных клиентов и зарегистрированные каналы', async () => {
    const targets = await listModerationTargets(db.asDb(), { channels: CHANNELS });

    expect(targets).toEqual([
      { clientId: 'cl1', provider: Provider.YANDEX_DIRECT },
      { clientId: 'cl2', provider: Provider.YANDEX_DIRECT },
    ]);
  });

  it('умеет сузиться до одного клиента', async () => {
    const targets = await listModerationTargets(db.asDb(), {
      channels: CHANNELS,
      clientId: 'cl2',
    });
    expect(targets).toEqual([{ clientId: 'cl2', provider: Provider.YANDEX_DIRECT }]);
  });
});

describe('runModerationCheck', () => {
  it('обновляет статусы и чинит отклонённое объявление', async () => {
    const { opts } = options();

    const summary = await runModerationCheck(opts);

    expect(summary).toMatchObject({
      targets: 2,
      ok: 2,
      adsPolled: 2,
      statusUpdated: 2,
      rejected: 1,
      rewritten: 1,
      escalated: 0,
      failures: [],
    });

    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.PENDING);
    expect(db.adOf('ad1').title).toBe(REWRITE.title);
    expect(db.adOf('ad1').moderationRetries).toBe(1);
  });

  it('принятое объявление обнуляет счётчик попыток', async () => {
    await runModerationCheck(options().opts);

    const ad = db.adOf('ad2');
    expect(ad.moderationStatus).toBe(ModerationStatus.APPROVED);
    expect(ad.moderationReason).toBeNull();
    expect(ad.moderationRetries).toBe(0);
  });

  it('сломанный кабинет не мешает остальным', async () => {
    const { opts } = options({
      contextFor: async (clientId, provider): Promise<ChannelContext> => {
        if (clientId === 'cl1') throw new AuthError(provider, 'token expired', { clientId });
        return { clientId, credentials: {}, dryRun: false };
      },
    });

    const summary = await runModerationCheck(opts);

    expect(summary.targets).toBe(2);
    expect(summary.ok).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      clientId: 'cl1',
      stage: 'poll',
      code: 'AUTH_FAILED',
    });
    expect(db.errorLogs[0]?.scope).toBe('moderation:poll');
    // Второй кабинет обработан целиком.
    expect(db.adOf('ad2').moderationStatus).toBe(ModerationStatus.APPROVED);
  });

  it('упавшее объявление не роняет прогон', async () => {
    const { opts } = options({
      updateAdText: async () => {
        throw new Error('Direct 500');
      },
    });

    const summary = await runModerationCheck(opts);

    expect(summary.rewritten).toBe(0);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.stage).toBe('repair:ad1');
    // Второй кабинет всё равно опрошен.
    expect(db.adOf('ad2').moderationStatus).toBe(ModerationStatus.APPROVED);
  });

  it('уважает потолок переписываний за прогон', async () => {
    const { adapter, opts } = options({ maxRepairs: 0 });

    const summary = await runModerationCheck(opts);

    expect(summary.deferred).toBe(1);
    expect(summary.rewritten).toBe(0);
    expect(adapter.updates).toEqual([]);
    // Статусы при этом обновлены: опрос от потолка не зависит.
    expect(summary.statusUpdated).toBe(2);
  });

  it('запаркованные объявления не съедают потолок переписываний', async () => {
    // Объявление, уже отданное человеку: счётчик на потолке, письмо отправлено.
    db.seedAd({
      id: 'ad0',
      adGroupId: 'g-cl1',
      externalId: 'a0',
      moderationStatus: ModerationStatus.REJECTED,
      moderationReason: 'Превосходная степень без подтверждения',
      moderationRetries: 3,
    });
    await db.changeLog.create({
      data: {
        campaignId: 'c-cl1',
        entityType: 'AD',
        entityId: 'ad0',
        action: 'moderation_escalated',
        prevValue: {},
        newValue: { retries: 3, parkedAt: 3, cause: 'rewrite_failed' },
        reason: 'Модерация: rewrite_failed',
        actor: 'AI',
        provider: Provider.YANDEX_DIRECT,
      },
    });

    const zombie = remoteAd({
      externalId: 'a0',
      adGroupExternalId: 'ext-cl1',
      moderationStatus: 'REJECTED',
      moderationReason: 'Превосходная степень без подтверждения',
    });
    const adapter = fakeAdapter({
      channel: Provider.YANDEX_DIRECT,
      // Порядок кабинета стабилен: зомби всегда идёт первым.
      ads: [zombie, REJECTED_REMOTE, APPROVED_REMOTE],
      updateAdText: () => ({ applied: true, plan: {} }),
    });
    const { opts } = options();

    const summary = await runModerationCheck({
      ...opts,
      adapterFor: () => adapter,
      maxRepairs: 1,
    });

    expect(summary.skipped).toBe(1);
    // Потолок в одну починку достался живому отказу, а не запаркованному объявлению.
    expect(summary.rewritten).toBe(1);
    expect(summary.deferred).toBe(0);
    expect(escalations).toEqual([]);
    expect(db.adOf('ad1').title).toBe(REWRITE.title);
  });

  it('в dry-run уже показанный предпросмотр не съедает потолок у соседнего отказа', async () => {
    // Тот же принцип, что и с запаркованным объявлением: `unchanged` — это ноль
    // работы, ни вызова модели, ни обращения в кабинет. Списывать за него бюджет
    // значило бы, что порядок `listAds` стабилен, первый отказ вечно занимает
    // потолок, а второй не дождётся предпросмотра никогда.
    db.seedAd({
      id: 'ad1b',
      adGroupId: 'g-cl1',
      externalId: 'a1b',
      title: 'Самый лучший ремонт холодильников',
      body: 'Починим сегодня, недорого и с гарантией на работу мастера.',
      moderationStatus: ModerationStatus.PENDING,
    });
    const second = remoteAd({
      externalId: 'a1b',
      adGroupExternalId: 'ext-cl1',
      title: 'Самый лучший ремонт холодильников',
      text: 'Починим сегодня, недорого и с гарантией на работу мастера.',
      moderationStatus: 'REJECTED',
      moderationReason: 'Превосходная степень без подтверждения',
    });
    const adapter = fakeAdapter({
      channel: Provider.YANDEX_DIRECT,
      ads: [REJECTED_REMOTE, second, APPROVED_REMOTE],
      updateAdText: () => ({ applied: false, plan: {} }),
    });
    const dry = async (clientId: string): Promise<ChannelContext> => ({
      clientId,
      credentials: {},
      dryRun: true,
    });
    const { opts } = options({ contextFor: dry });
    const run = { ...opts, adapterFor: () => adapter, contextFor: dry, maxRepairs: 1 };

    const first = await runModerationCheck(run);
    expect(first).toMatchObject({ planned: 1, unchanged: 0, deferred: 1 });

    const again = await runModerationCheck(run);
    // Потолок достался второму отказу, а не сгорел на уже показанном предпросмотре.
    expect(again).toMatchObject({ planned: 1, unchanged: 1, deferred: 0 });
  });

  describe('строка без объявления в кабинете', () => {
    /** Процесс умер между отправкой замены и записью нового id: id указывает в пустоту. */
    function seedLostAd(): void {
      db.seedAd({
        id: 'lost',
        adGroupId: 'g-cl1',
        externalId: 'снесён-при-замене',
        title: 'Ремонт стиральных машин',
        body: 'Мастер приедет сегодня.',
        moderationStatus: ModerationStatus.REJECTED,
        moderationReason: 'Превосходная степень без подтверждения',
        moderationRetries: 1,
      });
    }

    it('зовёт человека и убирает строку из решений', async () => {
      seedLostAd();

      const summary = await runModerationCheck(options().opts);

      expect(summary.missing).toBe(1);
      const escalation = escalations.find((e) => e.cause === 'ad_missing');
      expect(escalation).toMatchObject({
        adId: 'lost',
        adExternalId: 'снесён-при-замене',
        clientName: 'Ромашка',
        chatId: '111',
      });
      // Строка указывает на баннер, которого нет: пока она числится работающей, её
      // показы считает A/B, а оптимизатор предлагает по ней паузу.
      expect(db.adOf('lost').status).toBe(AdStatus.ARCHIVED);
      expect(db.changeLogs.some((row) => row.action === MISSING_ACTION)).toBe(true);
    });

    it('второй прогон письмо не повторяет', async () => {
      seedLostAd();
      await runModerationCheck(options().opts);
      escalations.length = 0;

      const summary = await runModerationCheck(options().opts);

      expect(summary.missing).toBe(0);
      expect(escalations).toEqual([]);
    });

    it('недоставленное письмо не помечает строку разобранной', async () => {
      seedLostAd();
      const { opts } = options();

      const summary = await runModerationCheck({
        ...opts,
        escalate: async (): Promise<void> => {
          throw new Error('Telegram 502');
        },
      });

      expect(summary.failures.some((f) => f.stage === 'missing:lost')).toBe(true);
      // Строка не тронута — следующий прогон обязан попробовать ещё раз.
      expect(db.adOf('lost').status).toBe(AdStatus.ACTIVE);
      expect(db.changeLogs.some((row) => row.action === MISSING_ACTION)).toBe(false);
    });
  });

  it('не трогает объявления, которые прямо сейчас переписывает другой прогон', async () => {
    db.adOf('ad1').moderationStatus = ModerationStatus.REWRITING;
    const { adapter, opts } = options();

    const summary = await runModerationCheck(opts);

    expect(summary.rejected).toBe(0);
    expect(adapter.updates).toEqual([]);
    expect(db.adOf('ad1').moderationStatus).toBe(ModerationStatus.REWRITING);
  });
});
