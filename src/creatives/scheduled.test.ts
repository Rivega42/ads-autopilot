import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApprovalModule from '@/approval/index.js';
import type { ApprovalAction } from '@/approval/types.js';
import type * as EnvModule from '@/env.js';

interface GroupRow {
  id: string;
  name: string;
  campaign: { clientId: string; provider: 'YANDEX_DIRECT' };
}

interface AdRow {
  id: string;
  adGroupId: string;
  externalId: string;
  title: string;
  llmVariant: string | null;
}

interface StatRow {
  entityId: string;
  impressions: number;
  clicks: number;
  date?: Date;
}

interface KeyRow {
  key: string;
  scope: string;
  entityId: string;
  expiresAt: Date;
}

const NOW = new Date('2026-08-16T09:00:00.000Z');

const h = vi.hoisted(() => {
  const state: {
    groups: unknown[];
    ads: unknown[];
    stats: unknown[];
    changes: Array<{ entityId: string; action: string; appliedAt: Date }>;
    keys: Map<string, unknown>;
    statWhere: unknown;
    groupByArgs: unknown;
    envDryRun: boolean;
  } = {
    groups: [],
    ads: [],
    stats: [],
    changes: [],
    keys: new Map<string, unknown>(),
    statWhere: null,
    groupByArgs: null,
    envDryRun: false,
  };

  const duplicate = (): Error =>
    new Prisma.PrismaClientKnownRequestError('duplicate key', {
      code: 'P2002',
      clientVersion: 'test',
    });

  return {
    state,
    createApproval: vi.fn(async (action: ApprovalAction, _opts?: { dryRun?: boolean }) => ({
      id: `ap-${action.kind}`,
    })),
    prisma: {
      adGroup: {
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          (state.groups as GroupRow[]).filter((g) => args.where.id.in.includes(g.id)),
        ),
      },
      ad: {
        groupBy: vi.fn(async (args: { where: { llmVariant?: unknown } }) => {
          state.groupByArgs = args;
          const counted = new Map<string, number>();
          for (const ad of state.ads as AdRow[]) {
            if (args.where.llmVariant && ad.llmVariant === null) continue;
            counted.set(ad.adGroupId, (counted.get(ad.adGroupId) ?? 0) + 1);
          }
          return [...counted]
            .filter(([, count]) => count >= 2)
            .map(([adGroupId, count]) => ({ adGroupId, _count: { _all: count } }));
        }),
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
          const where = args.where as {
            adGroupId?: string;
            id?: { in: string[] };
            externalId?: { in: string[] };
            llmVariant?: unknown;
          };
          const ads = state.ads as AdRow[];
          if (where.adGroupId !== undefined) {
            return ads
              .filter((ad) => ad.adGroupId === where.adGroupId)
              .filter((ad) => !where.llmVariant || ad.llmVariant !== null)
              .map((ad) => ({ id: ad.id, llmVariant: ad.llmVariant, title: ad.title }));
          }
          if (where.externalId !== undefined) {
            const ext = where.externalId.in;
            return ads
              .filter((ad) => ext.includes(ad.externalId))
              .map((ad) => ({ adGroupId: ad.adGroupId }));
          }
          const ids = where.id?.in ?? [];
          return ads
            .filter((ad) => ids.includes(ad.id))
            .map((ad) => ({ id: ad.id, externalId: ad.externalId, title: ad.title }));
        }),
      },
      campaignStat: {
        findMany: vi.fn(async (args: { where: { entityId: { in: string[] } } }) => {
          state.statWhere = args.where;
          const ids = args.where.entityId.in;
          return (state.stats as StatRow[]).filter((row) => ids.includes(row.entityId));
        }),
      },
      changeLog: {
        findMany: vi.fn(async (args: { where: { entityId: { in: string[] } } }) =>
          state.changes.filter((row) => args.where.entityId.in.includes(row.entityId)),
        ),
      },
      idempotencyKey: {
        create: vi.fn(async (args: { data: KeyRow }) => {
          if (state.keys.has(args.data.key)) throw duplicate();
          state.keys.set(args.data.key, args.data);
          return args.data;
        }),
        deleteMany: vi.fn(
          async (args: { where: { key?: string | { in: string[] }; scope?: unknown } }) => {
            const key = args.where.key;
            const wanted =
              typeof key === 'string'
                ? [key]
                : Array.isArray(key?.in)
                  ? key.in
                  : [...state.keys.keys()];
            let count = 0;
            for (const k of wanted) {
              if (state.keys.delete(k)) count += 1;
            }
            return { count };
          },
        ),
      },
    },
  };
});

vi.mock('@/db/prisma.js', () => ({ prisma: h.prisma }));
vi.mock('@/approval/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApprovalModule>();
  return { ...actual, createApproval: h.createApproval };
});
vi.mock('@/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get DRY_RUN(): boolean {
        return h.state.envDryRun;
      },
    },
  };
});

const { runAbEvaluation, abApprovalIdempotencyKey, releaseAbApprovalKeys, AB_WINDOW_DAYS } =
  await import('./scheduled.js');

function group(overrides: Partial<GroupRow> = {}): GroupRow {
  return {
    id: 'ag-1',
    name: 'Ремонт квартир — горячие',
    campaign: { clientId: 'cl-1', provider: 'YANDEX_DIRECT' },
    ...overrides,
  };
}

function ad(id: string, variant: string | null, adGroupId = 'ag-1'): AdRow {
  return {
    id,
    adGroupId,
    externalId: `ext-${id}`,
    title: `Заголовок ${id}`,
    llmVariant: variant,
  };
}

/** Разрыв, на котором `selectWinner` объявляет победителя: CTR 5% против 1%. */
function decisiveStats(): StatRow[] {
  return [
    { entityId: 'ad-1', impressions: 2000, clicks: 100, date: new Date('2026-08-01T00:00:00Z') },
    { entityId: 'ad-2', impressions: 2000, clicks: 20, date: new Date('2026-08-01T00:00:00Z') },
  ];
}

/** Карточка, ушедшая человеку, — в том виде, в каком её увидит крон экспирации. */
function approvalOf(externalIds: string[], dryRun = false): { id: string; payload: unknown } {
  return {
    id: 'ap-1',
    payload: {
      kind: 'pause_entities',
      clientId: 'cl-1',
      channel: 'YANDEX_DIRECT',
      level: 'ad',
      externalIds,
      reason: 'A/B-тест',
      meta: { dryRun },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.groups = [group()];
  h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-b')];
  h.state.stats = decisiveStats();
  h.state.changes = [];
  h.state.keys = new Map<string, unknown>();
  h.state.statWhere = null;
  h.state.groupByArgs = null;
  h.state.envDryRun = false;
});

describe('runAbEvaluation: победитель', () => {
  it('просит человека выключить проигравшие объявления, а не пишет в кабинет сам', async () => {
    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.winners).toBe(1);
    expect(summary.approvals).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action).toMatchObject({
      kind: 'pause_entities',
      level: 'ad',
      clientId: 'cl-1',
      channel: 'YANDEX_DIRECT',
      externalIds: ['ext-ad-2'],
    });
    // Победитель на паузу не уходит — иначе тест выключил бы лучший текст.
    expect(action?.kind === 'pause_entities' && action.externalIds).not.toContain('ext-ad-1');
  });

  it('передаёт dry-run в карточку: обещание карточки должно совпасть с режимом', async () => {
    await runAbEvaluation({ dryRun: true, now: NOW });

    const [, opts] = h.createApproval.mock.calls[0] ?? [];
    expect(opts).toMatchObject({ dryRun: true });
  });

  it('складывает объявления одного варианта в одну карточку', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-b'), ad('ad-3', 'v-b')];
    h.state.stats = [
      ...decisiveStats(),
      { entityId: 'ad-3', impressions: 2000, clicks: 20, date: new Date('2026-08-01T00:00:00Z') },
    ];

    await runAbEvaluation({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action?.kind === 'pause_entities' && action.externalIds).toEqual([
      'ext-ad-2',
      'ext-ad-3',
    ]);
  });
});

describe('runAbEvaluation: кого выключаем', () => {
  it('вариант, не добравший показов, проигравшим не считает', async () => {
    // «ad-3» создан вчера и набрал 30 показов: он ни с кем не сравнивался.
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-b'), ad('ad-3', 'v-c')];
    h.state.stats = [
      ...decisiveStats(),
      { entityId: 'ad-3', impressions: 30, clicks: 2, date: new Date('2026-08-15T00:00:00Z') },
    ];

    await runAbEvaluation({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action?.kind === 'pause_entities' && action.externalIds).toEqual(['ext-ad-2']);
  });

  it('вариант вообще без статистики на паузу не отправляет', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-b'), ad('ad-3', 'v-c')];

    await runAbEvaluation({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    expect(action?.kind === 'pause_entities' && action.externalIds).toEqual(['ext-ad-2']);
  });
});

describe('runAbEvaluation: что видит человек', () => {
  it('в карточке заголовок объявления, а не внутренний id и не хеш текста', async () => {
    h.state.ads = [ad('ad-1', 't-9f3a1b2c3d4e'), ad('ad-2', 't-aaaabbbbcccc')];

    await runAbEvaluation({ dryRun: false, now: NOW });

    const [action] = h.createApproval.mock.calls[0] ?? [];
    const reason = action?.reason ?? '';
    expect(reason).toContain('Ремонт квартир — горячие');
    expect(reason).toContain('Заголовок ad-1');
    expect(reason).toContain('Заголовок ad-2');
    expect(reason).not.toMatch(/t-[0-9a-f]{12}/);
    expect(reason).not.toMatch(/\bad:/);
  });
});

describe('runAbEvaluation: чужие объявления', () => {
  it('группу с рукописными объявлениями экспериментом не считает', async () => {
    h.state.ads = [ad('ad-1', null), ad('ad-2', null), ad('ad-3', null)];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.adGroups).toBe(0);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('в кандидаты берёт только группы с двумя и более нашими вариантами', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });

    expect(h.state.groupByArgs).toMatchObject({
      by: ['adGroupId'],
      where: {
        llmVariant: { not: null },
        adGroup: { status: 'ACTIVE', campaign: { status: 'ACTIVE', client: { status: 'ACTIVE' } } },
      },
      having: { adGroupId: { _count: { gte: 2 } } },
    });
  });

  it('фильтр по клиенту доезжает до запроса', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW, clientId: 'cl-1' });

    expect(h.state.groupByArgs).toMatchObject({
      where: { adGroup: { campaign: { clientId: 'cl-1' } } },
    });
  });

  it('одно наше объявление рядом с чужими экспериментом не делает', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', null), ad('ad-3', null)];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.adGroups).toBe(0);
    expect(h.createApproval).not.toHaveBeenCalled();
  });
});

describe('runAbEvaluation: решения без победителя', () => {
  it('не трогает ничего, пока данные набираются', async () => {
    h.state.stats = [
      { entityId: 'ad-1', impressions: 100, clicks: 5, date: new Date('2026-08-15T00:00:00Z') },
      { entityId: 'ad-2', impressions: 90, clicks: 1, date: new Date('2026-08-15T00:00:00Z') },
    ];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.collecting).toBe(1);
    expect(summary.winners).toBe(0);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('считает неубедительный результат отдельно от набора данных', async () => {
    h.state.stats = [
      { entityId: 'ad-1', impressions: 2000, clicks: 101 },
      { entityId: 'ad-2', impressions: 2000, clicks: 100 },
    ];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.inconclusive).toBe(1);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('три копии одного текста экспериментом не считает', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), ad('ad-2', 'v-a')];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.singleVariant).toBe(1);
    expect(summary.inconclusive).toBe(0);
    expect(h.createApproval).not.toHaveBeenCalled();
  });

  it('победитель без адресуемых проигравших не превращается в пустую карточку', async () => {
    h.state.ads = [ad('ad-1', 'v-a'), { ...ad('ad-2', 'v-b'), externalId: '' }];

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.winners).toBe(1);
    expect(summary.unbuildable).toBe(1);
    expect(h.createApproval).not.toHaveBeenCalled();
  });
});

describe('runAbEvaluation: идемпотентность', () => {
  it('повтор задачи BullMQ не шлёт вторую такую же карточку', async () => {
    const first = await runAbEvaluation({ dryRun: false, now: NOW });
    const second = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(first.approvals).toBe(1);
    expect(second.approvals).toBe(0);
    expect(second.approvalsDuplicate).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);
  });

  it('назавтра карточку не повторяет: решение то же, статистика другая', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });
    // Сутки спустя показов больше, p-value другое — но победитель и проигравшие те же.
    h.state.stats = [
      { entityId: 'ad-1', impressions: 3000, clicks: 150 },
      { entityId: 'ad-2', impressions: 3000, clicks: 30 },
    ];

    const next = await runAbEvaluation({
      dryRun: false,
      now: new Date('2026-08-17T09:00:00.000Z'),
    });

    expect(next.approvalsDuplicate).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(1);
  });

  it('освобождает ключ, если карточка не создалась, чтобы повтор дошёл до человека', async () => {
    h.createApproval.mockRejectedValueOnce(new Error('telegram down'));

    const first = await runAbEvaluation({ dryRun: false, now: NOW });
    const second = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(first.approvalsFailed).toBe(1);
    expect(second.approvals).toBe(1);
  });

  it('ключ зависит от группы, набора проигравших и режима, а не от p-value', () => {
    const key = abApprovalIdempotencyKey('ag-1', ['ext-ad-2'], { dryRun: false });

    expect(key).toBe(abApprovalIdempotencyKey('ag-1', ['ext-ad-2'], { dryRun: false }));
    expect(key).not.toBe(
      abApprovalIdempotencyKey('ag-1', ['ext-ad-2', 'ext-ad-3'], { dryRun: false }),
    );
    expect(key).not.toBe(abApprovalIdempotencyKey('ag-2', ['ext-ad-2'], { dryRun: false }));
    expect(key).not.toBe(abApprovalIdempotencyKey('ag-1', ['ext-ad-2'], { dryRun: true }));
  });

  it('порядок внешних id на ключ не влияет', () => {
    expect(abApprovalIdempotencyKey('ag-1', ['b', 'a'], { dryRun: false })).toBe(
      abApprovalIdempotencyKey('ag-1', ['a', 'b'], { dryRun: false }),
    );
  });
});

describe('runAbEvaluation: dry-run не сжигает боевое решение', () => {
  it('после недели в dry-run первый боевой прогон присылает карточку', async () => {
    h.state.envDryRun = true;
    await runAbEvaluation({ dryRun: true, now: NOW });
    expect(h.createApproval).toHaveBeenCalledTimes(1);

    h.state.envDryRun = false;
    const live = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(live.approvals).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(2);
    const [, opts] = h.createApproval.mock.calls[1] ?? [];
    expect(opts).toMatchObject({ dryRun: false });
  });

  it('общий предохранитель считается режимом карточки даже при dryRun: false', async () => {
    h.state.envDryRun = true;

    await runAbEvaluation({ dryRun: false, now: NOW });
    const again = await runAbEvaluation({ dryRun: false, now: NOW });

    // Карточка ушла как dry-run, значит и ключ занят dry-run — боевой свободен.
    expect(again.approvalsDuplicate).toBe(1);
    h.state.envDryRun = false;
    const live = await runAbEvaluation({ dryRun: false, now: NOW });
    expect(live.approvals).toBe(1);
  });
});

describe('releaseAbApprovalKeys', () => {
  it('истёкшая карточка освобождает ключ, и решение приходит снова', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });
    expect(h.createApproval).toHaveBeenCalledTimes(1);

    const released = await releaseAbApprovalKeys(approvalOf(['ext-ad-2']));
    expect(released).toBe(1);

    const next = await runAbEvaluation({ dryRun: false, now: NOW });
    expect(next.approvals).toBe(1);
    expect(h.createApproval).toHaveBeenCalledTimes(2);
  });

  it('карточку не про A/B игнорирует', async () => {
    const released = await releaseAbApprovalKeys({
      id: 'ap-2',
      payload: {
        kind: 'budget_change',
        clientId: 'cl-1',
        channel: 'YANDEX_DIRECT',
        reason: 'CPA выше целевого',
        campaignExternalId: '777',
        campaignName: 'SEO',
        before: 5000,
        after: 3000,
      },
    });

    expect(released).toBe(0);
    expect(h.prisma.ad.findMany).not.toHaveBeenCalled();
  });

  it('на мусорном payload не падает', async () => {
    expect(await releaseAbApprovalKeys({ id: 'ap-3', payload: { kind: 'что-то своё' } })).toBe(0);
  });
});

describe('runAbEvaluation: окно и устойчивость', () => {
  it('смотрит окно не короче срока сбора данных', async () => {
    await runAbEvaluation({ dryRun: false, now: NOW });

    const where = h.state.statWhere as { date: { gte: Date; lte: Date } };
    const days = (where.date.lte.getTime() - where.date.gte.getTime()) / 86_400_000 + 1;
    expect(days).toBe(AB_WINDOW_DAYS);
    // Границы — календарные даты: колонка CampaignStat.date имеет тип Date.
    expect(where.date.lte.toISOString()).toBe('2026-08-16T00:00:00.000Z');
  });

  it('падение на одной группе не отменяет остальные', async () => {
    h.state.groups = [group({ id: 'ag-broken' }), group()];
    h.state.ads = [
      ad('ad-0a', 'v-a', 'ag-broken'),
      ad('ad-0b', 'v-b', 'ag-broken'),
      ad('ad-1', 'v-a'),
      ad('ad-2', 'v-b'),
    ];
    h.prisma.ad.findMany.mockImplementationOnce(async () => {
      throw new Error('соединение потеряно');
    });

    const summary = await runAbEvaluation({ dryRun: false, now: NOW });

    expect(summary.failed).toBe(1);
    expect(summary.approvals).toBe(1);
  });
});
